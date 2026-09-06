import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { Address, OutScript, Transaction } from '@scure/btc-signer'
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js'
import { vaultAddressNetwork } from '../addressNetwork'
import { prepareConnectorPayment } from './connectorPayment'
import { defaultSpendingPolicy } from '../spendingPolicy'
import { buildConnectorFamily, buildConnectorProgram, connectorEnrollmentDigest } from './connector'
import vectors from './connector-vectors.json'

describe('connector contract matches runtime', () => {
  for (const v of vectors) {
    it(`${v.network} ${v.tier} ${v.originType}`, () => {
      if (v.network !== 'mainnet' && v.network !== 'mutinynet') throw new Error('vector network')
      if (v.tier !== 'standard' && v.tier !== 'advanced') throw new Error('vector tier')
      if (v.connectorType !== 'p2tr' && v.connectorType !== 'p2wpkh') throw new Error('connector type')
      const spendingPolicy = defaultSpendingPolicy(v.network)
      const input: Parameters<typeof connectorEnrollmentDigest>[0] = {
        connectorType: v.connectorType,
        vaultId: 'connector-family-fixture',
        network: v.network,
        phonePub: v.phone,
        hardwarePub: v.hardware,
        recoveryPub: v.tier === 'advanced' ? v.recovery : undefined,
        phoneDirectP256: v.phoneDirect,
        vaultCosignerBase: v.guardian,
        arkadeCosignerBase: v.emulator,
        absoluteFeeCapSats: spendingPolicy.absoluteFeeCapSats,
        feerateCapSatPerV: spendingPolicy.feerateCapSatPerV,
        protectionTier: v.tier,
        spendingPolicy,
      }
      const f = buildConnectorFamily(input)
      expect(hex.encode(f.program)).toBe(v.program)
      expect(hex.encode(f.savings.script)).toBe(v.script)
      expect(f.savings.address).toBe(v.address)
      expect(hex.encode(f.savings.normal)).toBe(v.leaf)
      expect(hex.encode(f.savings.control)).toBe(v.control)
      expect(hex.encode(f.connector.script)).toBe(v.reserve)
      expect(f.rules.witnessBytes).toBe(v.witnessBytes)
      for (const [role, script] of Object.entries(v.pending)) {
        expect(hex.encode(f.pending[role as keyof typeof f.pending].script)).toBe(script)
        expect(hex.encode(f.quarantine[role as keyof typeof f.quarantine].script)).toBe(
          v.quarantine[role as keyof typeof v.quarantine],
        )
      }
      const origin = {
        publicKey: hex.decode(v.hardware),
        fingerprint: v.originFingerprint,
        path: v.originPath,
      }
      for (const p of v.payments) {
        const recipient = Address(vaultAddressNetwork(v.network)).encode(
          OutScript.decode(hex.decode(p.recipientScript)),
        )
        const request = {
          contract: input,
          origin,
          enrollmentDigest: v.enrollmentDigest,
          savings: { txid: p.parentTxid, vout: 0, parentHex: p.parent },
          reserve: { txid: p.parentTxid, vout: 1, parentHex: p.parent },
          recipient,
          amountSats: p.amount,
          feeSats: p.fee,
        }
        const prepared = prepareConnectorPayment(request)
        const built = Transaction.fromPSBT(hex.decode(prepared.psbt()), {
          allowUnknownInputs: true,
          allowUnknownOutputs: true,
        })
        expect(hex.encode(built.unsignedTx)).toBe(p.unsigned)
        expect(
          built.getInput(1).tapBip32Derivation?.[0][1].der.fingerprint ??
            built.getInput(1).bip32Derivation?.[0][1].fingerprint,
        ).toBe(v.originFingerprint)
        const hardware = prepared.forHardware(p.savingsWitness.map((item) => hex.decode(item)))
        // The real emulator requires the proprietary parent field for BOTH
        // inputs. Transaction/signature parity alone does not detect its loss.
        for (const serialized of [prepared.psbt(), hardware.psbt()]) {
          const packet = RawPSBTV0.decode(hex.decode(serialized))
          for (const input of packet.inputs) {
            const parents = input.unknown?.filter(
              ([key]) => key.type === 222 && hex.encode(key.key) === '707265766f75747478',
            )
            expect(parents).toHaveLength(1)
            expect(hex.encode(parents![0][1])).toBe(p.parent)
          }
        }
        expect(hardware.accept(p.responsePSBT)).toEqual({ txHex: p.finalTx, txid: p.txid })
        expect(hardware.accept(p.finalTx)).toEqual({ txHex: p.finalTx, txid: p.txid })
        expect(hardware.accept(p.finalTx.match(/.{1,80}/g)!.join('\n'))).toEqual({ txHex: p.finalTx, txid: p.txid })
        const changed = Transaction.fromPSBT(hex.decode(p.responsePSBT), {
          allowUnknownInputs: true,
          allowUnknownOutputs: true,
          allowLegacyWitnessUtxo: true,
        })
        // Mutation is performed on raw unsigned PSBT bytes because the signer
        // library itself refuses editing a transaction carrying signatures.
        const raw = hex.decode(p.responsePSBT)
        const needle = hex.decode(p.recipientScript)
        const at = raw.findIndex((_, i) => needle.every((b, j) => raw[i + j] === b))
        expect(at).toBeGreaterThan(0)
        raw[at + 3] ^= 1
        expect(() => hardware.accept(hex.encode(raw))).toThrow()
        expect(changed.outputsLength).toBe(p.full ? 4 : 5)
        expect(
          changed.getInput(1).tapBip32Derivation?.[0][1].der.fingerprint ??
            changed.getInput(1).bip32Derivation?.[0][1].fingerprint,
        ).toBe(v.originFingerprint)
        const corrupted = hex.decode(p.responsePSBT)
        const signature = changed.getInput(1).tapKeySig ?? changed.getInput(1).partialSig![0][1]
        const offset = corrupted.findIndex((_, i) => signature.every((b, j) => corrupted[i + j] === b))
        expect(offset).toBeGreaterThan(0)
        corrupted[offset] ^= 1
        expect(() => hardware.accept(hex.encode(corrupted))).toThrow()
        expect(() => prepareConnectorPayment({ ...request, enrollmentDigest: '00'.repeat(32) })).toThrow()
        expect(() => prepared.forHardware(p.savingsWitness.slice(1).map((item) => hex.decode(item)))).toThrow()
      }
      expect(connectorEnrollmentDigest(input, origin)).toBe(v.enrollmentDigest)
      if (origin.path.length === 5) {
        expect(() =>
          connectorEnrollmentDigest(input, {
            ...origin,
            path: [origin.path[0], origin.path[1] ^ 1, ...origin.path.slice(2)],
          }),
        ).toThrow()
      } else {
        expect(connectorEnrollmentDigest(input, { ...origin, path: [origin.path[0], 1, 0] })).not.toBe(
          v.enrollmentDigest,
        )
      }
      expect(() => connectorEnrollmentDigest(input, { ...origin, path: [] })).toThrow()
      expect(connectorEnrollmentDigest(input, { ...origin, fingerprint: 123 })).not.toBe(v.enrollmentDigest)
      expect(() => buildConnectorFamily({ ...input, templateVersion: 'phone-hww-recovery-savings-v1' })).toThrow()
      expect(() => buildConnectorProgram({ ...f.rules, feerateCapSatPerV: NaN })).toThrow()
    })
  }
})
