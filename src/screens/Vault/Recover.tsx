import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
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
  const [view, setView] = useState<'kit' | 'lost'>(recoverEntry)
  const [reviewingRecovery, setReviewingRecovery] = useState(false)
  const [fromKit, setFromKit] = useState(false)

  useEffect(() => {
    setView(recoverEntry)
    setReviewingRecovery(false)
    setFromKit(false)
  }, [recoverEntry])
  const [pasted, setPasted] = useState('')
  const [showPaste, setShowPaste] = useState(false)
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
  const [confirmBoardingRecovery, setConfirmBoardingRecovery] = useState(false)
  const [recoveringBoarding, setRecoveringBoarding] = useState(false)

  useEffect(() => {
    let active = true
    setMatureBoardingSats(0)
    setConfirmBoardingRecovery(false)
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
      return inspectRecoveryKit(parseRecoveryKit(JSON.parse(raw)))
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
    return (
      <QgScreen
        title={fromHome && !backToKit ? 'Recovery' : 'Lost a key'}
        dismiss={!backToKit && fromHome ? () => navigate('home') : undefined}
        back={backToKit ? () => setView('kit') : fromHome ? undefined : () => navigate(recoverExit)}
        footer={
          inProcess ? (
            <>
              <RecoverAlert text={error || localError} />
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
              {canCancelWithoutServices ? (
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
              <QgSecondary
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
  return (
    <QgScreen
      title='Recovery Kit'
      dismiss={fromHome ? () => navigate('home') : undefined}
      back={fromHome ? undefined : () => navigate(recoverExit)}
      footer={
        <>
          <RecoverAlert text={error || localError} />
          {hasRecoveryKit ? (
            <>
              <p className='qg-copy'>
                {recoveryArchiveStatus || 'Save complete transaction data for recovery across every account.'}
              </p>
              <RecoverAlert text={recoveryArchiveError} />
              <QgSecondary
                label='Enable encrypted automatic backup'
                disabled={busy}
                onClick={() => {
                  setLocalError('')
                  void backupRecoveryArchive().catch((err) =>
                    setLocalError(err instanceof Error ? err.message : 'Backup is unavailable'),
                  )
                }}
              />
              <QgSecondary
                label='Download encrypted recovery archive'
                disabled={busy}
                onClick={() => {
                  setLocalError('')
                  void downloadRecoveryArchive()
                    .then((raw) => downloadJson('Vaulted encrypted recovery.json', raw))
                    .catch((err) =>
                      setLocalError(err instanceof Error ? err.message : 'Recovery archive is unavailable'),
                    )
                }}
              />
              <QgPrimary label='Download Recovery Kit' testId='download-recovery-kit' onClick={saveKit} />
              <QgSecondary
                label={busy ? 'Waiting for passkey…' : 'Save copy with Vault service'}
                testId='backup-recovery-kit'
                disabled={busy}
                onClick={() => {
                  setLocalError('')
                  void (async () => {
                    try {
                      const pushed = await backupRecoveryKit()
                      toast(pushed ? 'Kit copy saved with the Vault service' : 'Kit saved on this device only')
                    } catch (err) {
                      setLocalError(err instanceof Error ? err.message : 'Could not back up the map')
                    }
                  })()
                }}
              />
            </>
          ) : (
            <QgPrimary
              label={busy ? 'Waiting for passkey…' : 'Retrieve Recovery Kit'}
              testId='restore-recovery-kit'
              disabled={busy}
              onClick={() => {
                setLocalError('')
                void (async () => {
                  try {
                    await restoreRecoveryKit()
                    toast('Recovery Kit retrieved on this device')
                  } catch (err) {
                    setLocalError(err instanceof Error ? err.message : 'Could not get the map')
                  }
                })()
              }}
            />
          )}
        </>
      }
    >
      <div className='vault-security'>
        <section className='vault-security-hero' aria-label='Recovery Kit status'>
          <div className='vault-security-hero-head'>
            <strong>Recovery Kit</strong>
            <span className={hasRecoveryKit ? 'is-ready' : 'is-attention'}>
              {hasRecoveryKit ? 'On this device' : 'Needed'}
            </span>
          </div>
          <h2>Keep your Recovery Kit available</h2>
          <p>
            The Recovery Kit is a public map of this vault—not a seed or private key. It lets recovery software rebuild
            the correct addresses and recovery paths, but cannot move bitcoin by itself.
          </p>
        </section>

        <section className='qg-note'>
          <FileKey />
          <div>
            <strong>{confirmed ? 'Separate copy confirmed by you' : 'Separate copy still needs confirmation'}</strong>
            <p>
              {confirmed
                ? 'The app records your confirmation, but cannot verify the saved file.'
                : 'After saving this vault’s kit outside this device, record that you have a separate copy.'}
            </p>
            {!confirmed && hasRecoveryKit ? (
              <button
                type='button'
                className='qg-text'
                onClick={() => {
                  if (!confirm()) toast('Could not save your confirmation. Try again.')
                }}
              >
                I have a copy outside this device
              </button>
            ) : null}
          </div>
        </section>
        <HubGroup label='Keep a durable copy'>
          <HubRow
            title='On this device'
            detail={
              hasRecoveryKit
                ? 'The vault map is here. Save another copy outside this device.'
                : 'No vault map is available here. Retrieve a service copy with your passkey, or inspect a saved file below.'
            }
          />
          <HubRow
            title='When you need the file'
            detail='Recovery software uses this file to reconstruct the vault’s addresses and recovery rules when the app cannot.'
          />
          <HubRow
            title='When the file cannot help'
            detail='The map cannot sign, start recovery by itself, or replace a lost key. This device plus hardware can still move Savings without the service.'
          />
        </HubGroup>

        {report && 'trees' in report ? (
          <p className='qg-copy'>
            This kit is for vault {report.vaultId.slice(0, 8)}… · {report.trees.length} addresses
          </p>
        ) : null}
        {report && 'error' in report && pasted.trim() ? <RecoverAlert text={report.error} /> : null}
        <button type='button' className='qg-text' onClick={() => setShowPaste((open) => !open)}>
          I already have a kit file
        </button>
        {showPaste ? (
          <label className='qg-field'>
            <span>Recovery Kit</span>
            <input
              value={pasted}
              placeholder='Paste the file to check it'
              data-testid='recovery-kit-json'
              onChange={(event) => setPasted(event.target.value)}
            />
          </label>
        ) : null}

        <HubGroup label='If something is wrong'>
          <HubRow
            title='I lost a key'
            detail='Check the remaining keys, service requirements, and next steps for Savings.'
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
              detail={`These funds have waited long enough to return onchain with this device. ${prettyAmount(matureBoardingSats)}`}
              onClick={() => setConfirmBoardingRecovery(true)}
              testId='recover-mature-boarding'
            />
          ) : null}
        </HubGroup>
        {confirmBoardingRecovery ? (
          <>
            <p className='qg-copy'>
              Your passkey will authorize a one-time recovery to this device. A network fee is deducted before the
              transaction is sent.
            </p>
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
                    setConfirmBoardingRecovery(false)
                    toast(`Recovery sent ${txid.slice(0, 8)}…`)
                  })
                  .catch((err) => {
                    setLocalError(err instanceof Error ? err.message : 'Could not recover received Bitcoin')
                  })
                  .finally(() => setRecoveringBoarding(false))
              }}
            />
          </>
        ) : null}
      </div>
    </QgScreen>
  )
}
