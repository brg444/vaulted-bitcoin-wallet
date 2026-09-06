import type { ExecutorEvent } from '@arkade-os/sdk'
import { networkPins } from '../../lib/vault/networkPins'
import { lightExitDelayLabel, lightRecoveryProgress } from '../../lib/vault/light/recoveryProgress'
import { checkLightRenewal, renewLightSpending } from '../../lib/vault/light/renewal'
import type { LightRenewalPlan } from '../../lib/vault/light/renewalTypes'
import { lightRenewalTiming } from '../../lib/vault/light/renewalTiming'
import { captureLightRecoveryArchive, validateLightRecoveryArchive } from '../../lib/vault/light/recoveryArchive'
import {
  prepareLightRecoveryFile,
  prepareLightRecoveryWithSecret,
  validateLightRecoveryFile,
  executeLightRecovery,
  type LightRecoveryFile,
} from '../../lib/vault/light/recovery'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Check, Clock3, Copy, Eye, Fingerprint, ShieldCheck } from 'lucide-react'
import QgScreen, { QgPrimary, QgSecondary, QgTextButton } from './qg/QgScreen'
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
import { unlockPhoneBip340 } from '../../lib/vault/savingsSpend'
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
  | 'unlock'
  | 'home'
  | 'receive'
  | 'send'
  | 'review'
  | 'success'
  | 'savings'
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
  const [view, setView] = useState<View>('setup')
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [policy, setPolicy] = useState<LightPolicy>(defaultLightPolicy('mainnet'))
  const [mode, setMode] = useState('token')
  const [available, setAvailable] = useState(false)
  const [setupExitDelay, setSetupExitDelay] = useState<number | null>(null)
  const [invite, setInvite] = useState('')
  const [pending, setPending] = useState<PendingLightEnrollment | null>(null)
  const [setupExpired, setSetupExpired] = useState(false)
  const restoreRead = useRef(0)
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
  const [recoveryDataError, setRecoveryDataError] = useState('')
  const recoveryController = useRef<AbortController | null>(null)
  useEffect(() => () => recoveryController.current?.abort(), [])
  useEffect(() => {
    if (!record || !status || view === 'unlock' || view === 'emergency') return
    let active = true
    const capture = () => {
      if (document.visibilityState === 'hidden') return
      void captureLightRecoveryArchive(record.descriptor)
        .then((archive) => {
          if (active) {
            setRecoveryDataDate(archive.capturedAt)
            setRenewalTiming(lightRenewalTiming(validateLightRecoveryArchive(archive, record.descriptor).coins))
            setRecoveryDataError('')
          }
        })
        .catch(() => {
          if (active) {
            setRenewalTiming(null)
            setRecoveryDataError(
              'Recovery data could not be updated. Keep this wallet open and reconnect before updating your recovery file.',
            )
          }
        })
    }
    capture()
    const timer = window.setInterval(capture, 30_000)
    window.addEventListener('focus', capture)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', capture)
    }
  }, [record, status?.vaultId, view === 'unlock', view === 'emergency', snapshot])

  useScreenMotion(root, renewalReview ? 'renewal-review' : view)
  const intent = useIntentPress(renewalReview ? 'renewal-review' : view)
  const navigate = (next: View) => {
    if (busyRef.current) return
    setError('')
    setNotice('')
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
          setView('backup')
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
  const unlock = () =>
    run(async () => {
      if (!record) throw new Error('Import your Light recovery file first')
      const st = lightStatusMatchesDescriptor(
        await fetchVaultStatusUnpinned(undefined, record.descriptor.vaultId),
        record.descriptor,
      )
      const secret = await unlockPhoneBip340(record.enrollment, st)
      secret.fill(0)
      setStatus(st)
      setWatched(loadWatchedSavings(st.vaultId, record.descriptor.network))
      setView('home')
      await refresh()
    })
  const backup = (saved: LightEnrollment) => {
    downloadJSON(
      { name: 'vaulted-light-recovery', version: 1, ...validateLightEnrollment(saved) },
      `vaulted-light-${saved.descriptor.vaultId.slice(0, 8)}.json`,
    )
    setDownloaded(true)
  }
  const openSavings = () =>
    run(async () => {
      setView('savings')
      setSavings(null)
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
  const activity = (rows: VaultHistoryItem[]) => (
    <div className='light-activity'>
      {rows.length ? (
        rows.map((tx) => (
          <button type='button' key={`${tx.account}:${tx.txid}`} onClick={() => openTransaction(tx)}>
            <span className='light-activity-icon'>{tx.confirmed ? <Check /> : <Clock3 />}</span>
            <span>
              <strong>{tx.type === 'sent' ? 'Sent' : 'Received'}</strong>
              <small>{tx.confirmed ? 'Confirmed' : 'Pending'}</small>
            </span>
            <strong>
              {tx.type === 'sent' ? '−' : '+'}
              {sats(tx.amount)}
            </strong>
          </button>
        ))
      ) : (
        <p className='qg-copy'>Your activity will appear here after your first transaction.</p>
      )}
    </div>
  )
  let content: React.ReactNode
  if (view === 'setup')
    content = (
      <QgScreen
        title='Vaulted Light'
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
                  const next = await beginLightEnrollment(policy, invite)
                  setPending(next.pending)
                  setRecoverySecret(next.recoverySecret)
                  setConfirmation('')
                  setDownloaded(false)
                  setBackupFileVerified(false)
                  setView('backup')
                })
              }
            />
            <QgTextButton label='Restore a Light wallet' onClick={() => navigate('restore')} />
          </>
        }
      >
        <p className='qg-eyebrow'>Light</p>
        <h1>Everyday bitcoin, with limits</h1>
        <p className='qg-copy'>
          Approve payments with your passkey. Vaulted checks each payment against the limits you choose, without needing
          a hardware key.
        </p>
        <div className='light-panel'>
          <ShieldCheck />
          <div>
            <strong>Two approvals for payments</strong>
            <p>
              Your device signs and Vaulted checks your limits before cosigning. The Arkade Operator completes the
              transaction.
            </p>
          </div>
        </div>
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
          {mode !== 'open' ? (
            <label>
              Invite code
              <input autoComplete='off' value={invite} onChange={(e) => setInvite(e.target.value)} />
            </label>
          ) : null}
        </div>
        <p className='qg-copy'>
          Save a recovery file and a separate recovery secret during setup. If you lose every copy of your passkey, both
          are needed to recover your wallet key.
        </p>
        <p className='qg-copy'>
          The owner key also has a Bitcoin exit that does not require Vaulted’s approval.
          {setupExitDelay
            ? ` It includes a waiting period of ${lightExitDelayLabel(setupExitDelay)} after the required Bitcoin transactions confirm, plus network fees.`
            : ''}{' '}
          Spending limits apply to normal payments, not this emergency exit.
        </p>
        <p className='qg-copy'>
          Savings can show a Bitcoin address from another wallet. That wallet keeps control of those funds.
        </p>
        {!available ? <p className='qg-copy'>Light is not available on this deployment yet.</p> : null}
      </QgScreen>
    )
  else if (view === 'backup' && pending)
    content = (
      <QgScreen
        title='Protect your access'
        footer={
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
        {recoverySecret ? (
          <div className='light-secret-label'>
            Recovery secret<code className='light-secret'>{recoverySecret}</code>
          </div>
        ) : (
          <p className='qg-copy'>Use the secret you saved before closing setup.</p>
        )}
        <p className='qg-copy'>
          The secret is shown during setup and is not saved in your browser. Keep it somewhere you can reach if you lose
          this device.
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
          This file restores your key. Emergency Bitcoin recovery also needs the transaction paths for your current
          balance, plus Bitcoin for network fees.
        </p>
      </QgScreen>
    )
  else if (view === 'unlock')
    content = (
      <QgScreen
        title='Vaulted Light'
        back={onExit}
        footer={
          <QgPrimary label='Unlock with passkey' loading={busy} icon={<Fingerprint />} onClick={() => void unlock()} />
        }
      >
        <p className='qg-eyebrow'>Welcome back</p>
        <h1>Your everyday wallet</h1>
        <p className='qg-copy'>Use face recognition, a fingerprint or your device PIN to unlock your wallet key.</p>
        <QgTextButton label='Restore from a recovery file' onClick={() => navigate('restore')} />
      </QgScreen>
    )
  else if (view === 'restore')
    content = (
      <QgScreen
        title='Restore Light'
        back={() => navigate(record ? 'unlock' : 'setup')}
        footer={
          <QgPrimary
            label='Verify file and unlock'
            loading={busy}
            disabled={!restoreRaw}
            onClick={() =>
              void run(async () => {
                const restored = validateLightEnrollment(JSON.parse(restoreRaw))
                const st = lightStatusMatchesDescriptor(
                  await fetchVaultStatusUnpinned(undefined, restored.descriptor.vaultId),
                  restored.descriptor,
                )
                const key = await unlockPhoneBip340(restored.enrollment, st)
                key.fill(0)
                localStorage.setItem(LIGHT_LOCAL_STORE, JSON.stringify(restored))
                setRecord(restored)
                setStatus(st)
                setView('home')
                setRestoreRaw('')
              })
            }
          />
        }
      >
        <h1>Bring your wallet back</h1>
        <p className='qg-copy'>
          Choose your Light recovery file and approve with the same passkey. Your receiving address and spending limits
          stay the same.
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
          label='I no longer have my passkey'
          disabled={!restoreRaw}
          onClick={() =>
            void run(async () => {
              const saved = validateLightRecoveryFile(JSON.parse(restoreRaw))
              setRecoveryFile(saved)
              setConfirmation('')
              setView('emergency')
            })
          }
        />
        <p className='qg-copy'>
          If you no longer have the passkey, use your recovery secret with the emergency recovery tools. A recovery
          secret does not create a replacement passkey for this wallet.
        </p>
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
          recoveryFile.exitPackage ? (
            <QgPrimary
              label='Start Bitcoin recovery'
              loading={busy}
              disabled={!confirmation}
              onClick={() =>
                void run(async () => {
                  const controller = new AbortController()
                  recoveryController.current = controller
                  setRecoveryEvents([])
                  try {
                    await executeLightRecovery(recoveryFile, confirmation, controller.signal, (event) =>
                      setRecoveryEvents((prev) => [...prev.slice(-7), event]),
                    )
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
              disabled={!confirmation}
              onClick={() =>
                void run(async () => {
                  const next = await prepareLightRecoveryWithSecret(
                    recoveryFile,
                    confirmation,
                    recoveryDestination.trim(),
                    useSavedRecovery,
                  )
                  if (!next.exitPackage) throw new Error('No unspent Light outputs were found')
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
          Use the secret you saved during setup to recover without your passkey. A prepared exit needs only a Bitcoin
          explorer. To prepare a new exit while the Operator is unavailable, use recovery data previously saved on this
          device or included in your file.
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
        <label className='light-field'>
          Recovery secret
          <textarea
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete='off'
            spellCheck={false}
          />
        </label>
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
            <p className='light-address'>{recoveryFile.feeFundingAddress}</p>
            <QgSecondary label='Copy fee funding address' onClick={() => void copy(recoveryFile.feeFundingAddress!)} />
            <p className='qg-copy'>
              The fee address belongs to your recovered owner key. Recovery broadcasts Bitcoin transactions and waits
              for confirmations and the exit delay. Keep this page open, or reopen the saved file later to resume.
              Stopping does not undo transactions already broadcast.
            </p>
            <QgSecondary
              label='Save prepared exit file'
              onClick={() =>
                downloadJSON(recoveryFile, `vaulted-light-exit-${recoveryFile.descriptor.vaultId.slice(0, 8)}.json`)
              }
            />
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
      </QgScreen>
    )
  else if (view === 'home' && record)
    content = (
      <QgScreen
        title='Vaulted Light'
        footer={
          <div className='light-actions'>
            <QgSecondary label='Savings' disabled={busy} onClick={() => void openSavings()} />
            <QgSecondary label='Security' disabled={busy} onClick={() => navigate('security')} />
          </div>
        }
      >
        <p className='qg-eyebrow'>Spending</p>
        <h1 className='light-balance'>{snapshot ? sats(snapshot.balance) : 'Updating…'}</h1>
        {snapshot?.pendingBalance ? <p className='qg-copy'>{sats(snapshot.pendingBalance)} pending</p> : null}
        <p className='qg-copy'>
          {status ? sats(status.periodRemaining) : '…'} available within your rolling 24-hour limit.
        </p>
        <div className='light-actions'>
          <QgPrimary
            label='Receive'
            icon={<ArrowDownLeft />}
            disabled={busy || !status}
            onClick={() => navigate('receive')}
          />
          <QgPrimary
            label='Send'
            icon={<ArrowUpRight />}
            disabled={busy || !status || !snapshot?.balance}
            onClick={() => navigate('send')}
          />
        </div>
        {renewalTiming?.due ? (
          <div className='light-panel'>
            <Clock3 />
            <div>
              <strong>{renewalTiming.expired ? 'Check expired Spending' : 'Spending needs renewal soon'}</strong>
              <p>
                {renewalTiming.expired
                  ? 'Some Spending has expired. Open Security to check your recovery options.'
                  : `The next expiry is ${new Date(renewalTiming.expiresAt!).toLocaleString()}. Open Security to renew before then.`}
              </p>
            </div>
          </div>
        ) : null}
        <h2>Activity</h2>
        {recoveryDataError ? <p className='qg-copy'>{recoveryDataError}</p> : null}
        {activity(snapshot?.history || [])}
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
      </QgScreen>
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
        <h1>Where is it going?</h1>
        <div className='light-fields'>
          <label>
            Arkade address
            <textarea
              value={address}
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
                const result = await sendVaultVtxo(record.enrollment, status, quote)
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
        <p className='qg-copy'>
          Your passkey approves this payment. Vaulted will independently check your spending limits.
        </p>
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
        <p className='light-address'>{lastTx}</p>
        {status && vaultTransactionExplorer(lastTx, 'arkade', status.network) ? (
          <a
            target='_blank'
            rel='noopener noreferrer'
            href={vaultTransactionExplorer(lastTx, 'arkade', status.network)!.url}
          >
            View on Arkade Space
          </a>
        ) : null}
      </QgScreen>
    )
  else if (view === 'savings' && record)
    content = (
      <QgScreen
        title='Savings'
        back={() => navigate('home')}
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
              })
            }
          />
        }
      >
        <p className='qg-eyebrow'>
          <Eye size={18} /> Watch only
        </p>
        <h1>{savings ? sats(savings.balance) : watched ? 'Balance unavailable' : 'Savings elsewhere'}</h1>
        <p className='qg-copy'>
          See a Bitcoin address from another wallet here. That wallet controls spending and recovery; its balance is
          separate from your Light spending balance and limits.
        </p>
        {watched ? (
          <>
            <p className='light-address'>{watched.address}</p>
            <h2>Activity</h2>
            {activity(savings?.history || [])}
          </>
        ) : null}
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
  else if (view === 'security' && record)
    content = (
      <QgScreen
        title='Security'
        back={() => navigate('home')}
        footer={
          <QgSecondary
            label='Lock wallet'
            onClick={() =>
              void run(async () => {
                await shutdownVaultWalletWorker(record.descriptor.vaultId)
                setSnapshot(null)
                setStatus(null)
                setView('unlock')
              })
            }
          />
        }
      >
        <p className='qg-eyebrow'>Light protection</p>
        <h1>Your access and limits</h1>
        <div className='light-panel'>
          <ShieldCheck />
          <div>
            <strong>Passkey + policy cosigner</strong>
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
        <div className='light-panel'>
          <Clock3 />
          <div>
            <strong>Keep Spending active</strong>
            <p>
              {renewalTiming?.expiresAt
                ? `Next expiry: ${new Date(renewalTiming.expiresAt).toLocaleString()}.`
                : snapshot?.balance
                  ? 'Checking the next expiry…'
                  : 'Expiry dates appear after you receive bitcoin.'}
            </p>
            {renewalTiming?.incomplete ? <p>Some expiry dates are unavailable. Reconnect to check them.</p> : null}
            <p>Renew before expiry to keep payments available. The same spending limits still apply.</p>
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
        <label className='light-field'>
          Bitcoin recovery destination
          <input
            value={recoveryDestination}
            onChange={(e) => setRecoveryDestination(e.target.value)}
            autoComplete='off'
            spellCheck={false}
          />
        </label>
        <p className='qg-copy'>
          Use a receiving address from another wallet you control. The prepared emergency exit will send your recovered
          bitcoin there.
        </p>
        <QgSecondary
          label='Download recovery file'
          onClick={() =>
            void run(async () => {
              if (!status) throw new Error('Unlock the wallet first')
              const file = await prepareLightRecoveryFile(record, status, recoveryDestination.trim())
              downloadJSON(file, `vaulted-light-${record.descriptor.vaultId.slice(0, 8)}.json`)
              setNotice(
                file.exitPackage
                  ? 'Recovery file updated for your current balance'
                  : 'Recovery file saved. Update it after receiving funds.',
              )
            })
          }
        />
        <p className='qg-copy'>
          The file contains encrypted keys. Keep your recovery secret separately. Emergency recovery also needs current
          transaction paths and Bitcoin network fees. Download a new file after receiving, paying, or renewing.
        </p>
        <p className='qg-copy'>
          {recoveryDataError ||
            (recoveryDataDate
              ? `Recovery data saved on this device ${new Date(recoveryDataDate).toLocaleString()}. Keep an updated file elsewhere in case you lose this device.`
              : 'Saving recovery data on this device…')}
        </p>
        <QgTextButton label='Return to Standard / Advanced' onClick={onExit} />
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
          {selectedTx.type === 'sent' ? 'Sent' : 'Received'} · {sats(selectedTx.amount)}
        </p>
        <p className='light-address'>{selectedTx.txid}</p>
        {link ? (
          <a href={link.url} target='_blank' rel='noopener noreferrer'>
            {link.label}
          </a>
        ) : null}
      </QgScreen>
    )
  } else
    content = (
      <QgScreen title='Vaulted Light'>
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
    <div ref={root} className='light-app' data-testid='vault-light' {...intent}>
      {content}
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
  )
}
