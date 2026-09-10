import { requireSavingsRecoveryKit, parseRecoveryKit, inspectRecoveryKit } from './kit'
import { DUAL_CONNECTOR_TEMPLATE } from './connector'
import { expect, it } from 'vitest'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import vectors from './connector-enrollment-vectors.json'
import { buildConnectorEnrollmentPreview, buildConnectorRecoveryKit } from './connectorEnrollmentCore'
import { familyFromDescriptor } from './descriptor'
import { buildInitiatePsbt, buildClawbackPsbt, buildClaimPsbt } from './spend'

for (const vector of vectors) {
  for (const templateVersion of [undefined, DUAL_CONNECTOR_TEMPLATE]) {
    it(`restores ${templateVersion ?? 'v1'} ${vector.name} connector recovery without the wallet service`, () => {
      // Source-controlled public Go vectors supply all descriptor facts.
      const input = { ...vector.input, templateVersion } as Parameters<typeof buildConnectorEnrollmentPreview>[0]
      const preview = buildConnectorEnrollmentPreview(input)
      const saved = buildConnectorRecoveryKit(preview, { ...input, boarding: input.boarding! })
      const kit = requireSavingsRecoveryKit(parseRecoveryKit(JSON.parse(JSON.stringify(saved))))
      expect(kit.descriptor.savings.address).toBe(saved.savingsAddress)
      const family = familyFromDescriptor(kit.descriptor)
      expect(hex.encode(family.savings.script)).toBe(saved.savingsScript)
      const coin = { txid: 'ab'.repeat(32), vout: 0, value: 50000 }
      for (const claimant of ['hardware', 'phone', ...(input.recoveryPub ? ['recovery'] : [])] as const) {
        const who = claimant as 'hardware' | 'phone' | 'recovery'
        const initiated = buildInitiatePsbt({ family, claimant: who, coin, feeSats: 1000 })
        const tx = Transaction.fromPSBT(hex.decode(initiated.psbtHex), {
          allowUnknownInputs: true,
          allowUnknownOutputs: true,
        })
        expect(hex.encode(tx.getInput(0).witnessUtxo!.script)).toBe(saved.savingsScript)
        expect(hex.encode(tx.getOutput(0).script!)).toBe(kit.descriptor.pending[`savings-${who}`].script)
        const guardian = who === 'phone' ? 'hardware' : 'phone'
        const clawback = buildClawbackPsbt({ family, claimant: who, guardian, coin, feeSats: 1000 })
        expect(clawback.destAddress).toBe(kit.descriptor.quarantine[`savings-${who}`].address)
        const claim = buildClaimPsbt({
          family,
          claimant: who,
          coin,
          feeSats: 1000,
          network: input.network,
          destAddress: saved.savingsAddress,
        })
        const claimTx = Transaction.fromPSBT(hex.decode(claim.psbtHex), {
          allowUnknownInputs: true,
          allowUnknownOutputs: true,
        })
        expect(claimTx.getInput(0).sequence).toBe(kit.descriptor.pending[`savings-${who}`].delay)
      }
      expect(inspectRecoveryKit(kit).trees.length).toBe(input.recoveryPub ? 7 : 5)
      expect(() => parseRecoveryKit({ ...saved, origin: { ...saved.origin, connectorPath: [0, 1] } })).toThrow()
    })
  }
}
