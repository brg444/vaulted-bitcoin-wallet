import type { VaultLockManager } from '../vtxo/lock'
import {
  preparePendingConnectorOperation,
  storeConnectorSavingsWitness,
  storeConnectorHardwareApproval,
  storeConnectorSignedTx,
  loadPendingConnectorOperation,
  exportConnectorRecoveryJournal,
  restoreConnectorRecoveryJournal,
  reservedConnectorOutpoints,
} from './connectorStore'
import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { Address, OutScript, Transaction } from '@scure/btc-signer'
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { vaultAddressNetwork } from '../addressNetwork'
import { defaultSpendingPolicy } from '../spendingPolicy'
import { buildConnectorFamily, connectorEnrollmentDigest, DUAL_CONNECTOR_TEMPLATE } from './connector'
import { prepareConnectorPayment } from './connectorPayment'
import { tweakPrivateKey } from './tweak'
import vectors from './connector-vectors.json'
import dualVectors from './connector-dual-vectors.json'

const options = { allowUnknownInputs: true, allowUnknownOutputs: true }
const scalar = (value: number) => {
  const key = new Uint8Array(32)
  key[31] = value
  return key
}
const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x42))

describe('dual connector approval', () => {
  for (const kind of ['p2tr', 'p2wpkh'] as const) {
    for (const tier of ['standard', 'advanced'] as const) {
      for (const partial of [false, true]) {
        it(`${kind} ${tier} ${partial ? 'partial' : 'full'} preserves both hardware commitments`, async () => {
          const v = vectors[0],
            policy = defaultSpendingPolicy('mainnet')
          const purpose = kind === 'p2tr' ? 86 : 84
          const key = root.derive(`m/${purpose}'/0'/0'/0/0`)
          const origin = {
            publicKey: key.publicKey!,
            fingerprint: root.fingerprint,
            path: [0x80000000 + purpose, 0x80000000, 0x80000000, 0, 0],
          }
          const contract = {
            connectorType: kind,
            templateVersion: DUAL_CONNECTOR_TEMPLATE,
            vaultId: 'dual-connector-fixture',
            network: 'mainnet',
            phonePub: v.phone,
            hardwarePub: hex.encode(key.publicKey!),
            recoveryPub: tier === 'advanced' ? v.recovery : undefined,
            phoneDirectP256: v.phoneDirect,
            vaultCosignerBase: v.guardian,
            arkadeCosignerBase: v.emulator,
            protectionTier: tier,
            spendingPolicy: policy,
            absoluteFeeCapSats: policy.absoluteFeeCapSats,
            feerateCapSatPerV: policy.feerateCapSatPerV,
          }
          const family = buildConnectorFamily(contract)
          const parent = new Transaction(options)
          parent.addInput({ txid: '00'.repeat(32), index: 99 })
          parent.addOutput({ script: family.savings.script, amount: 100000n })
          for (let i = 0; i < 2; i++) parent.addOutput({ script: family.connector.script, amount: 500n })
          const coin = (vout: number) => ({ parentHex: hex.encode(parent.toBytes(true, true)), txid: parent.id, vout })
          const request = {
            contract,
            origin,
            enrollmentDigest: connectorEnrollmentDigest(contract, origin),
            savings: coin(0),
            reserve: coin(1),
            secondReserve: coin(2),
            recipient: Address(vaultAddressNetwork('mainnet')).encode(
              OutScript.decode(hex.decode(v.payments[0].recipientScript)),
            ),
            amountSats: partial ? 8000 : 98760,
            feeSats: 1000,
          }
          const initial = prepareConnectorPayment(request)
          expect(() => initial.signPhone(scalar(3))).toThrow('hardware approval required')
          const approval = Transaction.fromPSBT(hex.decode(initial.hardwareApproval()), options)
          for (const i of [0, 1]) approval.signIdx(key.privateKey!, i, [3])
          const response = hex.encode(approval.toPSBT())
          const hardwareSignatures = initial.acceptHardwareApproval(response)
          const payment = prepareConnectorPayment({ ...request, hardwareSignatures })
          const tx = Transaction.fromPSBT(hex.decode(payment.psbt()), options)
          const scripts = [family.connector.script, family.connector.script, family.savings.script],
            values = [500n, 500n, 100000n]
          const message = tx.preimageWitnessV1(2, scripts, 0, values, -1, family.savings.normal)
          const witness = [
            schnorr.sign(message, tweakPrivateKey(scalar(15), family.program)),
            schnorr.sign(message, tweakPrivateKey(scalar(14), family.program)),
            schnorr.sign(message, scalar(3)),
            family.savings.normal,
            family.savings.control,
          ]
          const phoneStage = payment.signPhone(scalar(3))
          expect(payment.verifyPhoneStage(phoneStage)).toBe(phoneStage)
          const handoff = payment.forHardware(witness)
          expect(approval.outputsLength).toBe(tx.outputsLength - 1)
          expect(approval.getInput(2).finalScriptWitness).toBeUndefined()
          for (let i = 0; i < approval.outputsLength; i++) expect(approval.getOutput(i)).toEqual(tx.getOutput(i))
          const accepted = handoff.accept(response)
          const final = Transaction.fromRaw(hex.decode(accepted.txHex), options)
          expect(hex.encode(final.unsignedTx)).toBe(hex.encode(tx.unsignedTx))
          expect(final.getInput(2).finalScriptWitness).toEqual(witness)
          expect(handoff.accept(accepted.txHex)).toEqual(accepted)
          if (kind === 'p2tr' && tier === 'advanced' && partial) {
            const locks: VaultLockManager = { request: async (name, _options, callback) => callback({ name }) }
            const identity = { vaultId: contract.vaultId, enrollmentDigest: request.enrollmentDigest }
            localStorage.clear()
            sessionStorage.clear()
            const pendingInitial = await preparePendingConnectorOperation(
              { ...request, origin: { ...origin, publicKey: hex.encode(origin.publicKey) } },
              identity,
              localStorage,
              locks,
            )
            const approved = await storeConnectorHardwareApproval(
              identity,
              pendingInitial.candidateTxid,
              response,
              localStorage,
              locks,
            )
            expect(approved.candidateTxid).toBe(tx.id)
            expect(approved.candidateTxid).not.toBe(pendingInitial.candidateTxid)
            await storeConnectorSavingsWitness(
              identity,
              tx.id,
              witness.map((item) => hex.encode(item)),
              localStorage,
              locks,
            )
            await storeConnectorSignedTx(identity, tx.id, accepted.txHex, localStorage, locks)
            const journal = await exportConnectorRecoveryJournal(identity, localStorage, locks)
            await restoreConnectorRecoveryJournal(identity, journal, sessionStorage, locks)
            const restored = await loadPendingConnectorOperation(identity, sessionStorage, locks)
            expect(restored!.record.signedTxHex).toBe(accepted.txHex)
            expect(restored!.record.secondReserve).toEqual(request.secondReserve)
            expect((await reservedConnectorOutpoints(identity, sessionStorage, locks)).secondReserve).toEqual({
              txid: parent.id,
              vout: 2,
            })
            const corrupt = JSON.parse(JSON.stringify(journal))
            delete corrupt.pending.secondReserve
            expect(() => restoreConnectorRecoveryJournal(identity, corrupt, sessionStorage, locks)).toThrow(
              'reserve count',
            )
          }
          for (const i of [0, 1]) {
            const wire = RawPSBTV0.decode(approval.toPSBT())
            delete wire.inputs[i].tapKeySig
            delete wire.inputs[i].partialSig
            expect(() => handoff.accept(hex.encode(RawPSBTV0.encode(wire)))).toThrow()
          }
          // Mutating either approved output, the input order or sighash cannot
          // turn the returned signatures into authority for another payment.
          for (const mutate of [
            (wire: ReturnType<typeof RawPSBTV0.decode>) => {
              wire.global.unsignedTx!.outputs[0].amount--
            },
            (wire: ReturnType<typeof RawPSBTV0.decode>) => {
              wire.global.unsignedTx!.outputs[1].amount--
            },
            (wire: ReturnType<typeof RawPSBTV0.decode>) => {
              wire.global.unsignedTx!.outputs[0].script[3] ^= 1
            },
            (wire: ReturnType<typeof RawPSBTV0.decode>) => {
              wire.global.unsignedTx!.inputs.reverse()
            },
            (wire: ReturnType<typeof RawPSBTV0.decode>) => {
              wire.inputs[0].sighashType = 0x83
            },
          ]) {
            const wire = RawPSBTV0.decode(approval.toPSBT())
            mutate(wire)
            expect(() => handoff.accept(hex.encode(RawPSBTV0.encode(wire)))).toThrow()
          }
          for (const mode of [1, 2, 0x81, 0x82, 0x83]) {
            const wire = RawPSBTV0.decode(hex.decode(initial.hardwareApproval()))
            for (const i of [0, 1]) wire.inputs[i].sighashType = mode
            const downgraded = Transaction.fromPSBT(RawPSBTV0.encode(wire), options)
            for (const i of [0, 1]) downgraded.signIdx(key.privateKey!, i, [mode])
            expect(() => initial.acceptHardwareApproval(hex.encode(downgraded.toPSBT()))).toThrow()
          }
          expect(() => prepareConnectorPayment({ ...request, secondReserve: undefined })).toThrow('reserve count')
          expect(() => prepareConnectorPayment({ ...request, secondReserve: request.reserve })).toThrow('duplicate')
        })
      }
    }
  }
})

