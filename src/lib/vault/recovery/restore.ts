import { storeVaultRecoveryArchive } from '../vtxo/recoveryArchive'
import { IndexedDBContractRepository } from '@arkade-os/sdk'
import { IndexedDbAssetSwapRepository } from '@arkade-os/swap'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { validateVaultRecoveryFile, type VaultRecoveryFile } from './backupCodec'
import { validateRecoveryJournals, recoveryLightningBinding, type RecoveryJournals } from './journals'
import { restoreLightningRecoveryJournal } from './lightningArchive'
import { restoreSpendingRecoveryJournal } from '../vtxo/spendingJournal'
import { vaultWalletDatabase } from '../vtxo/walletWorkerNames'
import { vaultLightningSwapStorageName } from '../lightningLifecycle'
import { requireStatusIdentity } from '../status'
import { loadEnrollment, saveEnrollment, saveSelectedVaultId } from '../enrollmentStore'
import { saveAddressPin, pinFromEnrolledStatus, loadAddressPin } from '../pin'
import { loadLocalKit, saveLocalKit } from '../program/kitStore'
import { isLedgerRecoveryKit } from '../program/kit'
import { canonicalLedgerValue } from '../program/ledgerEnrollment'
import { restoreLedgerSavingsPaymentJournal } from '../ledgerSavingsWallet'
import { restoreLedgerRecoveryJournal } from '../ledgerRecoveryWallet'
import { deriveLedgerPhoneAccount } from '../ledgerPhoneBackup'
import { provisionBoardingKey } from '../vtxo/board'
import { storeRecoveryImport } from './fileStore'

/** Idempotent, conservative import; no archived status is treated as current chain state. */
export async function restoreVaultRecoveryFile(
  value: VaultRecoveryFile,
  phone: Uint8Array,
  ledgerSavingsSeed?: Uint8Array,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const candidate = JSON.parse(JSON.stringify(value)) as VaultRecoveryFile
  requireStatusIdentity(
    candidate?.archive?.status as Parameters<typeof requireStatusIdentity>[0],
    candidate?.header?.binding?.vaultId,
  )
  const file = validateVaultRecoveryFile(candidate)
  if (!navigator.locks) throw new Error('Web Locks required to restore complete recovery data')
  const spending = Uint8Array.from(phone),
    savings = ledgerSavingsSeed ? Uint8Array.from(ledgerSavingsSeed) : undefined
  try {
    return await navigator.locks.request(`vaulted:complete-recovery:${file.header.binding.descriptorHash}`, () =>
      restoreLocked(file, spending, savings, signal),
    )
  } finally {
    spending.fill(0)
    savings?.fill(0)
  }
}

async function restoreLocked(
  file: VaultRecoveryFile,
  phone: Uint8Array,
  ledgerSavingsSeed?: Uint8Array,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const { status, enrollment } = file.header
  validateRecoveryJournals(status, file as VaultRecoveryFile & RecoveryJournals)
  if (hex.encode(schnorr.getPublicKey(phone)) !== file.header.kit.descriptor.keys.phoneBip340.slice(2))
    throw new Error('Recovery phone key changed')
  if (isLedgerRecoveryKit(file.header.kit)) {
    const context = file.header.kit.descriptor.ledgerSavings.context
    if (
      !ledgerSavingsSeed ||
      canonicalLedgerValue(
        deriveLedgerPhoneAccount(ledgerSavingsSeed, context.network, context.phone.path[2] - 0x80000000),
      ) !== canonicalLedgerValue(context.phone)
    )
      throw new Error('Recovery Savings HD seed does not match the enrolled origin')
  } else if (ledgerSavingsSeed) throw new Error('Savings HD seed supplied for a Spending-only recovery file')
  const existingKit = loadLocalKit(status.vaultId)
  if (existingKit && existingKit.descriptorHash !== file.header.kit.descriptorHash)
    throw new Error('A different local Recovery Kit must not be overwritten')
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
  // The key is derived from the original phone key and verified against the
  // saved enrollment before activation; no separate boarding secret is imported.
  signal?.throwIfAborted()
  await provisionBoardingKey(phone, status)
  // Once import begins, finish persisting its recovery evidence even if the caller locks.
  // The session owner drains this operation before revoking the activated key.
  const contracts = new IndexedDBContractRepository(vaultWalletDatabase(status.vaultId))
  const swaps = new IndexedDbAssetSwapRepository(vaultLightningSwapStorageName(status.vaultId))
  try {
    await restoreLightningRecoveryJournal(file.lightningJournal!, recoveryLightningBinding(status), {
      swaps,
      contracts,
    })
    await restoreSpendingRecoveryJournal(status, file.spendingJournal)
    if (isLedgerRecoveryKit(file.header.kit)) {
      const contract = file.header.kit.descriptor.ledgerSavings
      if (file.ledgerSavingsJournal) await restoreLedgerSavingsPaymentJournal(contract, file.ledgerSavingsJournal)
      if (file.ledgerRecoveryJournal) await restoreLedgerRecoveryJournal(contract, file.ledgerRecoveryJournal)
    }
    await storeVaultRecoveryArchive(file.archive)
    await storeRecoveryImport(file.header.binding.descriptorHash, file)
    saveLocalKit(file.header.kit)
    saveAddressPin(pin)
    saveEnrollment(enrollment)
    saveSelectedVaultId(status.vaultId)
    return file
  } finally {
    await Promise.allSettled([contracts[Symbol.asyncDispose](), swaps[Symbol.asyncDispose]()])
  }
}
