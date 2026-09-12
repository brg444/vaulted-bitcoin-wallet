import { inspectRecoveryKit, parseRecoveryKit, isLedgerRecoveryKit } from '../../lib/vault/program/kit'
import QgGuidance from './qg/QgGuidance'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/vault/fiatDisplay'
import { useBalanceDenomination } from './AccountBalance'
import LedgerRecovery from './LedgerRecovery'
import { findMatureBoardingInputs } from '../../lib/vault/vtxo/boardingRecovery'
import { VaultContext } from '../../vault/context'
import { HubGroup, HubRow } from './ui'
import RecoveryCopies from './RecoveryCopies'
import { checkProtectedRecoveryPackage } from '../../lib/vault/recovery/packageCheck'
import { recordRecoveryCopy } from '../../lib/vault/recovery/copyStatus'
import WalletScreen from './qg/WalletScreen'
import { QgPrimary, QgSecondary } from './qg/QgScreen'
import { portableRecoverySource } from '../../lib/vault/recovery/portable'
import { spendingRecoveryCoverage } from '../../lib/vault/recovery/coverage'
import { vaultRecoveryBinding } from '../../lib/vault/vtxo/recoveryArchive'

function downloadJson(name: string, body: string) {
  const hidden = document.createElement('a')
  hidden.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
  hidden.download = name
  document.body.appendChild(hidden)
  hidden.click()
  hidden.remove()
}

function RecoverAlert({ text }: { text: string }) {
  if (!text) return null
  return (
    <p className='qg-copy' role='alert'>
      {text}
    </p>
  )
}

