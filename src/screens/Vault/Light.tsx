import TransactionReference from './qg/TransactionReference'
import { WalletHelpContext } from './qg/Help'
import { syncCompleteLightBackup as syncLightCloudBackup } from '../../lib/vault/recovery/capture'
import { lightBackupScheduler } from '../../lib/vault/light/backupScheduler'
import { openLightCloudBackup, type LightBackupSession } from '../../lib/vault/light/cloudBackup'
import { encryptLightBackup, openLocalLightBackup, lightBackupKey } from '../../lib/vault/light/backupCodec'
import { unlockLightWithPasskey } from '../../lib/vault/light/passkey'
import type { ExecutorEvent } from '@arkade-os/sdk'
import { networkPins } from '../../lib/vault/networkPins'
import { lightExitDelayLabel, lightRecoveryProgress } from '../../lib/vault/light/recoveryProgress'
import { checkLightRenewal, renewLightSpending } from '../../lib/vault/light/renewal'
import type { LightRenewalPlan } from '../../lib/vault/light/renewalTypes'
import { lightRenewalTiming } from '../../lib/vault/light/renewalTiming'
import {
  authorizeGuardianRenewals,
  refreshGuardianRenewals,
  clearGuardianDelegationReads,
  guardianRenewalCoverage,
} from '../../lib/vault/light/guardianDelegation'
import { guardianRenewalSpendUnlocker } from '../../lib/vault/light/delegationCeremony'
import type { GuardianDelegationJournal } from '../../lib/vault/light/delegationStore'
import {
  captureLightRecoveryArchive,
  loadLightRecoveryArchive,
  storeLightRecoveryArchive,
  validateLightRecoveryArchive,
} from '../../lib/vault/light/recoveryArchive'
import {
  prepareLightRecoveryWithOwner,
  executeLightRecoveryWithOwner,
  prepareLightRecoveryWithSecret,
  validateLightRecoveryFile,
  executeLightRecovery,
  type LightRecoveryFile,
} from '../../lib/vault/light/recovery'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Clock3,
  Copy,
  Eye,
  Fingerprint,
  ShieldCheck,
  Shield,
  QrCode as QrIcon,
  Plus,
  Pencil,
  Settings as SettingsIcon,
} from 'lucide-react'
import Content from './Content'
import Scanner from './Scanner'
import { VaultLauncher } from './Navigation'
import { VaultHistoryList } from './History'
import AccountBalance from './AccountBalance'
import VaultSettings from './Settings'
import QgScreen, { QgMark, QgPrimary, QgSecondary, QgTextButton } from './qg/QgScreen'
import QrCode from '../../components/QrCode'
import { copyToClipboard } from '../../lib/clipboard'
import { fetchPublicStatus, fetchVaultStatusUnpinned } from '../../lib/vault/status'
import { defaultLightPolicy, type LightPolicy } from '../../lib/vault/light/contract'
import {
  beginLightEnrollment,
  LightEnrollmentExpiredError,
  clearExpiredLightEnrollment,
  finishLightEnrollment,
  loadLightEnrollment,
  loadPendingLightEnrollment,
  verifySavedLightRecoveryFile,
  validateLightEnrollment,
  LIGHT_LOCAL_STORE,
  type LightEnrollment,
  type PendingLightEnrollment,
} from '../../lib/vault/light/enrollment'
import { lightStatusMatchesDescriptor } from '../../lib/vault/light/status'
import {
  fetchWatchedSavings,
  loadWatchedSavings,
  saveWatchedSavings,
  type WatchedSavingsAddress,
} from '../../lib/vault/light/watchSavings'
import {
  fetchVaultWalletVtxoSnapshot,
  subscribeVaultWalletEvents,
  shutdownVaultWalletWorker,
  type VaultWalletVtxoSnapshot,
} from '../../lib/vault/vtxo/walletWorker'
import {
  reserveVaultVtxo,
  sendVaultVtxo,
  reconcilePersistedVtxoSpend,
  loadPersistedVtxoSpend,
  quoteFromPersistedVtxoSpend,
  type VaultVtxoSpendQuote,
} from '../../lib/vault/vtxo/spend'
import type { VaultStatus } from '../../lib/vault/types'
import type { VaultHistoryItem } from '../../lib/vault/history'
import { vaultTransactionExplorer } from '../../lib/vault/explorer'
import { useScreenMotion } from './qg/useScreenMotion'
import { useIntentPress } from './qg/useIntentPress'
import './light.css'

type View =
  | 'setup'
  | 'backup'
  | 'auto-backup'
  | 'unlock'
  | 'home'
  | 'receive'
  | 'send'
  | 'review'
  | 'success'
  | 'savings'
  | 'savings-address'
  | 'scan-send'
  | 'settings'
  | 'security'
  | 'restore'
  | 'tx'
  | 'emergency'
