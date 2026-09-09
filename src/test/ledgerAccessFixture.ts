import { hex } from '@scure/base'
import { canonicalLedgerAccessBackup, ledgerAccessBackup } from '../lib/vault/passkeyBinding'
import { ledgerSavingsContextDigest } from '../lib/vault/program/ledgerNativeKeys'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import type { VaultStatus } from '../lib/vault/types'

export function bindingFor(enrollment: EnrollmentSecrets, status: VaultStatus) {
  const keys =
    'version credentialId webauthnP256 phoneDirectP256 phoneBip340Pub externalOwnerWalletPub vaultCosignerBasePub arkadeCosignerBasePub arkadeCosignerOrigin arkadeCosignerVersion clientOrigin rpId network vaultId templateVersion policyVersion protectionTier savingsAddress savingsScript vtxoVaultCosignerPub vtxoExitDelay vtxoExitDelayUnit spendingArkAddress spendingArkScript vtxoDelegatePub vtxoBoardingActive vtxoBoardingProgram vtxoBoardingAddress vtxoBoardingScript vtxoBoardingExitDelay vtxoBoardingExitDelayUnit recipientDustSats txRecipientCapSats periodAllowanceSats absoluteFeeCapSats feerateCapSatVb envelopeNonce envelopeCiphertext'.split(
      ' ',
    )
  const values = {
    ...status,
    version: 6,
    credentialId: enrollment.credId,
    webauthnP256: enrollment.webauthnP256,
    recipientDustSats: 330,
    txRecipientCapSats: status.txCap,
    periodAllowanceSats: status.periodAllowance,
    absoluteFeeCapSats: status.absoluteFeeCap,
    envelopeNonce: enrollment.nonce,
    envelopeCiphertext: enrollment.ciphertext,
  }
  return JSON.stringify({
    ...Object.fromEntries(keys.map((key) => [key, values[key as keyof typeof values] ?? ''])),
    ledgerSavingsContextDigest: hex.encode(ledgerSavingsContextDigest(status.ledgerSavings!.context)),
    ledgerSavingsDescriptorHash: status.ledgerSavings!.descriptorHash,
    ledgerSavingsBackup: canonicalLedgerAccessBackup(ledgerAccessBackup(enrollment)!),
  })
}
