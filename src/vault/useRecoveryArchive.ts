import { unlockPhoneBip340 } from '../lib/vault/savingsSpend'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import type { VaultStatus } from '../lib/vault/types'
import { captureVaultRecoveryFile } from '../lib/vault/recovery/capture'
import {
  openRecoveryCloudBackup,
  syncRecoveryCloudBackup,
  type RecoveryBackupSession,
} from '../lib/vault/recovery/cloudBackup'
import { buildRecoveryHeader, encryptRecoveryBackup, recoveryBackupKey } from '../lib/vault/recovery/backupCodec'
import { kitFromFacts } from '../lib/vault/program/kitBackup'
import { lightBackupScheduler } from '../lib/vault/light/backupScheduler'
import { subscribeVaultWalletEvents } from '../lib/vault/vtxo/walletWorker'

export function useRecoveryArchive(enrollment: EnrollmentSecrets | null, status: VaultStatus | null, locked: boolean) {
  const session = useRef<RecoveryBackupSession | null>(null)
  const [recoveryArchiveStatus, setRecoveryArchiveStatus] = useState('')
  const [recoveryArchiveError, setRecoveryArchiveError] = useState('')
  const current = useRef({ enrollment, status, locked })
  current.current = { enrollment, status, locked }
  useEffect(() => {
    session.current = null
    setRecoveryArchiveStatus('')
    setRecoveryArchiveError('')
    return () => {
      session.current = null
    }
  }, [enrollment?.vaultId, locked])
  const capture = useCallback(async () => {
    const { enrollment, status, locked } = current.current
    if (!enrollment || !status?.enrolled || locked) throw new Error('Unlock this vault to update recovery data')
    const file = await captureVaultRecoveryFile(status, enrollment)
    const active = session.current
    if (active && active.header.binding.vaultId === status.vaultId) {
      await syncRecoveryCloudBackup(active, file)
      setRecoveryArchiveStatus(`Encrypted cloud backup verified ${new Date().toLocaleString()}`)
    } else setRecoveryArchiveStatus(`Transaction recovery data saved on this device ${new Date().toLocaleString()}`)
    setRecoveryArchiveError('')
    return file
  }, [])
  useEffect(() => {
    if (!enrollment || !status?.enrolled || locked) return
    let active = true
    const scheduler = lightBackupScheduler(
      async () => {
        if (document.visibilityState !== 'hidden') await capture()
      },
      (error) => {
        if (active)
          setRecoveryArchiveError(
            error instanceof Error ? error.message : 'Recovery update failed; the previous copy is retained',
          )
      },
    )
    const unsubscribe = subscribeVaultWalletEvents(status, scheduler.request)
    scheduler.request()
    const timer = window.setInterval(scheduler.request, 30000)
    window.addEventListener('focus', scheduler.request)
    window.addEventListener('online', scheduler.request)
    document.addEventListener('visibilitychange', scheduler.request)
    return () => {
      active = false
      scheduler.dispose()
      unsubscribe()
      clearInterval(timer)
      window.removeEventListener('focus', scheduler.request)
      window.removeEventListener('online', scheduler.request)
      document.removeEventListener('visibilitychange', scheduler.request)
    }
  }, [enrollment?.vaultId, status?.vaultId, locked, capture])
  const backupRecoveryArchive = useCallback(async () => {
    const { enrollment, status, locked } = current.current
    if (!enrollment || !status?.enrolled || locked) throw new Error('Unlock this vault first')
    const kit = kitFromFacts({ status, enrollment })
    if (!kit) throw new Error('Recovery descriptor is unavailable')
    const header = buildRecoveryHeader(kit, status, enrollment)
    if (!session.current || Date.parse(session.current.expiresAt) <= Date.now())
      session.current = await openRecoveryCloudBackup(header)
    await capture()
  }, [capture])
  const downloadRecoveryArchive = useCallback(async () => {
    const { enrollment, status, locked } = current.current
    if (!enrollment || !status?.enrolled || locked) throw new Error('Unlock this vault first')
    const file = await captureVaultRecoveryFile(status, enrollment)
    const active = session.current
    if (active?.header.binding.vaultId === status.vaultId)
      return JSON.stringify(await encryptRecoveryBackup(file, active.key), null, 2)
    const phone = await unlockPhoneBip340(enrollment, status)
    try {
      return JSON.stringify(await encryptRecoveryBackup(file, await recoveryBackupKey(phone, file.header)), null, 2)
    } finally {
      phone.fill(0)
    }
  }, [])
  return { backupRecoveryArchive, downloadRecoveryArchive, recoveryArchiveStatus, recoveryArchiveError }
}
