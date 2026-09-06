import { storeVaultRecoveryArchive } from '../vtxo/recoveryArchive'
import { IndexedDBContractRepository } from '@arkade-os/sdk'
import { IndexedDbAssetSwapRepository } from '@arkade-os/swap'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { validateVaultRecoveryFile, type VaultRecoveryFile } from './backupCodec'
import { validateRecoveryJournals, recoveryLightningBinding, type RecoveryJournals } from './journals'
import { restoreLightningRecoveryJournal } from './lightningArchive'
import { restoreSpendingRecoveryJournal } from '../vtxo/spend'
import { vaultWalletDatabase } from '../vtxo/walletWorkerNames'
import { vaultLightningSwapStorageName } from '../lightningLifecycle'
import { restoreConnectorRecoveryJournal } from '../program/connectorStore'
import { CONNECTOR_TEMPLATE } from '../program/connector'
import {
  connectorPinFromVerifiedStatus,
  saveConnectorEnrollmentPin,
  connectorKitFromVerifiedStatus,
  saveConnectorRecoveryKit,
  loadConnectorEnrollmentPin,
  verifyConnectorStatus,
} from '../program/connectorEnroll'
import { loadEnrollment, saveEnrollment, saveSelectedVaultId } from '../enrollmentStore'
import { saveAddressPin, pinFromEnrolledStatus, loadAddressPin } from '../pin'
import { saveLocalKit } from '../program/kitStore'
import { provisionBoardingKey } from '../vtxo/board'
import { recoveryFileStore } from './fileStore'

/** Idempotent, conservative import; no archived status is treated as current chain state. */
export async function restoreVaultRecoveryFile(value: VaultRecoveryFile, phone: Uint8Array) {
  const file = validateVaultRecoveryFile(JSON.parse(JSON.stringify(value)))
  const { status, enrollment } = file.header
  validateRecoveryJournals(status, file as VaultRecoveryFile & RecoveryJournals)
  if (hex.encode(schnorr.getPublicKey(phone)) !== file.header.kit.descriptor.keys.phoneBip340.slice(2))
    throw new Error('Recovery phone key changed')
  const existing = loadEnrollment(localStorage, status.vaultId)
  if (
    existing &&
    Object.entries(enrollment).some(
      ([key, value]) => JSON.stringify(existing[key as keyof typeof existing]) !== JSON.stringify(value),
    )
  )
    throw new Error('A different local enrollment must not be overwritten')
  const pin = pinFromEnrolledStatus(status)
  const oldPin = loadAddressPin(localStorage, status.vaultId)
  if (oldPin && oldPin.pinHash !== pin.pinHash) throw new Error('Recovery address pin differs from this device')
  const connector = status.templateVersion === CONNECTOR_TEMPLATE ? connectorPinFromVerifiedStatus(status) : null
  const previousConnector = connector ? loadConnectorEnrollmentPin(status.vaultId) : null
  if (previousConnector) verifyConnectorStatus(status, previousConnector)
  // The key is derived from the original phone key and verified against the
  // saved enrollment before activation; no separate boarding secret is imported.
  await provisionBoardingKey(phone, status)
  const contracts = new IndexedDBContractRepository(vaultWalletDatabase(status.vaultId))
  const swaps = new IndexedDbAssetSwapRepository(vaultLightningSwapStorageName(status.vaultId))
  try {
    await restoreLightningRecoveryJournal(file.lightningJournal!, recoveryLightningBinding(status), {
      swaps,
      contracts,
    })
    await restoreSpendingRecoveryJournal(status, file.spendingJournal)
    if (connector)
      await restoreConnectorRecoveryJournal(
        { vaultId: status.vaultId, enrollmentDigest: status.connectorEnrollment!.enrollmentDigest },
        file.connectorJournal,
        localStorage,
      )
    if (connector) {
      saveConnectorEnrollmentPin(connector)
      saveConnectorRecoveryKit(connectorKitFromVerifiedStatus(status))
    }
    await storeVaultRecoveryArchive(file.archive)
    saveLocalKit(file.header.kit)
    saveAddressPin(pin)
    saveEnrollment(enrollment)
    saveSelectedVaultId(status.vaultId)
    await recoveryFileStore(file.header.binding.descriptorHash, file)
    return file
  } finally {
    await Promise.allSettled([contracts[Symbol.asyncDispose](), swaps[Symbol.asyncDispose]()])
  }
}
