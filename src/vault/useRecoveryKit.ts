import { useCallback } from 'react'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import type { VaultStatus } from '../lib/vault/types'
import { unlockLocalEnrollment } from '../lib/vault/signIn'
import { kitFromFacts, pullMapBackup, pushMapBackup } from '../lib/vault/program/kitBackup'
import { loadLocalKit, saveLocalKit } from '../lib/vault/program/kitStore'
import { kitMatchesLiveVault } from '../lib/vault/program/liveKit'

interface RecoveryKitOptions {
  enrollment: EnrollmentSecrets | null
  status: VaultStatus | null
  hardwarePub: string
  recoveryPub: string
  clearError: () => void
}

// Recovery-map commands bind the current enrollment and stored kit.
export function useRecoveryKit({ enrollment, status, hardwarePub, recoveryPub, clearError }: RecoveryKitOptions) {
  const resolveKit = useCallback(() => {
    const id = status?.vaultId || enrollment?.vaultId || ''
    const stored = id ? loadLocalKit(id) : null
    if (status?.enrolled && stored && kitMatchesLiveVault(stored, status)) return stored
    return kitFromFacts({
      enrollment,
      status,
      hardwarePub,
      recoveryPub: recoveryPub || status?.recoveryPub,
    })
  }, [enrollment, hardwarePub, recoveryPub, status])

  const downloadRecoveryKit = useCallback(() => {
    const kit = resolveKit()
    if (!kit) throw new Error('No Recovery Kit yet. Add recovery, or get the map with Face ID.')
    return JSON.stringify(kit, null, 2)
  }, [resolveKit])

  const backupRecoveryKit = useCallback(async () => {
    clearError()
    if (enrollment && status?.enrolled) await unlockLocalEnrollment(enrollment)
    const kit = resolveKit()
    if (!kit) throw new Error('This vault has no recovery map. Add recovery on a new vault.')
    saveLocalKit(kit)
    const id = kit.descriptor.vaultId
    return id ? pushMapBackup(id, kit) : false
  }, [clearError, enrollment, hardwarePub, resolveKit, status])

  const restoreRecoveryKit = useCallback(async () => {
    clearError()
    if (enrollment && status?.enrolled) await unlockLocalEnrollment(enrollment)
    const id = status?.vaultId || enrollment?.vaultId || ''
    const pulled = id ? await pullMapBackup(id) : null
    const kit =
      pulled?.kit ||
      kitFromFacts({
        enrollment,
        status,
        hardwarePub,
        recoveryPub: recoveryPub || status?.recoveryPub,
      })
    if (!kit) throw new Error('Could not rebuild the map. Save it while this app is open.')
    if (id && kit.descriptor.vaultId !== id) throw new Error('Recovery Kit does not match this vault')
    if (status?.enrolled && status.templateVersion && kit.descriptor.templateVersion !== status.templateVersion) {
      throw new Error('Recovery Kit does not match this vault')
    }
    saveLocalKit(kit)
  }, [clearError, enrollment, hardwarePub, recoveryPub, status])

  return {
    backupRecoveryKit,
    downloadRecoveryKit,
    hasRecoveryKit: Boolean(resolveKit()),
    restoreRecoveryKit,
  }
}
