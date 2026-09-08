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
import { createPortableRecoveryPackage } from '../lib/vault/recovery/portable'
import { recordRecoveryCopy } from '../lib/vault/recovery/copyStatus'

export function useRecoveryArchive(enrollment: EnrollmentSecrets | null, status: VaultStatus | null, locked: boolean) {
  const session = useRef<RecoveryBackupSession | null>(null)
  const contextEpoch = useRef(0)
  const activityEpoch = useRef(0)
  const [recoveryArchiveStatus, setRecoveryArchiveStatus] = useState('')
  const [recoveryArchiveError, setRecoveryArchiveError] = useState('')
  const current = useRef({ enrollment, status, locked })
  current.current = { enrollment, status, locked }
  useEffect(() => {
    session.current = null
    setRecoveryArchiveStatus('')
    setRecoveryArchiveError('')
    return () => {
      contextEpoch.current++
      session.current = null
    }
  }, [enrollment?.vaultId, locked])
  const capture = useCallback(async () => {
    const { enrollment, status, locked } = current.current
    if (!enrollment || !status?.enrolled || locked) throw new Error('Unlock this vault to update recovery data')
    const context = contextEpoch.current
    const activity = activityEpoch.current
    const unchanged = () => context === contextEpoch.current && activity === activityEpoch.current
    const file = await captureVaultRecoveryFile(status, enrollment)
    if (!unchanged()) return file
    await recordRecoveryCopy(status.vaultId, status.network, 'local', file.archive.spending)
    const active = session.current
    if (active && active.header.binding.vaultId === status.vaultId) {
      await syncRecoveryCloudBackup(active, file)
      await recordRecoveryCopy(status.vaultId, status.network, 'service', file.archive.spending)
      if (!unchanged()) return file
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
        if (active) {
          setRecoveryArchiveStatus('Recovery data update incomplete')
          setRecoveryArchiveError(
            error instanceof Error ? error.message : 'Recovery update failed; the previous copy is retained',
          )
        }
      },
    )
    const request = () => {
      activityEpoch.current++
      setRecoveryArchiveStatus('Checking recovery data against your wallet…')
      scheduler.request()
    }
    const unsubscribe = subscribeVaultWalletEvents(status, request)
    request()
    const timer = window.setInterval(request, 30000)
    window.addEventListener('focus', request)
    window.addEventListener('online', request)
    window.addEventListener('vaulted-savings-setup', request)
    document.addEventListener('visibilitychange', request)
    return () => {
      active = false
      scheduler.dispose()
      unsubscribe()
      clearInterval(timer)
      window.removeEventListener('focus', request)
      window.removeEventListener('online', request)
      window.removeEventListener('vaulted-savings-setup', request)
      document.removeEventListener('visibilitychange', request)
    }
  }, [enrollment?.vaultId, status?.vaultId, locked, capture])
  const backupRecoveryArchive = useCallback(async () => {
    const { enrollment, status, locked } = current.current
    if (!enrollment || !status?.enrolled || locked) throw new Error('Unlock this vault first')
    const kit = kitFromFacts({ status, enrollment })
    if (!kit) throw new Error('Recovery descriptor is unavailable')
    const header = buildRecoveryHeader(kit, status, enrollment)
    if (!session.current || Date.parse(session.current.expiresAt) <= Date.now()) {
      const epoch = contextEpoch.current
      const opened = await openRecoveryCloudBackup(header)
      if (epoch !== contextEpoch.current) throw new Error('Unlock this vault again to enable backup')
      session.current = opened
    }
    await capture()
  }, [capture])
  const downloadRecoveryArchive = useCallback(async (format: 'encrypted' | 'portable' = 'encrypted') => {
    const { enrollment, status, locked } = current.current
    if (!enrollment || !status?.enrolled || locked) throw new Error('Unlock this vault first')
    const file = await captureVaultRecoveryFile(status, enrollment)
    await recordRecoveryCopy(status.vaultId, status.network, 'local', file.archive.spending)
    const encode = async (key: CryptoKey) =>
      JSON.stringify(
        format === 'portable' ? await createPortableRecoveryPackage(file, key) : await encryptRecoveryBackup(file, key),
        null,
        2,
      )
    const active = session.current
    if (active?.header.binding.vaultId === status.vaultId) return encode(active.key)
    const phone = await unlockPhoneBip340(enrollment, status)
    try {
      return await encode(await recoveryBackupKey(phone, file.header))
    } finally {
      phone.fill(0)
    }
  }, [])
  return { backupRecoveryArchive, downloadRecoveryArchive, recoveryArchiveStatus, recoveryArchiveError }
}
