import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { hex } from '@scure/base'
import { Fingerprint, FileKey, ShieldCheck } from 'lucide-react'
import { useToast } from '../../components/Toast'
import { copyToClipboard } from '../../lib/clipboard'
import { prettyAmount } from '../../lib/format'
import { broadcastTx, fetchAddressUtxos } from '../../lib/vault/esplora'
import { recoveryOnchainFeeSats, SAVINGS_CLAIM_VBYTES, SAVINGS_TRANSITION_VBYTES } from '../../lib/vault/onchainFee'
import { parseIncomingPsbt, psbtFile } from '../../lib/vault/savingsSpend'
import { familyClaimants, SAVINGS_TEMPLATE, type Claimant } from '../../lib/vault/program/constants'
import { familyFromDescriptor } from '../../lib/vault/program/descriptor'
import {
  acceptGuardianExitSignature,
  assertGuardianExitSigners,
  describeGuardianExitSigners,
  finalizeGuardianExit,
  requiredGuardianExitSigners,
} from '../../lib/vault/program/guardianExit'
import { inspectRecoveryKit, parseRecoveryKit } from '../../lib/vault/program/kit'
import { planClaim, planClawback, planInitiate } from '../../lib/vault/program/recoverFlow'
import { buildGuardianExitPsbt } from '../../lib/vault/program/spend'
import { findMatureBoardingInputs } from '../../lib/vault/vtxo/boardingRecovery'
import { VaultContext } from '../../vault/context'
import RecoveryHelp from './RecoveryHelp'
import { HubGroup, HubRow } from './ui'
import { useBackupConfirmation } from './qg/useBackupConfirmation'
import QgScreen, { QgCheck, QgPrimary, QgSecondary } from './qg/QgScreen'
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

function downloadPsbt(name: string, psbtHex: string) {
  const hidden = document.createElement('a')
  hidden.href = URL.createObjectURL(psbtFile(psbtHex, name))
  hidden.download = name
  document.body.appendChild(hidden)
  hidden.click()
  hidden.remove()
}

const KEY_LABEL: Record<Claimant, string> = {
  phone: 'Passkey access',
  hardware: 'Hardware wallet',
  recovery: 'Recovery key',
}

const KEY_DETAIL: Record<Claimant, string> = {
  phone: 'Use the passkey on this device',
  hardware: 'Use your hardware key',
  recovery: 'Use your separately stored recovery key',
}