// Guardian consumes the same fixed public fixtures; never regenerate them as
// part of this check, since that would conceal cross-language contract drift.
describe('dual connector cross-language contract', () => {
  for (const v of dualVectors) {
    it(`${v.contract.network} ${v.contract.connectorType} ${v.contract.protectionTier} matches the Guardian fixture`, () => {
      const contract = {
        ...v.contract,
        connectorType: v.contract.connectorType as 'p2tr' | 'p2wpkh',
        protectionTier: v.contract.protectionTier as 'standard' | 'advanced',
        spendingPolicy: defaultSpendingPolicy(v.contract.network as 'mainnet' | 'mutinynet'),
      }
      const family = buildConnectorFamily(contract)
      expect(hex.encode(family.program)).toBe(v.program)
      expect(hex.encode(family.savings.script)).toBe(v.savingsScript)
      expect(hex.encode(family.savings.normal)).toBe(v.leaf)
      expect(hex.encode(family.savings.control)).toBe(v.control)
      expect(connectorEnrollmentDigest(contract, { ...v.origin, publicKey: hex.decode(v.origin.publicKey) })).toBe(
        v.enrollmentDigest,
      )

      for (const payment of v.payments) {
        const parent = Transaction.fromRaw(hex.decode(payment.parent), options)
        const final = Transaction.fromRaw(hex.decode(payment.finalTx), options)
        const coin = (vout: number) => ({ parentHex: payment.parent, txid: parent.id, vout })
        const prepared = prepareConnectorPayment({
          contract,
          origin: { ...v.origin, publicKey: hex.decode(v.origin.publicKey) },
          enrollmentDigest: v.enrollmentDigest,
          savings: coin(0),
          reserve: coin(1),
          secondReserve: coin(2),
          recipient: Address(vaultAddressNetwork(contract.network)).encode(
            OutScript.decode(final.getOutput(0).script!),
          ),
          amountSats: payment.amount,
          feeSats: payment.fee,
          hardwareSignatures: payment.hardwareSignatures,
        })
        expect(prepared.verifyPhoneStage(payment.phonePSBT)).toBe(payment.phonePSBT)
        const witness = final.getInput(2).finalScriptWitness!
        expect(prepared.forHardware(witness).accept(prepared.psbt())).toEqual({
          txHex: payment.finalTx,
          txid: payment.txid,
        })
      }
    })
  }
})
