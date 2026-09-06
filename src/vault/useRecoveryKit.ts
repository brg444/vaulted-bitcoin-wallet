import { useCallback, useEffect, useState } from 'react'
import { fetchAddressUtxos } from '../lib/vault/esplora'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import type { VaultStatus } from '../lib/vault/types'
import { zeroBytes } from '../lib/vault/ceremony/directauth.js'
import { unlockLocalEnrollment } from '../lib/vault/signIn'
import { unlockPhoneBip340 } from '../lib/vault/savingsSpend'
import { signGuardianExitPsbt } from '../lib/vault/program/guardianExit'
import { kitFromFacts, pullMapBackup, pushMapBackup } from '../lib/vault/program/kitBackup'
import { loadLocalKit, saveLocalKit } from '../lib/vault/program/kitStore'
import { loadConnectorRecoveryKit } from '../lib/vault/program/connectorEnroll'
import { CONNECTOR_TEMPLATE } from '../lib/vault/program/connector'
import { kitMatchesLiveVault, selectLiveKit } from '../lib/vault/program/liveKit'
import {
  alertCopy,
  loadSeenOutpoints,
  pollPendingInitiates,
  saveSeenOutpoints,
  type InitiateAlert,
} from '../lib/vault/program/watch'

interface RecoveryKitOptions {
  enrollment: EnrollmentSecrets | null
  status: VaultStatus | null
  hardwarePub: string
  recoveryPub: string
  clearError: () => void
}

// useRecoveryKit owns recovery-map persistence, device recovery signing, and
// the best-effort local alert poll. It has no navigation or wallet-balance
// responsibilities.
export function useRecoveryKit({ enrollment, status, hardwarePub, recoveryPub, clearError }: RecoveryKitOptions) {
  const [initiateAlert, setInitiateAlert] = useState('')
  const [initiateAlerts, setInitiateAlerts] = useState<InitiateAlert[]>([])

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

  const resolveConnectorKit = useCallback(() => {
    const id = status?.vaultId || enrollment?.vaultId || ''
    if (status?.templateVersion !== CONNECTOR_TEMPLATE || !id) return null
    return loadConnectorRecoveryKit(id)
  }, [enrollment?.vaultId, status?.templateVersion, status?.vaultId])

  const downloadRecoveryKit = useCallback(() => {
    const connectorKit = resolveConnectorKit()
    if (connectorKit) return JSON.stringify(connectorKit, null, 2)
    const kit = resolveKit()
    if (!kit) throw new Error('No Recovery Kit yet. Add recovery, or get the map with Face ID.')
    return JSON.stringify(kit, null, 2)
  }, [resolveConnectorKit, resolveKit])

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

  const signGuardianExitWithDevice = useCallback(
    async (psbtHex: string) => {
      if (!enrollment || !status?.enrolled) throw new Error('Unlock this device on this vault first')
      const privateKey = await unlockPhoneBip340(enrollment, status)
      try {
        return signGuardianExitPsbt(psbtHex, privateKey)
      } finally {
        zeroBytes(privateKey)
      }
    },
    [enrollment, status],
  )

  useEffect(() => {
    const id = status?.vaultId || enrollment?.vaultId || ''
    setInitiateAlerts([])
    setInitiateAlert('')
    const kit = status?.enrolled ? selectLiveKit({ status, stored: id ? loadLocalKit(id) : null }) : null
    if (!kit) return
    let cancelled = false
    const poll = async () => {
      try {
        const seen = loadSeenOutpoints(kit.descriptor.vaultId)
        const next = await pollPendingInitiates({ descriptor: kit.descriptor, fetchUtxos: fetchAddressUtxos, seen })
        if (cancelled) return
        saveSeenOutpoints(kit.descriptor.vaultId, next.seen)
        if (next.alerts.length) {
          setInitiateAlerts((previous) => [...next.alerts, ...previous].slice(0, 12))
          setInitiateAlert(alertCopy(next.alerts[0]))
        }
      } catch {
        // This local poll is a convenience signal, not a watchtower.
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 20_000)
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [enrollment?.vaultId, status?.templateVersion, status?.vaultId])

  return {
    backupRecoveryKit,
    downloadRecoveryKit,
    hasRecoveryKit: Boolean(resolveConnectorKit() || resolveKit()),
    initiateAlert,
    initiateAlerts,
    restoreRecoveryKit,
    signGuardianExitWithDevice,
  }
}