export default function VaultRecover() {
  const denomination = useBalanceDenomination()
  const money = (value: number) => formatMoney(value, denomination)
  const {
    backupRecoveryKit,
    backupRecoveryArchive,
    downloadRecoveryArchive,
    recoveryArchiveStatus,
    recoveryArchiveError,
    busy,
    downloadRecoveryKit,
    error,
    hasRecoveryKit,
    navigate,
    recoverEntry,
    recoverExit,
    recoverMatureBoarding,
    restoreRecoveryKit,
    status,
  } = useContext(VaultContext)
  const { toast } = useToast()
  const [backupView, setBackupView] = useState<
    'overview' | 'more' | 'kit' | 'cloud' | 'file' | 'inspect' | 'boarding' | 'exit'
  >(status?.protectionTier === 'light' && recoverEntry === 'lost' ? 'exit' : 'overview')
  const [view, setView] = useState<'kit' | 'lost'>(status?.protectionTier === 'light' ? 'kit' : recoverEntry)

  useEffect(() => {
    setView(status?.protectionTier === 'light' ? 'kit' : recoverEntry)
    if (status?.protectionTier === 'light' && recoverEntry === 'lost') setBackupView('exit')
  }, [recoverEntry, status?.protectionTier])
  const [pasted, setPasted] = useState('')
  const [protectedCheck, setProtectedCheck] = useState('')
  const [checkingPackage, setCheckingPackage] = useState(false)
  useEffect(() => setProtectedCheck(''), [pasted])
  const fileRead = useRef(0)
  useEffect(
    () => () => {
      fileRead.current++
    },
    [],
  )
  const [localError, setLocalError] = useState('')
  const [matureBoardingSats, setMatureBoardingSats] = useState(0)
  const [recoveringBoarding, setRecoveringBoarding] = useState(false)

  useEffect(() => {
    let active = true
    setMatureBoardingSats(0)
    if (view !== 'kit' || !status?.enrolled) return () => undefined
    void findMatureBoardingInputs(status)
      .then(({ totalSats }) => {
        if (active) setMatureBoardingSats(totalSats)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [status, view])

  const kitJson = useMemo(() => {
    try {
      return downloadRecoveryKit()
    } catch {
      return ''
    }
  }, [downloadRecoveryKit])

  const currentKit = useMemo(() => {
    try {
      return parseRecoveryKit(JSON.parse(kitJson))
    } catch {
      return null
    }
  }, [kitJson])
  const report = useMemo(() => {
    const raw = pasted.trim() || kitJson
    if (!raw) return null
    try {
      const data = JSON.parse(raw)
      if (data?.name === 'vaulted-recovery-package') {
        const source = portableRecoverySource(data)
        return {
          ...inspectRecoveryKit(source.header.kit),
          coverage: spendingRecoveryCoverage(
            source.archive.spending,
            vaultRecoveryBinding(source.header.kit, source.header.status),
            null,
          ),
        }
      }
      return inspectRecoveryKit(parseRecoveryKit(data))
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'That file is not a Recovery Kit' }
    }
  }, [kitJson, pasted])

  useEffect(() => {
    if (!pasted.trim() || !status) return
    let source
    try {
      source = portableRecoverySource(JSON.parse(pasted))
    } catch {
      return
    }
    if (source.header.binding.vaultId !== status.vaultId || source.header.binding.network !== status.network) return
    void recordRecoveryCopy(status.vaultId, status.network, 'checked', source.archive.spending).catch(() =>
      setLocalError('The file was checked, but its check date could not be saved.'),
    )
  }, [pasted, status?.vaultId, status?.network])

  const saveKit = () => {
    setLocalError('')
    try {
      downloadJson('Recovery Kit.json', downloadRecoveryKit())
      toast('Download requested. Check your saved files.')
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'No Recovery Kit yet')
    }
  }

  if (view === 'lost') {
    if (currentKit && isLedgerRecoveryKit(currentKit) && status)
      return <LedgerRecovery kit={currentKit} status={status} back={() => setView('kit')} />
    return (
      <WalletScreen title='Savings recovery' back={() => navigate(recoverExit)}>
        <p className='qg-copy' role='alert'>
          Open your enrolled Ledger account and retrieve its recovery package before continuing.
        </p>
        <QgSecondary label='Open backups' onClick={() => setView('kit')} />
      </WalletScreen>
    )
  }

  const fromHome = recoverExit === 'home'
  const runBackup = (action: () => Promise<unknown>) => {
    setLocalError('')
    void action().catch((err) => setLocalError(err instanceof Error ? err.message : 'Backup is unavailable'))
  }
  return (
    <WalletScreen
      title={
        backupView === 'overview'
          ? 'Backups'
          : backupView === 'more'
            ? 'More backup options'
            : backupView === 'kit'
              ? 'Wallet details'
              : backupView === 'cloud'
                ? 'Automatic backup'
                : backupView === 'file'
                  ? 'Save recovery package'
                  : backupView === 'boarding'
                    ? 'Recover received Bitcoin'
                    : backupView === 'exit'
                      ? 'Recover to Bitcoin'
                      : 'Check recovery package'
      }
      dismiss={backupView === 'overview' && fromHome ? () => navigate('home') : undefined}
      back={
        status?.protectionTier === 'light' && recoverEntry === 'lost' && backupView === 'exit'
          ? () => navigate(recoverExit)
          : backupView !== 'overview'
            ? () => setBackupView('overview')
            : fromHome
              ? undefined
              : () => navigate(recoverExit)
      }
      footer={
        <>
          <RecoverAlert text={error || localError || recoveryArchiveError} />
          {backupView === 'cloud' ? (
            <QgPrimary
              label='Enable encrypted automatic backup'
              disabled={busy}
              onClick={() => runBackup(backupRecoveryArchive)}
            />
          ) : backupView === 'file' ? (
            <QgPrimary
              label='Download recovery package'
              disabled={busy}
              onClick={() =>
                runBackup(async () => {
                  const body = await downloadRecoveryArchive('portable')
                  downloadJson('Vaulted recovery package.json', body)
                  const source = portableRecoverySource(JSON.parse(body))
                  await recordRecoveryCopy(
                    source.header.binding.vaultId,
                    source.header.binding.network,
                    'downloaded',
                    source.archive.spending,
                  )
                })
              }
            />
          ) : backupView === 'kit' ? (
            <QgPrimary
              label={hasRecoveryKit ? 'Download Recovery Kit' : 'Retrieve Recovery Kit'}
              testId={hasRecoveryKit ? 'download-recovery-kit' : 'restore-recovery-kit'}
              disabled={busy}
              onClick={() => (hasRecoveryKit ? saveKit() : runBackup(restoreRecoveryKit))}
            />
          ) : backupView === 'boarding' ? (
            <QgPrimary
              label={recoveringBoarding ? 'Recovering…' : 'Recover to this device'}
              testId='recover-mature-boarding-confirm'
              disabled={recoveringBoarding}
              loading={recoveringBoarding}
              onClick={() => {
                if (recoveringBoarding) return
                setRecoveringBoarding(true)
                setLocalError('')
                void recoverMatureBoarding()
                  .then((txid) => {
                    setMatureBoardingSats(0)
                    setBackupView('overview')
                    toast(`Recovery sent ${txid.slice(0, 8)}…`)
                  })
                  .catch((err) =>
                    setLocalError(err instanceof Error ? err.message : 'Could not recover received Bitcoin'),
                  )
                  .finally(() => setRecoveringBoarding(false))
              }}
            />
          ) : null}
        </>
      }
    >
      {backupView === 'overview' ? (
        <>
          <h1>Keep a copy outside this device</h1>
          {recoveryArchiveError && recoveryArchiveStatus ? <p className='qg-copy'>{recoveryArchiveStatus}</p> : null}
          <HubGroup>
            <HubRow title='Save recovery package' onClick={() => setBackupView('file')} />
            <HubRow
              title='Automatic encrypted backup'
              detail='Manage your backup with Vaulted'
              onClick={() => setBackupView('cloud')}
            />
            <HubRow title='Check a recovery package' onClick={() => setBackupView('inspect')} />
            {matureBoardingSats > 0 ? (
              <HubRow
                title='Recover received Bitcoin'
                detail={money(matureBoardingSats)}
                testId='recover-mature-boarding'
                onClick={() => setBackupView('boarding')}
              />
            ) : null}
          </HubGroup>
          <QgSecondary label='More options' onClick={() => setBackupView('more')} />
        </>
      ) : backupView === 'more' ? (
        <>
          <HubGroup>
            <HubRow
              title='Wallet details'
              detail='Public addresses and recovery rules'
              onClick={() => setBackupView('kit')}
            />
            <HubRow title='Recover to Bitcoin' onClick={() => setBackupView('exit')} />
            <HubRow
              title={currentKit?.protectionTier === 'light' ? 'Recover Spending' : 'I lost a key'}
              onClick={() => {
                setLocalError('')
                if (currentKit?.protectionTier === 'light') setBackupView('exit')
                else setView('lost')
              }}
            />
          </HubGroup>
          {status ? <RecoveryCopies vaultId={status.vaultId} network={status.network} /> : null}
        </>
      ) : backupView === 'kit' ? (
        <>
          <h1>Your wallet details</h1>
          <p className='qg-copy'>
            This public map records{' '}
            {currentKit?.protectionTier === 'light' ? 'Spending and Bitcoin deposit addresses' : 'Savings addresses'}{' '}
            and recovery rules. It contains no private keys and cannot move bitcoin by itself. Save a private copy
            outside this device.
          </p>
          <p className='qg-copy'>
            Save a recovery package to include Spending transaction data. This public file alone cannot recover
            Spending.
          </p>
          {hasRecoveryKit ? (
            <QgGuidance title='Save a public kit copy with the service'>
              <p>This stores the public vault map separately from the encrypted transaction backup.</p>
              <QgSecondary
                label='Save copy with Vault service'
                testId='backup-recovery-kit'
                disabled={busy}
                onClick={() =>
                  runBackup(async () => {
                    const pushed = await backupRecoveryKit()
                    toast(pushed ? 'Kit copy saved with the Vault service' : 'Kit saved on this device only')
                  })
                }
              />
            </QgGuidance>
          ) : null}
        </>
      ) : backupView === 'cloud' || backupView === 'file' ? (
        <>
          <h1>{backupView === 'cloud' ? 'Back up with Vaulted' : 'Save your recovery file'}</h1>
          <p className='qg-copy'>
            {backupView === 'file'
              ? 'Keep this file private. It includes your Bitcoin addresses; private keys remain encrypted.'
              : 'Your encrypted backup is saved with Vaulted while the wallet is open and unlocked. Your original passkey is required to restore it.'}
          </p>
          {backupView === 'cloud' ? (
            <QgGuidance title='Keep an independent copy'>
              <p>
                Save a recovery package outside Vaulted so your saved transaction data remains available if the service
                is down.
              </p>
            </QgGuidance>
          ) : (
            <QgGuidance title='What you need for recovery'>
              <p>
                Your original passkey unlocks private keys and payment journals. Advanced Spending can use its hardware
                and recovery keys without unlocking the phone.
              </p>
              <p>
                Keep the{' '}
                <a href='https://github.com/brg444/vaulted-emergency-recovery' target='_blank' rel='noreferrer'>
                  recovery application
                </a>{' '}
                with this file. Recovery also requires Bitcoin access, the relevant signing keys, fees and waiting
                periods.
              </p>
              <p>
                Save an updated package after payments or renewals. A file covers the data available when it was saved.
              </p>
            </QgGuidance>
          )}
          {backupView === 'file' ? (
            <QgGuidance title='Encrypted archive only'>
              <p>This older format requires your original passkey to access its Spending paths.</p>
              <QgSecondary
                label='Download encrypted recovery archive'
                disabled={busy}
                onClick={() =>
                  runBackup(async () =>
                    downloadJson('Vaulted encrypted recovery.json', await downloadRecoveryArchive()),
                  )
                }
              />
            </QgGuidance>
          ) : null}
          <p className='qg-copy'>
            {recoveryArchiveStatus ||
              (backupView === 'file'
                ? 'A file covers the data available when it is saved. Save an updated copy after activity.'
                : 'Approve with your passkey to enable automatic backup.')}
          </p>
        </>
      ) : backupView === 'exit' ? (
        <>
          <h1>Recover Spending independently</h1>
          <p className='qg-copy'>
            Use your saved recovery package and the independent recovery application to move eligible Spending funds to
            a Bitcoin address without new Guardian or Operator approval.
          </p>
          <p className='qg-copy'>
            {currentKit?.protectionTier === 'light'
              ? 'You need the saved wallet key unlocked by your original passkey. No hardware wallet is required.'
              : currentKit?.protectionTier === 'advanced'
                ? 'You need your hardware and recovery keys. The new portable package makes Spending paths accessible without unlocking the phone.'
                : 'You need the wallet key unlocked by your original passkey and your hardware key.'}
          </p>
          <p className='qg-copy'>
            Bitcoin fees and waiting periods apply. A file covers the paths saved at that time; later payments and
            renewals need updated data. Savings has different service requirements.
          </p>
          <QgPrimary label='Save recovery package' onClick={() => setBackupView('file')} />
          <p className='qg-copy'>
            <a href='https://github.com/brg444/vaulted-emergency-recovery' target='_blank' rel='noreferrer'>
              Get the recovery application and instructions
            </a>
          </p>
        </>
      ) : backupView === 'boarding' ? (
        <>
          <h1>Recover received Bitcoin</h1>
          <p className='qg-copy'>{money(matureBoardingSats)} has waited long enough for this recovery path.</p>
          <p className='qg-copy'>
            Your passkey will authorize a one-time recovery to this device. A network fee is deducted before the
            transaction is sent.
          </p>
        </>
      ) : (
        <>
          <h1>Check your saved file</h1>
          <p className='qg-copy'>
            Open a portable recovery package or public Recovery Kit. This checks saved data without restoring the wallet
            or broadcasting a transaction.
          </p>
          <label className='qg-field'>
            <span>Recovery file</span>
            <input
              type='file'
              accept='.json,application/json'
              onChange={(event) => {
                const revision = ++fileRead.current
                const file = event.target.files?.[0]
                setPasted('')
                if (!file) return
                if (file.size > 32_000_000) {
                  setLocalError('Choose a recovery file smaller than 32 MB')
                  return
                }
                setLocalError('')
                void file
                  .text()
                  .then((text) => {
                    if (revision === fileRead.current) setPasted(text)
                  })
                  .catch(() => {
                    if (revision === fileRead.current) setLocalError('Could not read this recovery file')
                  })
              }}
            />
          </label>
          <QgGuidance title='Paste recovery JSON'>
            <label className='qg-field'>
              <span>Recovery Kit JSON</span>
              <textarea
                value={pasted}
                data-testid='recovery-kit-json'
                onChange={(event) => {
                  fileRead.current++
                  setPasted(event.target.value)
                }}
              />
            </label>
          </QgGuidance>
          {report && 'coverage' in report && pasted.trim() ? (
            <p className='qg-copy'>
              This file contains Spending paths for {money(report.coverage.archivedSats)}, saved{' '}
              {new Date(report.coverage.capturedAt!).toLocaleString()}. This check does not establish coverage of later
              activity or verify access to your signing keys.
            </p>
          ) : null}
          {report && 'coverage' in report && pasted.trim() && status ? (
            <>
              <QgSecondary
                label='Check protected contents with passkey'
                disabled={checkingPackage}
                onClick={() => {
                  const revision = fileRead.current
                  setCheckingPackage(true)
                  setLocalError('')
                  void checkProtectedRecoveryPackage(JSON.parse(pasted), status)
                    .then(({ contents }) => {
                      if (revision !== fileRead.current) return
                      setProtectedCheck(
                        `Original passkey opened this file. It contains ${contents.pendingPayments} unresolved payment records and ${contents.lightningContracts} Lightning contract records. ${contents.journalsPresent ? '' : 'This older file has no complete payment journals. '}Hardware and recovery keys remain untested. No funds moved.`,
                      )
                    })
                    .catch((err) => {
                      if (revision === fileRead.current)
                        setLocalError(err instanceof Error ? err.message : 'Could not check protected contents')
                    })
                    .finally(() => setCheckingPackage(false))
                }}
              />
              {protectedCheck ? (
                <p className='qg-copy' role='status'>
                  {protectedCheck}
                </p>
              ) : null}
              <p className='qg-copy'>
                Spending needs{' '}
                {currentKit?.protectionTier === 'advanced'
                  ? 'hardware and recovery keys for the lost-phone path'
                  : 'the original passkey and hardware key'}
                . Savings recovery follows its enrolled service approvals and waiting periods. A file check leaves
                Bitcoin eligibility and external key access untested.
              </p>
            </>
          ) : null}
          {report && 'trees' in report && pasted.trim() ? (
            <p className='qg-copy'>
              This kit is for vault {report.vaultId.slice(0, 8)}… · {report.trees.length} addresses. Public scripts
              alone do not contain your Spending transaction paths.
            </p>
          ) : null}
          {report && 'error' in report && report.error && pasted.trim() ? <RecoverAlert text={report.error} /> : null}
        </>
      )}
    </WalletScreen>
  )
}