const sats = (value: number) => `${new Intl.NumberFormat().format(value)} sats`
function downloadJSON(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function VaultLight({ onExit }: { onExit: () => void }) {
  const [record, setRecord] = useState<LightEnrollment | null>(null)
  const [securitySection, setSecuritySection] = useState<'overview' | 'access' | 'renewal' | 'backup'>('overview')
  const [restoreMethod, setRestoreMethod] = useState<'choose' | 'file'>('choose')
  const [backupStep, setBackupStep] = useState<'file' | 'secret'>('file')
  const [exitStep, setExitStep] = useState<'review' | 'fund'>('review')
  const [view, setView] = useState<View>('setup')
  const [settingsReturn, setSettingsReturn] = useState<'home' | 'savings'>('home')
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [policy, setPolicy] = useState<LightPolicy>(defaultLightPolicy('mainnet'))
  const [mode, setMode] = useState<string | null>(null)
  const [available, setAvailable] = useState(false)
  const [setupExitDelay, setSetupExitDelay] = useState<number | null>(null)
  const [invite, setInvite] = useState('')
  const [pending, setPending] = useState<PendingLightEnrollment | null>(null)
  const [setupExpired, setSetupExpired] = useState(false)
  const restoreRead = useRef(0)
  const cloudSession = useRef<LightBackupSession | null>(null)
  const [cloudSavedAt, setCloudSavedAt] = useState('')
  const [cloudError, setCloudError] = useState('')
  const [passkeyRecovery, setPasskeyRecovery] = useState(false)
  useEffect(
    () => () => {
      cloudSession.current = null
    },
    [],
  )
  const backupRead = useRef(0)
  const [recoverySecret, setRecoverySecret] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [backupFileVerified, setBackupFileVerified] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [snapshot, setSnapshot] = useState<VaultWalletVtxoSnapshot | null>(null)
  const [watched, setWatched] = useState<WatchedSavingsAddress | null>(null)
  const [savings, setSavings] = useState<{ balance: number; history: VaultHistoryItem[] } | null>(null)
  const [watchAddress, setWatchAddress] = useState('')
  const [address, setAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<VaultVtxoSpendQuote | null>(null)
  const [lastTx, setLastTx] = useState('')
  const [selectedTx, setSelectedTx] = useState<VaultHistoryItem | null>(null)
  const [renewalReview, setRenewalReview] = useState<LightRenewalPlan | null>(null)
  const renewalApproval = useRef<((accepted: boolean) => void) | null>(null)
  useEffect(() => () => renewalApproval.current?.(false), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const busyRef = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const [restoreRaw, setRestoreRaw] = useState('')
  const [recoveryFile, setRecoveryFile] = useState<LightRecoveryFile | null>(null)
  const [recoveryDestination, setRecoveryDestination] = useState('')
  const [recoveryEvents, setRecoveryEvents] = useState<ExecutorEvent[]>([])
  const [useSavedRecovery, setUseSavedRecovery] = useState(false)
  const [recoveryDataDate, setRecoveryDataDate] = useState('')
  const [renewalTiming, setRenewalTiming] = useState<ReturnType<typeof lightRenewalTiming> | null>(null)
  const [delegations, setDelegations] = useState<GuardianDelegationJournal | null>(null)
  const coverage =
    record && snapshot?.recoveryVtxos
      ? guardianRenewalCoverage(record.descriptor, delegations, snapshot?.recoveryVtxos || [])
      : null
  const authorizeRenewals = async (owner: Uint8Array, saved: LightEnrollment) => {
    setDelegations(await authorizeGuardianRenewals(saved.descriptor, owner))
  }
  useEffect(() => {
    if (!record) return
    return () => clearGuardianDelegationReads(record.descriptor.vaultId)
  }, [record?.descriptor.vaultId])
  useEffect(() => {
    if (record && (view === 'unlock' || view === 'emergency')) clearGuardianDelegationReads(record.descriptor.vaultId)
  }, [record?.descriptor.vaultId, view === 'unlock', view === 'emergency'])
  const [recoveryDataError, setRecoveryDataError] = useState('')
  const recoveryController = useRef<AbortController | null>(null)
  useEffect(() => () => recoveryController.current?.abort(), [])
  useEffect(() => {
    if (!record || !status || view === 'unlock' || view === 'emergency') return
    let active = true
    const scheduler = lightBackupScheduler(
      async () => {
        if (document.visibilityState === 'hidden') return
        const renewalState = await refreshGuardianRenewals(record.descriptor)
        if (active) setDelegations(renewalState)
        const current = await fetchVaultWalletVtxoSnapshot(status)
        if (!current.recoveryVtxos) throw new Error('Wallet output snapshot is unavailable')
        const archive = await captureLightRecoveryArchive(record.descriptor, current.recoveryVtxos)
        const coins = validateLightRecoveryArchive(archive, record.descriptor).coins
        if (!active) return
        setRecoveryDataDate(archive.capturedAt)
        setRenewalTiming(lightRenewalTiming(coins))
        setRecoveryDataError('')
        const session = cloudSession.current
        if (session) {
          const saved = await syncLightCloudBackup(session, archive)
          if (active) {
            setCloudSavedAt(saved.createdAt)
            setCloudError('')
          }
        }
      },
      (error) => {
        if (active) {
          setRecoveryDataError(
            error instanceof Error ? error.message : 'Transaction recovery data could not be updated',
          )
          setCloudError('Backup update is waiting for complete transaction paths or a cloud connection.')
        }
      },
    )
    scheduler.request()
    const unsubscribe = subscribeVaultWalletEvents(status, scheduler.request)
    const timer = window.setInterval(scheduler.request, 30_000)
    window.addEventListener('focus', scheduler.request)
    window.addEventListener('online', scheduler.request)
    document.addEventListener('visibilitychange', scheduler.request)
    return () => {
      active = false
      scheduler.dispose()
      unsubscribe()
      window.clearInterval(timer)
      window.removeEventListener('focus', scheduler.request)
      window.removeEventListener('online', scheduler.request)
      document.removeEventListener('visibilitychange', scheduler.request)
    }
  }, [record, status?.vaultId, view === 'unlock', view === 'emergency'])

  useScreenMotion(root, renewalReview ? 'renewal-review' : view)
  const intent = useIntentPress(renewalReview ? 'renewal-review' : view)
  const navigate = (next: View) => {
    if (busyRef.current) return
    setError('')
    setNotice('')
    if (next === 'security') setSecuritySection('overview')
    setView(next)
  }
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (e) {
      if (e instanceof LightEnrollmentExpiredError) setSetupExpired(true)
      if (e instanceof DOMException && e.name === 'AbortError')
        setNotice('Stopped. You can resume from your saved recovery file.')
      else setError(e instanceof Error ? e.message : 'The request could not be completed. Try again.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  useEffect(() => {
    try {
      const saved = loadLightEnrollment()
      if (saved) {
        setRecord(saved)
        setView('unlock')
      } else {
        const staged = loadPendingLightEnrollment()
        if (staged) {
          setPending(staged)
          setView(staged.recoveryBackup ? 'backup' : 'auto-backup')
        }
      }
    } catch (e) {
      setError(String(e))
    }
    let live = true
    void fetchPublicStatus()
      .then((s) => {
        if (live) {
          setMode(s.enrollmentMode)
          setAvailable(Boolean(s.supportedSetups?.includes('light')))
          setPolicy(defaultLightPolicy(s.network as 'mainnet' | 'mutinynet'))
          setSetupExitDelay(networkPins(s.network as 'mainnet' | 'mutinynet').policyExitDelay)
        }
      })
      .catch(() => {
        if (live) setError('Vaulted is temporarily unavailable. Try again shortly.')
      })
    return () => {
      live = false
    }
  }, [])
  const refresh = useCallback(async () => {
    if (!record) return
    const st = lightStatusMatchesDescriptor(
      await fetchVaultStatusUnpinned(undefined, record.descriptor.vaultId),
      record.descriptor,
    )
    await reconcilePersistedVtxoSpend(st)
    const next = await fetchVaultWalletVtxoSnapshot(st)
    setStatus(st)
    setSnapshot(next)
  }, [record])
  useEffect(() => {
    if (!status || !record || view === 'unlock') return
    let active = true
    let refreshing = false
    const update = () => {
      if (refreshing || document.visibilityState === 'hidden') return
      refreshing = true
      void refresh()
        .catch((e) => {
          if (active) setError(e instanceof Error ? e.message : 'Unable to update your balance')
        })
        .finally(() => {
          refreshing = false
        })
    }
    update()
    const unsubscribe = subscribeVaultWalletEvents(status, update)
    const timer = window.setInterval(update, 30_000)
    window.addEventListener('focus', update)
    return () => {
      active = false
      unsubscribe()
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
    }
  }, [record, status?.vaultId, view === 'unlock', refresh]) // wallet identity changes only after an explicit restore
  const captureCurrent = async (saved: LightEnrollment, currentStatus: VaultStatus) => {
    const current = await fetchVaultWalletVtxoSnapshot(currentStatus)
    if (!current.recoveryVtxos) throw new Error('Wallet output snapshot is unavailable')
    return captureLightRecoveryArchive(saved.descriptor, current.recoveryVtxos)
  }
  const unlock = () =>
    run(async () => {
      if (!record) throw new Error('Import your Light recovery file first')
      const st = lightStatusMatchesDescriptor(
        await fetchVaultStatusUnpinned(undefined, record.descriptor.vaultId),
        record.descriptor,
      )
      const session = await openLightCloudBackup(record, authorizeRenewals)
      cloudSession.current = session
      const archive = await captureCurrent(record, st)
      const saved = await syncLightCloudBackup(session, archive)
      setCloudSavedAt(saved.createdAt)
      setCloudError('')
      setStatus(st)
      setWatched(loadWatchedSavings(st.vaultId, record.descriptor.network))
      setView('home')
      await refresh()
    })
  const activateAutomaticBackup = async (staged: PendingLightEnrollment) => {
    const next = await finishLightEnrollment(staged)
    setRecord(next.record)
    const session = await openLightCloudBackup(next.record, authorizeRenewals)
    cloudSession.current = session
    const archive = await captureCurrent(next.record, next.status)
    const saved = await syncLightCloudBackup(session, archive)
    setCloudSavedAt(saved.createdAt)
    setCloudError('')
    setStatus(next.status)
    setPending(null)
    setView('home')
  }
  const restoreCloud = () =>
    run(async () => {
      const session = await openLightCloudBackup(undefined, authorizeRenewals)
      if (!session.file)
        throw new Error('No cloud backup was found. Open this wallet on its original device to enable backup.')
      const st = lightStatusMatchesDescriptor(
        await fetchVaultStatusUnpinned(undefined, session.record.descriptor.vaultId),
        session.record.descriptor,
      )
      localStorage.setItem(LIGHT_LOCAL_STORE, JSON.stringify(session.record))
      cloudSession.current = session
      setRecord(session.record)
      setStatus(st)
      setCloudSavedAt(session.file.createdAt)
      setCloudError('')
      setView('home')
    })
  const saveLocalBackup = () =>
    run(async () => {
      if (!record) return
      const owner = await unlockLightWithPasskey(record)
      try {
        const key = await lightBackupKey(owner, record)
        if (!status) throw new Error('Open the wallet before saving a backup')
        const archive = await captureCurrent(record, status)
        const saved = await encryptLightBackup(
          { ...record, name: 'vaulted-light-recovery', version: 1, createdAt: archive.capturedAt, archive },
          key,
        )
        downloadJSON(saved, `vaulted-light-${record.descriptor.vaultId.slice(0, 8)}.json`)
        setNotice('Encrypted backup saved with current Bitcoin exit paths')
      } finally {
        owner.fill(0)
      }
    })
  const unlockLocally = () =>
    run(async () => {
      if (!record) return
      const key = await unlockLightWithPasskey(record)
      try {
        await authorizeRenewals(key, record)
      } finally {
        key.fill(0)
      }
      const st = lightStatusMatchesDescriptor(
        await fetchVaultStatusUnpinned(undefined, record.descriptor.vaultId),
        record.descriptor,
      )
      cloudSession.current = null
      setStatus(st)
      setCloudError('Cloud backup is paused. Open Security to reconnect.')
      setView('home')
    })
  const backup = (saved: LightEnrollment) => {
    downloadJSON(
      { name: 'vaulted-light-recovery', version: 1, ...validateLightEnrollment(saved) },
      `vaulted-light-${saved.descriptor.vaultId.slice(0, 8)}.json`,
    )
    setDownloaded(true)
  }
  useEffect(() => {
    if (record) setWatched(loadWatchedSavings(record.descriptor.vaultId, record.descriptor.network))
  }, [record])
  const openSavings = () =>
    run(async () => {
      setView('savings')
      if (record && watched) setSavings(await fetchWatchedSavings(watched, record.descriptor.network))
    })
  const openTransaction = (tx: VaultHistoryItem) => {
    setSelectedTx(tx)
    navigate('tx')
  }
  const copy = async (text: string) => {
    await copyToClipboard(text)
    setNotice('Copied')
  }
  const activity = (rows: VaultHistoryItem[], account: 'spend' | 'savings' = 'spend', loaded = true) => (
    <VaultHistoryList account={account} balancesLoaded={loaded} history={rows} openTx={openTransaction} />
  )
  const accountHeader = (account: 'Spending' | 'Savings') => (
    <header className='qg-account-bar vault-account-bar'>
      <div className='qg-account'>
        <QgMark />
        <strong>{account}</strong>
      </div>
      <div className='qg-utilities'>
        <button type='button' disabled={busy} aria-label='Open Security' onClick={() => navigate('security')}>
          <Shield />
        </button>
        {account === 'Spending' ? (
          <button type='button' aria-label='Receive to Spending' disabled={!status} onClick={() => navigate('receive')}>
            <QrIcon />
          </button>
        ) : null}
      </div>
    </header>
  )
  const balance = (value: number | null, account: 'Spending' | 'Savings') => (
    <AccountBalance sats={value ?? 0} account={account} balancesLoaded={value !== null} />
  )
  const lock = () =>
    run(async () => {
      if (!record) return
      cloudSession.current = null
      setCloudSavedAt('')
      await shutdownVaultWalletWorker(record.descriptor.vaultId)
      setSnapshot(null)
      setSavings(null)
      setStatus(null)
      setView('unlock')
    })
  let content: React.ReactNode
  if (view === 'setup')
    content = (
      <QgScreen
        title='Vaulted'
        back={onExit}
        footer={
          <>
            <QgPrimary
              label='Create passkey'
              icon={<Fingerprint />}
              disabled={!available}
              loading={busy}
              onClick={() =>
                void run(async () => {
                  const next = await beginLightEnrollment(policy, invite, true)
                  setPending(next.pending)
                  setRecoverySecret(next.recoverySecret)
                  setConfirmation('')
                  setDownloaded(false)
                  setBackupFileVerified(false)
                  setView('auto-backup')
                  await activateAutomaticBackup(next.pending)
                })
              }
            />
          </>
        }
      >
        <p className='qg-eyebrow'>Light</p>
        <h1>Set your spending limits</h1>
        <p className='qg-copy'>Use your passkey for payments, within the limits you choose.</p>
        <div className='light-fields'>
          <label>
            Per-payment limit, in sats
            <input
              inputMode='numeric'
              type='number'
              min='330'
              value={policy.txRecipientCapSats}
              onChange={(e) => setPolicy({ ...policy, txRecipientCapSats: Number(e.target.value) })}
            />
          </label>
          <label>
            Rolling 24-hour limit, in sats
            <input
              inputMode='numeric'
              type='number'
              min='330'
              value={policy.periodAllowanceSats}
              onChange={(e) => setPolicy({ ...policy, periodAllowanceSats: Number(e.target.value) })}
            />
          </label>
          {mode === 'token' ? (
            <label>
              Invite code
              <input autoComplete='off' value={invite} onChange={(e) => setInvite(e.target.value)} />
            </label>
          ) : null}
        </div>
        <p className='qg-copy'>
          Your encrypted wallet backup is saved automatically. Keep access to the passkey provider you choose so you can
          restore on another device.
        </p>
        <details className='light-details'>
          <summary>About Light</summary>
          <p className='qg-copy'>
            Your device signs payments and Vaulted checks the limits before cosigning. The Arkade Operator completes the
            transaction.
          </p>
          <p className='qg-copy'>Savings can show an address from another wallet, which controls those funds.</p>
        </details>
        {mode !== null && !available ? <p className='qg-copy'>Light is not available on this deployment yet.</p> : null}
      </QgScreen>
    )
  else if (view === 'auto-backup' && pending)
    content = (
      <QgScreen
        title='Protect your access'
        back={busy ? undefined : onExit}
        footer={
          <QgPrimary
            label='Finish automatic backup'
            loading={busy}
            onClick={() => void run(() => activateAutomaticBackup(pending))}
          />
        }
      >
        <h1>Saving your wallet backup</h1>
        <p className='qg-copy'>
          Approve with your passkey to finish saving your encrypted backup. Your wallet opens once the saved copy has
          been verified.
        </p>
      </QgScreen>
    )
  else if (view === 'backup' && pending)
    content = (
      <QgScreen
        title='Protect your access'
        back={busy ? undefined : backupStep === 'secret' ? () => setBackupStep('file') : onExit}
        footer={
          backupStep === 'file' ? (
            <QgPrimary
              label='Continue to recovery secret'
              disabled={!backupFileVerified || setupExpired}
              onClick={() => setBackupStep('secret')}
            />
          ) : (
            <QgPrimary
              label='Verify backup and create wallet'
              loading={busy}
              disabled={setupExpired || !backupFileVerified || !confirmation}
              onClick={() =>
                void run(async () => {
                  const next = await finishLightEnrollment(pending, confirmation)
                  setRecord(next.record)
                  setStatus(next.status)
                  setRecoverySecret('')
                  setConfirmation('')
                  setPending(null)
                  setView('home')
                })
              }
            />
          )
        }
      >
        {setupExpired ? (
          <QgSecondary
            label='Restart setup'
            disabled={busy}
            onClick={() => {
              clearExpiredLightEnrollment()
              setPending(null)
              setRecoverySecret('')
              setConfirmation('')
              setBackupFileVerified(false)
              setBackupStep('file')
              setDownloaded(false)
              setSetupExpired(false)
              navigate('setup')
            }}
          />
        ) : null}
        <p className='qg-eyebrow'>Before you receive bitcoin</p>
        <h1>Keep two things safe</h1>
        <p className='qg-copy'>
          Save this recovery file, then write down the secret separately. Anyone with both can recover your wallet key.
        </p>
        {backupStep === 'file' ? (
          <>
            <QgSecondary
              label={downloaded ? 'Download recovery file again' : 'Download recovery file'}
              onClick={() => backup(pending)}
            />
            <label className='light-field'>
              Choose the saved recovery file to verify it
              <input
                type='file'
                accept='.json,application/json'
                onChange={(e) => {
                  const read = ++backupRead.current
                  setBackupFileVerified(false)
                  const chosen = e.target.files?.[0]
                  if (!chosen) return
                  if (chosen.size > 200000) {
                    setError('Choose the original Light recovery file')
                    return
                  }
                  void run(async () => {
                    const raw = await chosen.text()
                    if (read !== backupRead.current) return
                    verifySavedLightRecoveryFile(JSON.parse(raw), pending)
                    setBackupFileVerified(true)
                    setNotice('Recovery file verified')
                  })
                }}
              />
            </label>
          </>
        ) : null}
        {backupStep === 'secret' ? (
          <>
            {recoverySecret ? (
              <div className='light-secret-label'>
                Recovery secret<code className='light-secret'>{recoverySecret}</code>
              </div>
            ) : (
              <p className='qg-copy'>Use the secret you saved before closing setup.</p>
            )}
            <p className='qg-copy'>
              The secret is shown during setup and is not saved in your browser. Keep it somewhere you can reach if you
              lose this device.
            </p>
            <label className='light-field'>
              Enter your saved secret to verify
              <textarea
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete='off'
                spellCheck={false}
              />
            </label>
            <p className='qg-copy'>
              Keep the file and secret separately; both are needed if you lose your passkey. Emergency Bitcoin recovery
              works independently of Vaulted’s approval and these payment limits, and requires current transaction
              paths, Bitcoin for network fees
              {setupExitDelay
                ? `, and a waiting period of ${lightExitDelayLabel(setupExitDelay)} after the required Bitcoin transactions confirm`
                : ''}
              .
            </p>
          </>
        ) : null}
      </QgScreen>
    )
  else if (view === 'unlock')
    content = (
      <QgScreen
        title='Vaulted'
        back={onExit}
        footer={
          <QgPrimary label='Unlock with passkey' loading={busy} icon={<Fingerprint />} onClick={() => void unlock()} />
        }
      >
        <h1>Welcome back</h1>
        <p className='qg-copy'>Use face recognition, a fingerprint or your device PIN to unlock your wallet key.</p>
        <details className='qg-guidance'>
          <summary>Use a local passkey</summary>
          <p>Use the wallet access already saved on this device.</p>
          <QgTextButton label='Unlock on this device' onClick={() => void unlockLocally()} />
        </details>
      </QgScreen>
    )
  else if (view === 'restore')
    content = (
      <QgScreen
        title='Restore Light'
        back={() => (restoreMethod === 'file' ? setRestoreMethod('choose') : navigate(record ? 'unlock' : 'setup'))}
        footer={
          restoreMethod === 'file' ? (
            <QgPrimary
              label='Verify file and unlock'
              loading={busy}
              disabled={!restoreRaw}
              onClick={() =>
                void run(async () => {
                  const parsed = JSON.parse(restoreRaw)
                  const opened =
                    parsed.name === 'vaulted-light-backup'
                      ? await openLocalLightBackup(parsed, authorizeRenewals)
                      : null
                  const restored = opened ? validateLightEnrollment(opened.file) : validateLightEnrollment(parsed)
                  const st = lightStatusMatchesDescriptor(
                    await fetchVaultStatusUnpinned(undefined, restored.descriptor.vaultId),
                    restored.descriptor,
                  )
                  if (!opened) {
                    const key = await unlockLightWithPasskey(restored)
                    try {
                      await authorizeRenewals(key, restored)
                    } finally {
                      key.fill(0)
                    }
                  }
                  if (opened?.file.archive) await storeLightRecoveryArchive(opened.file.archive, restored.descriptor)
                  localStorage.setItem(LIGHT_LOCAL_STORE, JSON.stringify(restored))
                  cloudSession.current = null
                  setCloudError('Local backup restored. Open Security to reconnect cloud backup.')
                  setRecord(restored)
                  setStatus(st)
                  setView('home')
                  setRestoreRaw('')
                })
              }
            />
          ) : undefined
        }
      >
        <h1>Restore your wallet</h1>
        {restoreMethod === 'choose' ? (
          <>
            <QgPrimary
              label='Restore with passkey'
              loading={busy}
              icon={<Fingerprint />}
              onClick={() => void restoreCloud()}
            />
            <p className='qg-copy'>
              Use the passkey saved with your passkey provider to open your encrypted cloud backup.
            </p>
            <QgSecondary label='Use a local backup' onClick={() => setRestoreMethod('file')} />
          </>
        ) : (
          <>
            <h2>Use a local backup</h2>
            <p className='qg-copy'>
              Choose your Light recovery file and approve with the same passkey. Your receiving address and spending
              limits stay the same.
            </p>
            <input
              ref={file}
              type='file'
              accept='.json,application/json'
              onChange={(e) => {
                const read = ++restoreRead.current
                setRestoreRaw('')
                const selected = e.target.files?.[0]
                if (selected) {
                  if (selected.size > 32_000_000) {
                    setRestoreRaw('')
                    setError('This file is too large')
                    return
                  }
                  void selected
                    .text()
                    .then((raw) => {
                      if (read === restoreRead.current) setRestoreRaw(raw)
                    })
                    .catch(() => {
                      if (read === restoreRead.current) setError('This file could not be read')
                    })
                }
              }}
            />
            <QgSecondary
              label='Recover directly to Bitcoin'
              disabled={!restoreRaw}
              onClick={() =>
                void run(async () => {
                  const parsed = JSON.parse(restoreRaw)
                  const encrypted = parsed.name === 'vaulted-light-backup'
                  const saved = encrypted
                    ? (await openLocalLightBackup(parsed)).file
                    : validateLightRecoveryFile(parsed)
                  setPasskeyRecovery(encrypted || !saved.recoveryBackup)
                  setUseSavedRecovery(Boolean(saved.archive))
                  setRecoveryFile(saved)
                  setConfirmation('')
                  setExitStep('review')
                  setView('emergency')
                })
              }
            />
            <p className='qg-copy'>
              Your local backup includes the saved paths for a Bitcoin exit without Vaulted’s approval or the Operator.
              Keep access to your original passkey to unlock it. Older recovery files can still use their recovery code.
            </p>
          </>
        )}
      </QgScreen>
    )
  else if (view === 'emergency' && recoveryFile)
    content = (
      <QgScreen
        title='Emergency Bitcoin recovery'
        back={() => {
          if (!busyRef.current) navigate('restore')
        }}
        footer={
          recoveryFile.exitPackage && exitStep === 'review' ? (
            <QgPrimary label='Continue to fee funding' onClick={() => setExitStep('fund')} />
          ) : recoveryFile.exitPackage ? (
            <QgPrimary
              label='Start Bitcoin recovery'
              loading={busy}
              disabled={!passkeyRecovery && !confirmation}
              onClick={() =>
                void run(async () => {
                  const controller = new AbortController()
                  recoveryController.current = controller
                  setRecoveryEvents([])
                  try {
                    const onEvent = (event: ExecutorEvent) => setRecoveryEvents((prev) => [...prev.slice(-7), event])
                    if (passkeyRecovery) {
                      const owner = await unlockLightWithPasskey(recoveryFile)
                      try {
                        await executeLightRecoveryWithOwner(recoveryFile, owner, controller.signal, onEvent)
                      } finally {
                        owner.fill(0)
                      }
                    } else await executeLightRecovery(recoveryFile, confirmation, controller.signal, onEvent)
                    setNotice('Bitcoin recovery completed')
                  } catch (error) {
                    if (!(error instanceof Error) || error.name !== 'AbortError') throw error
                    setNotice('Recovery paused. Reopen your saved exit file to resume.')
                  } finally {
                    recoveryController.current = null
                    setConfirmation('')
                  }
                })
              }
            />
          ) : (
            <QgPrimary
              label='Prepare emergency exit'
              loading={busy}
              disabled={!passkeyRecovery && !confirmation}
              onClick={() =>
                void run(async () => {
                  let next: LightRecoveryFile
                  if (passkeyRecovery) {
                    const owner = await unlockLightWithPasskey(recoveryFile)
                    try {
                      next = await prepareLightRecoveryWithOwner(
                        recoveryFile,
                        owner,
                        recoveryDestination.trim(),
                        recoveryFile.archive,
                        useSavedRecovery,
                      )
                    } finally {
                      owner.fill(0)
                    }
                  } else
                    next = await prepareLightRecoveryWithSecret(
                      recoveryFile,
                      confirmation,
                      recoveryDestination.trim(),
                      useSavedRecovery,
                    )
                  if (!next.exitPackage) throw new Error('No unspent Light outputs were found')
                  setExitStep('review')
                  setRecoveryFile(next)
                  downloadJSON(next, `vaulted-light-exit-${next.descriptor.vaultId.slice(0, 8)}.json`)
                })
              }
            />
          )
        }
      >
        <p className='qg-eyebrow'>Owner recovery</p>
        <h1>Recover to Bitcoin</h1>
        <p className='qg-copy'>
          {passkeyRecovery
            ? 'Use your passkey to unlock the backup and recover directly to Bitcoin.'
            : 'Use your saved recovery code to recover without your passkey.'}{' '}
          A prepared exit needs only a Bitcoin explorer. Saved transaction paths let you prepare an exit while the
          Operator is unavailable.
        </p>
        {!recoveryFile.exitPackage ? (
          <label className='light-field'>
            Bitcoin address to recover to
            <input
              value={recoveryDestination}
              onChange={(e) => setRecoveryDestination(e.target.value)}
              autoComplete='off'
              spellCheck={false}
            />
          </label>
        ) : (
          <>
            <p className='qg-copy'>Recover to this Bitcoin address:</p>
            <p className='light-address'>{recoveryFile.exitPackage.sweepAddress}</p>
          </>
        )}
        {!recoveryFile.exitPackage ? (
          <label className='light-field light-checkbox'>
            <input
              type='checkbox'
              checked={useSavedRecovery}
              onChange={(event) => setUseSavedRecovery(event.target.checked)}
            />
            Use saved recovery data without contacting the Operator
          </label>
        ) : recoveryFile.archive ? (
          <p className='qg-copy'>
            Recovery data saved {new Date(recoveryFile.archive.capturedAt).toLocaleString()}. Payments received or sent
            after that time are not covered by this file.
          </p>
        ) : null}
        {!passkeyRecovery ? (
          <label className='light-field'>
            Recovery code
            <textarea
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete='off'
              spellCheck={false}
            />
          </label>
        ) : null}
        {recoveryFile.exitPackage ? (
          <>
            <div className='light-panel'>
              <div>
                <strong>{sats(recoveryFile.exitPackage.totals.recoveredSats)} to recover</strong>
                <p>Estimated network fees: {sats(recoveryFile.exitPackage.totals.totalFeeSats)}</p>
                <p>
                  Owner-only delay: {lightExitDelayLabel(recoveryFile.descriptor.exitDelaySeconds)}. Bitcoin
                  confirmation times are additional.
                </p>
                <p>
                  Provide at least {sats(recoveryFile.exitPackage.totals.fundingRequiredSats)} in Bitcoin for recovery
                  fees at the address below. Fees are separate from your spending balance.
                </p>
              </div>
            </div>
            {exitStep === 'fund' ? (
              <>
                <p className='light-address'>{recoveryFile.feeFundingAddress}</p>
                <QgSecondary
                  label='Copy fee funding address'
                  onClick={() => void copy(recoveryFile.feeFundingAddress!)}
                />
                <p className='qg-copy'>
                  The fee address belongs to your recovered owner key. Recovery broadcasts Bitcoin transactions and
                  waits for confirmations and the exit delay. Keep this page open, or reopen the saved file later to
                  resume. Stopping does not undo transactions already broadcast.
                </p>
                <QgSecondary
                  label='Save prepared exit file'
                  onClick={() =>
                    downloadJSON(recoveryFile, `vaulted-light-exit-${recoveryFile.descriptor.vaultId.slice(0, 8)}.json`)
                  }
                />
              </>
            ) : null}
          </>
        ) : (
          <p className='qg-copy'>
            This file contains your encrypted key but no prepared exit. Vaulted will fetch the current transaction paths
            and create a signed recovery file before anything is broadcast.
          </p>
        )}
        {busy && recoveryController.current ? (
          <QgSecondary label='Stop and resume later' onClick={() => recoveryController.current?.abort()} />
        ) : null}
        <details className='qg-guidance'>
          <summary>Recovery progress and transactions</summary>
          <div className='light-recovery-log' role='log' aria-live='polite'>
            {Array.from(
              new Map(
                recoveryEvents.map((event) => [`${event.stepIndex}:${event.status}:${event.txid ?? ''}`, event]),
              ).entries(),
            ).map(([key, event]) => {
              const explorer = event.txid
                ? vaultTransactionExplorer(event.txid, 'onchain', recoveryFile.descriptor.network)
                : null
              return (
                <div key={key}>
                  <p className='qg-copy'>{lightRecoveryProgress(event)}</p>
                  {explorer ? (
                    <a className='light-address' href={explorer.url} target='_blank' rel='noopener noreferrer'>
                      {event.txid}
                    </a>
                  ) : null}
                </div>
              )
            })}
          </div>
        </details>
      </QgScreen>
    )
  else if (view === 'home' && record)
    content = (
      <Content className='qg-home-content' onRefresh={() => run(refresh)}>
        <main className='qg-home'>
          {accountHeader('Spending')}
          {balance(snapshot ? snapshot.balance + (snapshot.pendingBalance || 0) : null, 'Spending')}
          <div className='qg-actions'>
            <button type='button' disabled={busy || !status || !snapshot?.balance} onClick={() => navigate('send')}>
              <span>
                <ArrowUpRight />
                <b>Send</b>
              </span>
            </button>
            <button type='button' disabled={busy || !status} onClick={() => navigate('receive')}>
              <span>
                <ArrowDownLeft />
                <b>Receive</b>
              </span>
            </button>
          </div>
          {snapshot?.pendingBalance ? (
            <p className='qg-available'>
              {sats(snapshot.balance)} available · {sats(snapshot.pendingBalance)} pending
            </p>
          ) : null}
          {coverage?.cancelling ? (
            <p className='qg-copy' role='status'>
              Guardian is resolving a previous renewal. Payments may be temporarily unavailable.
            </p>
          ) : null}
          <p className='qg-copy light-allowance'>
            {status ? sats(status.periodRemaining) : '…'} remaining in your limit
          </p>
          {cloudError ? (
            <p className='qg-copy' role='status'>
              Cloud backup needs attention. Open Security to retry.
            </p>
          ) : null}
          {renewalTiming?.due && (!coverage?.available || coverage.pending > 0) ? (
            <div className='light-panel'>
              <Clock3 />
              <div>
                <strong>{renewalTiming.expired ? 'Check expired Spending' : 'Spending needs renewal soon'}</strong>
                <p>
                  {renewalTiming.expired
                    ? 'Some Spending has expired. Open Security to check your recovery options.'
                    : `Some funds still need renewal authorization. The next expiry is ${new Date(renewalTiming.expiresAt!).toLocaleString()}. Open Security to check coverage.`}
                </p>
              </div>
            </div>
          ) : null}
          {recoveryDataError ? <p className='qg-copy'>{recoveryDataError}</p> : null}
          {status && loadPersistedVtxoSpend(status.vaultId) ? (
            <QgSecondary
              label='Resume pending payment'
              onClick={() =>
                void run(async () => {
                  await refresh()
                  const p = loadPersistedVtxoSpend(status.vaultId)
                  if (p) {
                    setQuote(quoteFromPersistedVtxoSpend(p))
                    setView('review')
                  } else setNotice('Payment reconciled')
                })
              }
            />
          ) : null}
          {activity(snapshot?.history || [], 'spend', snapshot !== null)}
        </main>
      </Content>
    )
  else if (view === 'receive' && status)
    content = (
      <QgScreen
        title='Receive'
        dismiss={() => navigate('home')}
        footer={
          <QgPrimary
            label='Copy receiving address'
            icon={<Copy />}
            onClick={() => void run(() => copy(String(status.spendingArkAddress)))}
          />
        }
      >
        <div className='qg-receive'>
          <p className='qg-eyebrow'>Spending · Arkade</p>
          <div className='qg-qr'>
            <QrCode large value={String(status.spendingArkAddress)} />
          </div>
          <p className='light-address'>{status.spendingArkAddress}</p>
          <p className='qg-copy'>Send from a wallet that supports Arkade. This is an Arkade receiving address.</p>
        </div>
      </QgScreen>
    )
  else if (view === 'scan-send')
    content = (
      <Scanner
        label='Scan address'
        close={() => navigate('send')}
        manual={() => navigate('send')}
        onError={() => setError('Camera unavailable. Enter the address manually.')}
        onData={(value) => {
          setAddress(value.trim())
          navigate('send')
        }}
      />
    )
  else if (view === 'send' && status && record)
    content = (
      <QgScreen
        title='Send'
        dismiss={() => navigate('home')}
        footer={
          <QgPrimary
            label='Review payment'
            loading={busy}
            disabled={!address || !amount}
            onClick={() =>
              void run(async () => {
                const q = await reserveVaultVtxo(record.enrollment, status, address, Number(amount))
                setQuote(q)
                setView('review')
              })
            }
          />
        }
      >
        <h1>Send bitcoin</h1>
        <QgTextButton label='Scan address' onClick={() => navigate('scan-send')} />
        <div className='light-fields'>
          <label>
            Arkade address
            <textarea
              value={address}
              autoCapitalize='none'
              autoCorrect='off'
              onChange={(e) => setAddress(e.target.value)}
              autoComplete='off'
              spellCheck={false}
            />
          </label>
          <label>
            Amount, in sats
            <input
              inputMode='numeric'
              type='number'
              min='330'
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
        </div>
        <p className='qg-copy'>
          Up to {sats(status.txCap)} per payment. You will see the network fee before approving.
        </p>
      </QgScreen>
    )
  else if (view === 'review' && quote && status && record)
    content = (
      <QgScreen
        title='Review payment'
        back={() => navigate('send')}
        footer={
          <QgPrimary
            label={`Approve ${sats(quote.amountSats)}`}
            loading={busy}
            onClick={() =>
              void run(async () => {
                const result = await sendVaultVtxo(
                  record.enrollment,
                  status,
                  quote,
                  guardianRenewalSpendUnlocker(record.descriptor),
                )
                setLastTx(result.txid)
                setView('success')
                setAddress('')
                setAmount('')
                setQuote(null)
                await refresh()
              })
            }
          />
        }
      >
        <p className='qg-eyebrow'>You are sending</p>
        <h1>{sats(quote.amountSats)}</h1>
        <div className='light-panel'>
          <div>
            <small>To</small>
            <p className='light-address'>{quote.destAddress}</p>
            <p>Network fee: {sats(quote.feeSats)}</p>
            <strong>Total: {sats(quote.amountSats + quote.feeSats)}</strong>
          </div>
        </div>
        <p className='qg-copy'>Approve with your passkey to send this payment.</p>
      </QgScreen>
    )
  else if (view === 'success')
    content = (
      <QgScreen
        title='Payment sent'
        footer={<QgPrimary label='Done' disabled={busy} onClick={() => navigate('home')} />}
      >
        <span className='light-success'>
          <Check />
        </span>
        <h1>Payment sent</h1>
        <TransactionReference
          txid={lastTx}
          explorer={status ? vaultTransactionExplorer(lastTx, 'arkade', status.network) : null}
        />
      </QgScreen>
    )
  else if (view === 'savings' && record)
    content = (
      <Content className='qg-home-content' onRefresh={openSavings}>
        <main className='qg-home'>
          {accountHeader('Savings')}
          {watched ? balance(savings?.balance ?? null, 'Savings') : null}
          <p className='qg-copy light-allowance'>
            <Eye size={16} aria-hidden /> Watch only
          </p>
          {!watched ? <p className='qg-copy'>See Savings held in another Bitcoin wallet.</p> : null}
          <div className='qg-actions'>
            <button
              type='button'
              disabled={busy}
              onClick={() => {
                setWatchAddress(watched?.address || '')
                navigate('savings-address')
              }}
            >
              <span>
                {watched ? <Pencil /> : <Plus />}
                <b>{watched ? 'Edit address' : 'Add address'}</b>
              </span>
            </button>
            {watched ? (
              <button type='button' onClick={() => void run(() => copy(watched.address))}>
                <span>
                  <Copy />
                  <b>Copy address</b>
                </span>
              </button>
            ) : null}
          </div>
          {watched ? activity(savings?.history || [], 'savings', savings !== null) : null}
        </main>
      </Content>
    )
  else if (view === 'savings-address' && record)
    content = (
      <QgScreen
        title='Savings address'
        back={() => navigate('savings')}
        footer={
          <QgPrimary
            label={watched ? 'Update watched address' : 'Watch this address'}
            loading={busy}
            disabled={!watchAddress}
            onClick={() =>
              void run(async () => {
                const next = saveWatchedSavings(
                  record.descriptor.vaultId,
                  { address: watchAddress.trim(), network: record.descriptor.network, label: 'External savings' },
                  record.descriptor.network,
                )
                setWatched(next)
                setSavings(null)
                setSavings(await fetchWatchedSavings(next, record.descriptor.network))
                setWatchAddress('')
                setView('savings')
              })
            }
          />
        }
      >
        <h1>Watch your Savings</h1>
        <p className='qg-copy'>
          Add a receiving address from another Bitcoin wallet. That wallet controls spending and recovery.
        </p>
        <label className='light-field'>
          Bitcoin receiving address
          <input
            value={watchAddress}
            onChange={(e) => setWatchAddress(e.target.value)}
            autoComplete='off'
            spellCheck={false}
          />
        </label>
        <p className='qg-copy'>
          Only this address is watched. Other addresses and change in the external wallet are not included. Checking it
          shares the address with the configured Bitcoin explorer.
        </p>
      </QgScreen>
    )
  else if (view === 'settings' && record)
    content = (
      <VaultSettings
        light={{
          status,
          busy,
          onClose: () => navigate(settingsReturn),
          refresh: () =>
            run(async () => {
              await refresh()
              if (watched) setSavings(await fetchWatchedSavings(watched, record.descriptor.network))
              setNotice('Balance updated')
            }),
          lock: () => void lock(),
        }}
      />
    )
  else if (view === 'security' && record)
    content = (
      <QgScreen
        title={
          securitySection === 'overview'
            ? 'Security'
            : securitySection === 'access'
              ? 'Access and limits'
              : securitySection === 'renewal'
                ? 'Renewal'
                : 'Backups'
        }
        back={() => (securitySection === 'overview' ? navigate('home') : setSecuritySection('overview'))}
        footer={<QgSecondary label='Lock wallet' onClick={() => void lock()} />}
      >
        {securitySection === 'overview' ? (
          <div className='qg-setup-options'>
            <button type='button' onClick={() => setSecuritySection('access')}>
              <strong>Access and limits</strong>
              <small>Passkey and payment limits</small>
            </button>
            <button type='button' onClick={() => setSecuritySection('renewal')}>
              <strong>Automatic renewal</strong>
              <small>
                {coverage?.available ? `${coverage.scheduled} of ${coverage.total} scheduled` : 'Check coverage'}
              </small>
            </button>
            <button type='button' onClick={() => setSecuritySection('backup')}>
              <strong>Backups</strong>
              <small>{cloudError ? 'Needs attention' : 'Cloud and local recovery data'}</small>
            </button>
          </div>
        ) : null}
        {securitySection === 'access' ? (
          <>
            <h1>Access and limits</h1>
            <div className='light-panel'>
              <ShieldCheck />
              <div>
                <strong>Spending limits</strong>
                <p>
                  {sats(record.descriptor.spendingPolicy.txRecipientCapSats)} per payment
                  <br />
                  {sats(record.descriptor.spendingPolicy.periodAllowanceSats)} in a rolling 24 hours
                </p>
              </div>
            </div>
            <p className='qg-copy'>
              Your passkey unlocks the owner key on this device. Vaulted checks normal payments before cosigning. The
              delayed Bitcoin exit belongs to the owner key and does not enforce these payment limits.
            </p>
          </>
        ) : null}
        {securitySection === 'renewal' ? (
          <>
            <div className='light-panel'>
              <Clock3 />
              <div>
                <strong>Automatic renewal</strong>
                <p>
                  {coverage?.available
                    ? `${coverage.scheduled} of ${coverage.total} outputs scheduled; ${coverage.renewing} awaiting renewal confirmation.`
                    : 'Guardian automatic renewal is not currently available for this wallet.'}
                </p>
                {coverage?.checkedAt ? <p>Last checked: {new Date(coverage.checkedAt).toLocaleString()}.</p> : null}
                {coverage?.cancelling ? (
                  <p>
                    {coverage.cancelling} outputs awaiting cancellation confirmation. Guardian retains the reservation
                    while the outcome is uncertain.
                  </p>
                ) : null}
                {coverage?.pending ? (
                  <p>
                    {coverage.pending} outputs need authorization or complete transaction paths. Eligible outputs are
                    authorized during your next normal unlock or payment.
                  </p>
                ) : null}
                {coverage?.error ? <p role='status'>{coverage.error}</p> : null}
                <details className='qg-guidance'>
                  <summary>How renewal works</summary>
                  <p>
                    Scheduled outputs can renew while this wallet is closed. New receipts and replacement outputs need
                    your next normal unlock or payment before another renewal can be scheduled.
                  </p>
                  <p>
                    {renewalTiming?.expiresAt
                      ? `Next expiry: ${new Date(renewalTiming.expiresAt).toLocaleString()}.`
                      : snapshot?.balance
                        ? 'Checking the next expiry…'
                        : 'Expiry dates appear after you receive bitcoin.'}
                  </p>
                  {renewalTiming?.incomplete ? (
                    <p>Some expiry dates are unavailable. Reconnect to check them.</p>
                  ) : null}
                  <p>The same spending limits apply. You can also renew here when needed.</p>
                </details>
              </div>
            </div>
            <QgSecondary
              label='Renew Spending'
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!status) throw new Error('Unlock the wallet first')
                  const result = await renewLightSpending(
                    record,
                    status,
                    (plan) =>
                      new Promise<boolean>((resolve) => {
                        setNotice('')
                        setRenewalReview(plan)
                        renewalApproval.current = (accepted) => {
                          renewalApproval.current = null
                          setRenewalReview(null)
                          resolve(accepted)
                        }
                      }),
                    setNotice,
                  )
                  await refresh()
                  setNotice(
                    result.state === 'confirmed'
                      ? 'Spending renewed'
                      : ['cancelled', 'released', 'rejected'].includes(result.state)
                        ? 'Renewal stopped. Your bitcoin stays in this wallet.'
                        : 'Renewal submitted. Use Check renewal to confirm it has completed.',
                  )
                })
              }
            />
            <QgSecondary
              label='Check renewal'
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await checkLightRenewal(record)
                  await refresh()
                  setNotice(
                    !result
                      ? 'No renewal is waiting'
                      : result.state === 'confirmed'
                        ? 'Spending renewed'
                        : ['cancelled', 'released', 'rejected'].includes(result.state)
                          ? 'The earlier renewal is closed. You can start again.'
                          : result.state === 'waiting_expiry'
                            ? 'The earlier request is expiring. Check again in a few minutes.'
                            : 'The earlier renewal is still being checked. Your funds remain reserved until its outcome is known.',
                  )
                })
              }
            />
          </>
        ) : null}
        {securitySection === 'backup' ? (
          <>
            <h2>Wallet backup</h2>
            <p className='qg-copy'>
              {cloudError ||
                (cloudSavedAt
                  ? `Encrypted cloud backup saved ${new Date(cloudSavedAt).toLocaleString()}.`
                  : 'Unlock with your passkey to enable automatic cloud backup.')}
            </p>
            <QgSecondary
              label='Update cloud backup'
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const session = await openLightCloudBackup(record, authorizeRenewals)
                  cloudSession.current = session
                  if (!status) throw new Error('Open the wallet before saving a backup')
                  const archive = await captureCurrent(record, status)
                  const saved = await syncLightCloudBackup(session, archive)
                  setCloudSavedAt(saved.createdAt)
                  setCloudError('')
                })
              }
            />
            <QgSecondary label='Save a local backup' disabled={busy} onClick={() => void saveLocalBackup()} />
            <p className='qg-copy'>
              Your backup includes the saved transaction paths for a unilateral Bitcoin exit. Your passkey unlocks it;
              Vaulted cannot decrypt it. Keep access to your passkey provider.
            </p>
            <p className='qg-copy'>
              A local file covers activity up to the time it was saved. Bitcoin recovery requires network fees and the
              exit waiting period.
            </p>
            <p className='qg-copy'>
              {recoveryDataError ||
                (recoveryDataDate
                  ? `Transaction paths saved on this device ${new Date(recoveryDataDate).toLocaleString()}.`
                  : 'Saving transaction paths…')}
            </p>
          </>
        ) : null}
        {securitySection === 'overview' ? (
          <>
            <QgTextButton
              label='Recover directly to Bitcoin'
              onClick={() =>
                void run(async () => {
                  const archive = await loadLightRecoveryArchive(record.descriptor)
                  if (!archive) throw new Error('Import a current backup to recover')
                  setRecoveryFile({
                    ...record,
                    name: 'vaulted-light-recovery',
                    version: 1,
                    createdAt: archive.capturedAt,
                    archive,
                  })
                  setPasskeyRecovery(true)
                  setUseSavedRecovery(true)
                  setExitStep('review')
                  setView('emergency')
                })
              }
            />
            <QgTextButton label='Switch wallet' onClick={onExit} />
          </>
        ) : null}
      </QgScreen>
    )
  else if (view === 'tx' && selectedTx && record) {
    const link = vaultTransactionExplorer(
      selectedTx.txid,
      selectedTx.account === 'savings' ? 'onchain' : 'arkade',
      record.descriptor.network,
    )
    content = (
      <QgScreen title='Transaction' back={() => navigate(selectedTx.account === 'savings' ? 'savings' : 'home')}>
        <span className='light-success'>{selectedTx.confirmed ? <Check /> : <Clock3 />}</span>
        <h1>{selectedTx.confirmed ? 'Confirmed' : 'Pending'}</h1>
        <p className='qg-copy'>
          {selectedTx.type === 'sent' ? 'Sent' : 'Received'} · {sats(selectedTx.displayAmount ?? selectedTx.amount)}
        </p>
        <TransactionReference txid={selectedTx.txid} explorer={link} />
      </QgScreen>
    )
  } else
    content = (
      <QgScreen title='Vaulted'>
        <p className='qg-copy'>Loading your wallet…</p>
        <QgSecondary label='Return' onClick={() => navigate(record ? 'unlock' : 'setup')} />
      </QgScreen>
    )
  if (renewalReview)
    content = (
      <QgScreen
        title='Review renewal'
        back={() => renewalApproval.current?.(false)}
        footer={<QgPrimary label='Confirm renewal' onClick={() => renewalApproval.current?.(true)} />}
      >
        <h1>Keep your Spending active</h1>
        <p className='qg-copy'>
          Your bitcoin returns to the same Spending wallet with a new expiry date and the same payment limits.
        </p>
        <div className='light-panel'>
          <div>
            <p>Amount renewed</p>
            <strong>{sats(renewalReview.valueSats)}</strong>
            <p>Renewal fee</p>
            <strong>{sats(renewalReview.feeSats)}</strong>
            <p>Amount after renewal</p>
            <strong>{sats(renewalReview.receiverSats)}</strong>
          </div>
        </div>
        <p className='qg-copy'>
          Only the fee counts against your daily limit. Keep this page open until submission completes.
        </p>
        <QgSecondary label='Cancel' onClick={() => renewalApproval.current?.(false)} />
      </QgScreen>
    )
  return (
    <WalletHelpContext.Provider
      value={{
        light: true,
        restore: () => {
          setRestoreMethod('choose')
          navigate('restore')
        },
      }}
    >
      <div ref={root} className='light-app' data-testid='vault-light' {...intent}>
        {content}
        {record && !renewalReview && (view === 'home' || view === 'savings') ? (
          <VaultLauncher
            disabled={busy}
            account={view === 'savings' ? 'savings' : 'spend'}
            balances={{
              spending: snapshot ? snapshot.balance + (snapshot.pendingBalance || 0) : null,
              savings: watched ? (savings?.balance ?? null) : 0,
            }}
            onAccount={(account) => {
              if (account === 'savings') void openSavings()
              else navigate('home')
            }}
            actions={[
              {
                id: 'settings',
                label: 'Settings',
                testId: 'tab-settings',
                icon: <SettingsIcon />,
                onClick: () => {
                  setSettingsReturn(view === 'savings' ? 'savings' : 'home')
                  navigate('settings')
                },
              },
              {
                id: 'security',
                label: 'Security',
                testId: 'tab-vault',
                icon: <Shield />,
                onClick: () => navigate('security'),
              },
            ]}
          />
        ) : null}
        {error ? (
          <div className='light-message' role='alert'>
            <span>{error}</span>
            <button type='button' aria-label='Dismiss error' onClick={() => setError('')}>
              ×
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className='light-message' role='status'>
            <span>{notice}</span>
            <button type='button' aria-label='Dismiss notice' onClick={() => setNotice('')}>
              ×
            </button>
          </div>
        ) : null}
      </div>
    </WalletHelpContext.Provider>
  )
}
