import { IndexedDBContractRepository } from '@arkade-os/sdk'
import { IndexedDbAssetSwapRepository } from '@arkade-os/swap'
import type { VaultStatus } from '../types'
import { LIGHT_PROFILE, lightDescriptorDigest } from '../light/contract'
import { lightExitRepository } from '../light/exitRepository'
import { requireLightStatus } from '../light/status'
import { vaultExitRepository } from '../vtxo/exitRepository'
import { vaultWalletDatabase } from '../vtxo/walletWorkerNames'
import { vaultLightningSwapStorageName } from '../lightningLifecycle'
import {
  spendingScriptFromStatus,
  exportSpendingRecoveryJournal,
  validateSpendingRecoveryJournal,
  type SpendingRecoveryJournal,
} from '../vtxo/spend'
import { vaultRecoveryBinding } from '../vtxo/recoveryArchive'
import { kitFromFacts } from '../program/kitBackup'
import { hex } from '@scure/base'
import {
  captureLightningRecoveryJournal,
  validateLightningRecoveryJournal,
  type LightningRecoveryJournal,
} from './lightningArchive'

export interface RecoveryJournals {
  spendingJournal: SpendingRecoveryJournal
  lightningJournal: LightningRecoveryJournal
}
export function recoveryLightningBinding(status: VaultStatus) {
  const light = status.templateVersion === LIGHT_PROFILE ? requireLightStatus(status) : null
  const kit = light ? null : kitFromFacts({ status })
  if (!light && !kit) throw new Error('Missing recovery descriptor')
  return {
    vaultId: status.vaultId,
    network: status.network,
    phonePub: String(status.phoneBip340Pub || ''),
    spendingScript: hex.encode(spendingScriptFromStatus(status).pkScript),
    descriptorHash: light
      ? lightDescriptorDigest(light.lightDescriptor!)
      : vaultRecoveryBinding(kit!, status).descriptorHash,
  }
}
export function validateRecoveryJournals(status: VaultStatus, data: RecoveryJournals) {
  validateSpendingRecoveryJournal(status, data.spendingJournal)
  validateLightningRecoveryJournal(data.lightningJournal, recoveryLightningBinding(status))
  return data
}
export async function captureRecoveryJournals(
  status: VaultStatus,
  previous?: Partial<RecoveryJournals>,
): Promise<RecoveryJournals> {
  const contracts = new IndexedDBContractRepository(vaultWalletDatabase(status.vaultId))
  const swaps = new IndexedDbAssetSwapRepository(vaultLightningSwapStorageName(status.vaultId))
  const virtualTxRepository =
    status.templateVersion === LIGHT_PROFILE
      ? lightExitRepository(requireLightStatus(status).lightDescriptor!)
      : vaultExitRepository(status.vaultId, status.network)
  try {
    const spendingJournal = await exportSpendingRecoveryJournal(status)
    const lightningJournal = await captureLightningRecoveryJournal({
      binding: recoveryLightningBinding(status),
      swaps,
      contracts,
      virtualTxRepository,
      previous: previous?.lightningJournal,
    })
    return validateRecoveryJournals(status, { spendingJournal, lightningJournal })
  } finally {
    await Promise.allSettled([
      contracts[Symbol.asyncDispose](),
      swaps[Symbol.asyncDispose](),
      virtualTxRepository[Symbol.asyncDispose](),
    ])
  }
}