const KEY_ICON: Record<Claimant, ReactNode> = {
  phone: <Fingerprint />,
  hardware: <ShieldCheck />,
  recovery: <FileKey />,
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
    initiateAlert,
    initiateAlerts,
    navigate,
    recoverEntry,
    recoverExit,
    recoverMatureBoarding,
    restoreRecoveryKit,
    savingsAddress,
    signGuardianExitWithDevice,
    status,
  } = useContext(VaultContext)
  const { toast } = useToast()
  const { confirmed, confirm } = useBackupConfirmation()
  const [backupView, setBackupView] = useState<'overview' | 'kit' | 'cloud' | 'file' | 'inspect' | 'boarding' | 'exit'>(
    'overview',
  )
  const [recoveryTask, setRecoveryTask] = useState<'cancel' | 'claim' | null>(null)
  const [view, setView] = useState<'kit' | 'lost'>(recoverEntry)
  const [reviewingRecovery, setReviewingRecovery] = useState(false)
  const [fromKit, setFromKit] = useState(false)

  useEffect(() => {
    setView(recoverEntry)
    setReviewingRecovery(false)
    setFromKit(false)
  }, [recoverEntry])
  const [pasted, setPasted] = useState('')
  const fileRead = useRef(0)
  useEffect(
    () => () => {
      fileRead.current++
    },
    [],
  )
  const [localError, setLocalError] = useState('')
  const [claimant, setClaimant] = useState<Claimant>('hardware')
  const [claimDest, setClaimDest] = useState('')
  const [psbtOut, setPsbtOut] = useState('')
  const [preparedAction, setPreparedAction] = useState<'initiate' | 'cancel' | 'claim' | null>(null)
  const [cancelPsbt, setCancelPsbt] = useState('')
  const [cancelSigners, setCancelSigners] = useState<Claimant[]>([])
  const [cancelHave, setCancelHave] = useState<Claimant[]>([])
  const [signedCancelPsbt, setSignedCancelPsbt] = useState('')
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
  const eligibleClaimants = currentKit ? familyClaimants(Boolean(currentKit.descriptor.keys.recovery)) : []

  const canCancelWithoutServices = useMemo(() => {
    try {
      return parseRecoveryKit(JSON.parse(downloadRecoveryKit())).descriptor.templateVersion === SAVINGS_TEMPLATE
    } catch {
      return false
    }
  }, [downloadRecoveryKit])

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

  const saveKit = () => {
    setLocalError('')
    try {
      downloadJson('Recovery Kit.json', downloadRecoveryKit())
      toast('Download requested. Check your saved files.')
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'No Recovery Kit yet')
    }
  }

  if (view === 'lost' && psbtOut && preparedAction && !cancelSigners.length)
    return (
      <QgScreen
        title={preparedAction === 'cancel' ? 'Cancellation prepared' : 'Recovery transaction prepared'}
        back={() => {
          setPsbtOut('')
          setPreparedAction(null)
        }}
        footer={
          <QgPrimary label='Save transaction file' onClick={() => downloadPsbt('Vaulted recovery.psbt', psbtOut)} />
        }
      >
        <h1>Continue with your signer</h1>
        <p className='qg-copy' data-testid='recovery-prepared'>
          {preparedAction === 'claim'
            ? 'Sign with the key that started recovery and submit after the waiting period ends.'
            : 'This transaction needs the selected eligible key and recovery service approvals before submission.'}{' '}
          Preparation has not moved funds. Recovery and cancellation take effect after Bitcoin confirmation.
        </p>
        <QgSecondary label='Copy transaction' onClick={() => void copyToClipboard(psbtOut)} />
      </QgScreen>
    )

  if (view === 'lost') {
    const inProcess = initiateAlerts[0]
    const externalRole = cancelSigners.find((role) => role !== 'phone' && !cancelHave.includes(role))
    const backToKit = fromKit || recoverEntry === 'kit'
    const fromHome = recoverExit === 'home'
    if (!inProcess && !reviewingRecovery) {
      return (
        <RecoveryHelp
          onBack={backToKit ? () => setView('kit') : fromHome ? undefined : () => navigate(recoverExit)}
          onDismiss={!backToKit && fromHome ? () => navigate('home') : undefined}
          protectionTier={currentKit?.protectionTier}
          templateVersion={currentKit?.descriptor.templateVersion}
          mainnet={currentKit?.descriptor.network === 'mainnet'}
          onPrepare={
            currentKit
              ? (key) => {
                  setClaimant(key)
                  setLocalError('')
                  setPsbtOut('')
                  setPreparedAction(null)
                  setReviewingRecovery(true)
                }
              : undefined
          }
        />
      )
    }
    if (inProcess && !recoveryTask)
      return (
        <QgScreen title='Active recovery' back={() => navigate(recoverExit)}>
          <h1>Recovery detected on Savings</h1>
          <p className='qg-copy'>{initiateAlert || 'Review the recovery and the keys available to cancel it.'}</p>
          <HubGroup>
            <HubRow title='Cancel this recovery' onClick={() => setRecoveryTask('cancel')} />
            <HubRow title='Claim after the waiting period' onClick={() => setRecoveryTask('claim')} />
          </HubGroup>
          <p className='qg-copy'>
            Use the eligible keys for your selected path. Preparing a transaction does not end the waiting period or
            cancel recovery.
          </p>
        </QgScreen>
      )
    return (
      <QgScreen
        title={fromHome && !backToKit ? 'Recovery' : 'Lost a key'}
        dismiss={!inProcess && !backToKit && fromHome ? () => navigate('home') : undefined}
        back={
          inProcess
            ? () => setRecoveryTask(null)
            : backToKit
              ? () => setView('kit')
              : fromHome
                ? undefined
                : () => navigate(recoverExit)
        }
        footer={
          inProcess ? (
            <>
              <RecoverAlert text={error || localError} />
              {recoveryTask === 'cancel' ? (
                <QgPrimary
                  label='Prepare cancellation'
                  testId='recover-clawback'
                  onClick={() => {
                    setLocalError('')
                    void (async () => {
                      try {
                        const [, c] = inProcess.familyKey.split('-') as ['savings', Claimant]
                        const kit = parseRecoveryKit(JSON.parse(downloadRecoveryKit()))
                        const built = planClawback({
                          family: familyFromDescriptor(kit.descriptor),
                          claimant: c,
                          coin: { txid: inProcess.txid, vout: inProcess.vout, value: inProcess.value },
                          feeSats: await recoveryOnchainFeeSats(SAVINGS_TRANSITION_VBYTES),
                          vaultId: kit.descriptor.vaultId,
                        })
                        setPsbtOut(built.psbtHex)
                        setPreparedAction('cancel')
                        await copyToClipboard(built.psbtHex)
                        toast('Cancellation transaction copied')
                      } catch (err) {
                        setLocalError(err instanceof Error ? err.message : 'Could not prepare cancellation')
                      }
                    })()
                  }}
                />
              ) : null}
              {recoveryTask === 'cancel' && canCancelWithoutServices ? (
                <QgSecondary
                  label='Cancel without services'
                  testId='recover-guardian-exit'
                  disabled={!claimDest.trim()}
                  onClick={() => {
                    setLocalError('')
                    void (async () => {
                      try {
                        const [, c] = inProcess.familyKey.split('-') as ['savings', Claimant]
                        const kit = parseRecoveryKit(JSON.parse(downloadRecoveryKit()))
                        if (kit.descriptor.templateVersion !== SAVINGS_TEMPLATE) {
                          throw new Error('this vault cannot cancel pending recovery without the services')
                        }
                        const hasRecovery = Boolean(kit.descriptor.keys.recovery)
                        const signers = requiredGuardianExitSigners(c, hasRecovery)
                        assertGuardianExitSigners(c, signers)
                        const built = buildGuardianExitPsbt({
                          family: familyFromDescriptor(kit.descriptor),
                          claimant: c,
                          coin: { txid: inProcess.txid, vout: inProcess.vout, value: inProcess.value },
                          destAddress: claimDest.trim(),
                          feeSats: await recoveryOnchainFeeSats(SAVINGS_CLAIM_VBYTES),
                          network: kit.descriptor.network,
                        })
                        setCancelPsbt(built.psbtHex)
                        setCancelSigners(signers)
                        setCancelHave([])
                        setSignedCancelPsbt('')
                        setPsbtOut(built.psbtHex)
                        setPreparedAction(null)
                        toast(`To cancel, ${describeGuardianExitSigners(signers)} must sign.`)
                      } catch (err) {
                        setLocalError(err instanceof Error ? err.message : 'Could not cancel without services')
                      }
                    })()
                  }}
                />
              ) : null}
              {recoveryTask === 'claim' ? (
                <QgPrimary
                  label='Prepare recovery transfer'
                  testId='recover-claim'
                  disabled={!claimDest.trim()}
                  onClick={() => {
                    setLocalError('')
                    void (async () => {
                      try {
                        const [, c] = inProcess.familyKey.split('-') as ['savings', Claimant]
                        const kit = parseRecoveryKit(JSON.parse(downloadRecoveryKit()))
                        const built = planClaim({
                          family: familyFromDescriptor(kit.descriptor),
                          claimant: c,
                          coin: { txid: inProcess.txid, vout: inProcess.vout, value: inProcess.value },
                          destAddress: claimDest.trim(),
                          feeSats: await recoveryOnchainFeeSats(SAVINGS_CLAIM_VBYTES),
                          network: kit.descriptor.network,
                        })
                        setPsbtOut(built.psbtHex)
                        setPreparedAction('claim')
                        await copyToClipboard(built.psbtHex)
                        toast('Recovery transfer copied')
                      } catch (err) {
                        setLocalError(err instanceof Error ? err.message : 'Could not prepare recovery transfer')
                      }
                    })()
                  }}
                />
              ) : null}
            </>
          ) : (
            <>
              <RecoverAlert text={error || localError} />
              <QgPrimary
                label='Prepare recovery'
                testId='recover-initiate'
                disabled={!eligibleClaimants.includes(claimant)}
                onClick={() => {
                  setLocalError('')
                  void (async () => {
                    try {
                      const kit = parseRecoveryKit(JSON.parse(downloadRecoveryKit()))
                      const family = familyFromDescriptor(kit.descriptor)
                      if (!savingsAddress) throw new Error('No Savings address yet')
                      const coin = (await fetchAddressUtxos(savingsAddress)).find(
                        (item) => item.status.confirmed && item.value > 1000,
                      )
                      if (!coin) throw new Error('No confirmed coin on that account')
                      const built = planInitiate({
                        family,
                        claimant,
                        coin: { txid: coin.txid, vout: coin.vout, value: coin.value },
                        feeSats: await recoveryOnchainFeeSats(SAVINGS_TRANSITION_VBYTES),
                        vaultId: kit.descriptor.vaultId,
                      })
                      setPsbtOut(built.psbtHex)
                      setPreparedAction('initiate')
                      await copyToClipboard(built.psbtHex)
                      toast('Recovery transaction copied')
                    } catch (err) {
                      setLocalError(err instanceof Error ? err.message : 'Could not prepare recovery')
                    }
                  })()
                }}
              />
            </>
          )
        }
      >
        <div className='vault-security'>
          <section className='vault-security-hero' aria-label='Recovery status'>
            <div className='vault-security-hero-head'>
              <strong>Recovery protection</strong>
              <span className={inProcess ? 'is-attention' : 'is-ready'}>{inProcess ? 'In process' : 'Idle'}</span>
            </div>
            <h2>{inProcess ? 'Recovery detected on Savings.' : 'Recover with a key you still control.'}</h2>
            <p>
              {inProcess
                ? initiateAlert || 'Review this recovery and the keys available to cancel it.'
                : 'Prepare a recovery transaction for external signing and submission. Starting recovery requires a key you still control and approval from the recovery services.'}
            </p>
          </section>

          {!inProcess ? (
            <button type='button' className='qg-text' onClick={() => setReviewingRecovery(false)}>
              Choose another recovery situation
            </button>
          ) : null}
          <div className='vault-section'>
            <p className='vault-section-label'>Recover with</p>
            <div className='vault-hub' role='radiogroup' aria-label='Key to use for recovery'>
              {eligibleClaimants.map((item) => (
                <button
                  key={item}
                  type='button'
                  role='radio'
                  aria-checked={claimant === item}
                  className={claimant === item ? 'vault-hub-row is-on' : 'vault-hub-row'}
                  data-testid={`recover-key-${item}`}
                  onClick={() => setClaimant(item)}
                >
                  <div className='vault-icon sm' aria-hidden>
                    {KEY_ICON[item]}
                  </div>
                  <div className='vault-hub-copy'>
                    <p>{KEY_LABEL[item]}</p>
                    <p>{KEY_DETAIL[item]}</p>
                  </div>
                  {claimant === item ? (
                    <span className='qg-account-option-check' aria-hidden>
                      <QgCheck />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
          {inProcess ? (
            <label className='qg-field'>
              <span>Recovery destination</span>
              <input
                value={claimDest}
                placeholder='Bitcoin address'
                data-testid='recover-claim-dest'
                onChange={(event) => setClaimDest(event.target.value)}
              />
            </label>
          ) : null}
          {psbtOut && preparedAction && !cancelSigners.length ? (
            <section className='qg-note' role='status' data-testid='recovery-prepared'>
              <FileKey />
              <div>
                <strong>
                  {preparedAction === 'initiate'
                    ? 'Recovery transaction prepared'
                    : preparedAction === 'cancel'
                      ? 'Cancellation transaction prepared'
                      : 'Recovery transfer prepared'}
                </strong>
                <p>
                  {preparedAction === 'initiate'
                    ? 'This transaction still needs your selected key and the recovery services to approve it, then submission with compatible recovery software. The waiting period starts after Bitcoin confirmation.'
                    : preparedAction === 'cancel'
                      ? 'This transaction still needs an eligible remaining key and the recovery services to approve it, then submission with compatible recovery software. Recovery remains active until cancellation is confirmed.'
                      : 'Sign with the key that started recovery and submit with compatible recovery software after the waiting period ends. Preparing this transaction does not move your funds.'}
                </p>
              </div>
            </section>
          ) : null}
          {cancelSigners.length ? (
            <>
              <p className='qg-copy' data-testid='recover-guardian-signers'>
                Cancel without services needs {describeGuardianExitSigners(cancelSigners)}. The key that started
                recovery cannot sign.
              </p>
              <section className='qg-summary'>
                {cancelSigners.map((role) => (
                  <div key={role}>
                    <span>{KEY_LABEL[role]}</span>
                    <strong>{cancelHave.includes(role) ? 'signed' : 'still needed'}</strong>
                  </div>
                ))}
              </section>
              {cancelSigners.includes('phone') && !cancelHave.includes('phone') ? (
                <QgPrimary
                  label='Sign with this device'
                  testId='recover-guardian-device'
                  onClick={() => {
                    setLocalError('')
                    void (async () => {
                      try {
                        const next = await signGuardianExitWithDevice(cancelPsbt)
                        setCancelPsbt(next)
                        setCancelHave((have) => [...have, 'phone'])
                        toast('This device signed')
                      } catch (err) {
                        setLocalError(err instanceof Error ? err.message : 'Could not sign with this device')
                      }
                    })()
                  }}
                />
              ) : null}
              {externalRole ? (
                <>
                  <QgSecondary
                    label={`Download cancel for ${KEY_LABEL[externalRole]}`}
                    testId='recover-guardian-external-download'
                    onClick={() => {
                      downloadPsbt('arkade-cancel.psbt', cancelPsbt)
                      toast(`Cancel PSBT saved for ${KEY_LABEL[externalRole]}`)
                    }}
                  />
                  <label className='qg-field'>
                    <span>Signed cancel PSBT file</span>
                    <input
                      type='file'
                      accept='.psbt,application/octet-stream'
                      data-testid='recover-guardian-signed-file'
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        if (!file) return
                        void file.arrayBuffer().then((body) => setSignedCancelPsbt(hex.encode(new Uint8Array(body))))
                      }}
                    />
                  </label>
                  <label className='qg-field'>
                    <span>{`Signed by ${KEY_LABEL[externalRole]}`}</span>
                    <input
                      value={signedCancelPsbt}
                      placeholder='Paste a signed PSBT, or choose the file'
                      data-testid='recover-guardian-signed-psbt'
                      onChange={(event) => setSignedCancelPsbt(event.target.value)}
                    />
                  </label>
                  <QgPrimary
                    label={`Accept ${KEY_LABEL[externalRole]} signature`}
                    testId='recover-guardian-external'
                    disabled={!signedCancelPsbt.trim()}
                    onClick={() => {
                      setLocalError('')
                      try {
                        const kit = parseRecoveryKit(JSON.parse(downloadRecoveryKit()))
                        const expectedPub =
                          externalRole === 'hardware' ? kit.descriptor.keys.hardware : kit.descriptor.keys.recovery
                        if (!expectedPub) throw new Error(`${KEY_LABEL[externalRole]} is not configured`)
                        const next = acceptGuardianExitSignature(
                          cancelPsbt,
                          parseIncomingPsbt(signedCancelPsbt),
                          expectedPub,
                        )
                        setCancelPsbt(next)
                        setCancelHave((have) => [...have, externalRole])
                        setSignedCancelPsbt('')
                        toast(`${KEY_LABEL[externalRole]} signature accepted`)
                      } catch (err) {
                        setLocalError(err instanceof Error ? err.message : 'Could not accept the signed PSBT')
                      }
                    }}
                  />
                </>
              ) : null}
              {cancelHave.length === cancelSigners.length ? (
                <QgPrimary
                  label='Broadcast cancel'
                  testId='recover-guardian-broadcast'
                  onClick={() => {
                    setLocalError('')
                    void (async () => {
                      try {
                        const done = finalizeGuardianExit(cancelPsbt, cancelSigners.length)
                        const txid = await broadcastTx(done.txHex)
                        toast(`Cancel broadcast ${txid.slice(0, 8)}…`)
                        setCancelPsbt('')
                        setCancelSigners([])
                        setCancelHave([])
                        setSignedCancelPsbt('')
                      } catch (err) {
                        setLocalError(err instanceof Error ? err.message : 'Could not broadcast the cancel')
                      }
                    })()
                  }}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </QgScreen>
    )
  }

  const fromHome = recoverExit === 'home'
  const runBackup = (action: () => Promise<unknown>) => {
    setLocalError('')
    void action().catch((err) => setLocalError(err instanceof Error ? err.message : 'Backup is unavailable'))
  }
  return (
    <QgScreen
      title={
        backupView === 'overview'
          ? 'Backups'
          : backupView === 'kit'
            ? 'Recovery Kit'
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
        backupView !== 'overview' ? () => setBackupView('overview') : fromHome ? undefined : () => navigate(recoverExit)
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
                runBackup(async () =>
                  downloadJson('Vaulted recovery package.json', await downloadRecoveryArchive('portable')),
                )
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
          <p className='qg-copy'>Keep your keys and recovery data available if this device is lost.</p>
          <HubGroup>
            <HubRow
              title='Automatic encrypted backup'
              detail={recoveryArchiveStatus || 'Save transaction data for every account'}
              onClick={() => setBackupView('cloud')}
            />
            <HubRow title='Save recovery package' onClick={() => setBackupView('file')} />
            <HubRow
              title='Recovery Kit'
              status={confirmed ? 'Copy confirmed' : hasRecoveryKit ? 'On this device' : 'Needed'}
              onClick={() => setBackupView('kit')}
            />
            <HubRow title='Check a recovery package' onClick={() => setBackupView('inspect')} />
            <HubRow
              title='Recover to Bitcoin'
              detail='Use your saved Spending paths'
              onClick={() => setBackupView('exit')}
            />
            <HubRow
              title='I lost a key'
              onClick={() => {
                setLocalError('')
                setFromKit(true)
                setReviewingRecovery(false)
                setView('lost')
              }}
            />
            {matureBoardingSats > 0 ? (
              <HubRow
                title='Recover received Bitcoin'
                detail={prettyAmount(matureBoardingSats)}
                testId='recover-mature-boarding'
                onClick={() => setBackupView('boarding')}
              />
            ) : null}
          </HubGroup>
        </>
      ) : backupView === 'kit' ? (
        <>
          <h1>Save your Recovery Kit</h1>
          <p className='qg-copy'>
            This public map records Savings addresses and recovery rules. It contains no private keys and cannot move
            bitcoin by itself. Save a private copy outside this device.
          </p>
          <p className='qg-copy'>
            {confirmed
              ? 'You confirmed a separate copy. The app cannot verify where it is saved.'
              : 'After saving a separate copy, record your confirmation below.'}
          </p>
          {!confirmed && hasRecoveryKit ? (
            <QgSecondary
              label='I have a copy outside this device'
              onClick={() => {
                if (!confirm()) toast('Could not save your confirmation. Try again.')
              }}
            />
          ) : null}
          {hasRecoveryKit ? (
            <details className='qg-guidance'>
              <summary>Save a public kit copy with the service</summary>
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
            </details>
          ) : null}
        </>
      ) : backupView === 'cloud' || backupView === 'file' ? (
        <>
          <h1>{backupView === 'cloud' ? 'Back up automatically' : 'Keep a local backup'}</h1>
          <p className='qg-copy'>
            {backupView === 'file'
              ? 'Keep this file private: its Spending paths and Bitcoin addresses are readable without your passkey. Private keys and payment journals remain encrypted. Advanced Spending can use its hardware and recovery keys without unlocking the phone.'
              : 'Save encrypted transaction data for recovery across every account. Keep access to the passkey needed to unlock your backup.'}
          </p>
          {backupView === 'file' ? (
            <p className='qg-copy'>
              Keep a copy of the{' '}
              <a href='https://github.com/brg444/vaulted-emergency-recovery' target='_blank' rel='noreferrer'>
                recovery application
              </a>{' '}
              with this data. Bitcoin access, the required signing keys, fees and waiting periods still apply.
            </p>
          ) : null}
          {backupView === 'file' ? (
            <details className='qg-guidance'>
              <summary>Encrypted archive only</summary>
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
            </details>
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
            {currentKit?.protectionTier === 'advanced'
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
          <p className='qg-copy'>{prettyAmount(matureBoardingSats)} has waited long enough for this recovery path.</p>
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
          <details className='qg-guidance'>
            <summary>Paste recovery JSON</summary>
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
          </details>
          {report && 'coverage' in report && pasted.trim() ? (
            <p className='qg-copy'>
              This file contains Spending paths for {prettyAmount(report.coverage.archivedSats)}, saved{' '}
              {new Date(report.coverage.capturedAt!).toLocaleString()}. This check does not establish coverage of later
              activity or verify access to your signing keys.
            </p>
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
    </QgScreen>
  )
}
