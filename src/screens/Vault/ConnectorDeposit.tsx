import { useEffect, useRef, useState } from 'react'
import { psbtFile } from '../../lib/vault/savingsSpend'
import { base64, hex } from '@scure/base'
import {
  createFunding,
  loadFunding,
  submitFunding,
  finishFunding,
  abandonFunding,
} from '../../lib/vault/connectorFunding'
import { readConnectorSignerFile } from '../../lib/vault/connectorSignerFile'
import { copyToClipboard } from '../../lib/clipboard'
import type { VaultStatus } from '../../lib/vault/types'
import QgScreen, { QgPrimary, QgSecondary } from './qg/QgScreen'

type SavedFunding = NonNullable<ReturnType<typeof loadFunding>>

export default function ConnectorDeposit({
  status,
  onBack,
  onAddress,
}: {
  status: VaultStatus
  onBack?: () => void
  onAddress?: () => void
}) {
  const [saved, setSaved] = useState<SavedFunding | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [txid, setTxid] = useState('')
  const [abandon, setAbandon] = useState(false)
  const [confirmed, setConfirmed] = useState('')
  const [copied, setCopied] = useState(false)
  const [signed, setSigned] = useState('')
  const [step, setStep] = useState<'review' | 'sign'>('review')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    try {
      const previous = loadFunding(status)
      setSaved(previous)
      if (previous?.draft.submitted) setTxid(previous.prepared.txid)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [status])

  const importFile = async (file: File) => {
    setBusy(true)
    setError('')
    try {
      const text = await readConnectorSignerFile(file)
      if (saved) {
        if (saved.draft.signed) throw new Error('Retry the saved deposit; a different signed file cannot replace it.')
        saved.prepared.accept(text)
        setSigned(text)
        setTxid('')
      } else setSaved(await createFunding(status, text))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const broadcast = async () => {
    setBusy(true)
    setError('')
    try {
      setTxid(await submitFunding(status, signed))
      setSaved(loadFunding(status))
    } catch (err) {
      setError((err as Error).message)
      try {
        setSaved(loadFunding(status))
      } catch {
        /* Keep the original submission error visible. */
      }
    } finally {
      setBusy(false)
    }
  }
  const download = () => {
    if (!saved) return
    const blob = psbtFile(saved.prepared.psbt, 'Vaulted Savings deposit.psbt')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'Vaulted Savings deposit.psbt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const check = () => {
    setBusy(true)
    setError('')
    void finishFunding(status)
      .then((id) => {
        setConfirmed(id)
        setSaved(null)
        setSigned('')
        setTxid('')
      })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false))
  }
  const submission = Boolean(signed || saved?.draft.signed)
  const title = abandon
    ? 'Abandon deposit'
    : confirmed
      ? 'Deposit confirmed'
      : txid
        ? 'Deposit submitted'
        : submission
          ? 'Submit deposit'
          : !saved
            ? 'Fund Savings'
            : step === 'review'
              ? 'Review deposit'
              : 'Sign deposit'
  return (
    <QgScreen
      title={title}
      back={
        busy
          ? undefined
          : abandon
            ? () => setAbandon(false)
            : saved && !submission && step === 'sign'
              ? () => setStep('review')
              : onBack
      }
      footer={
        <>
          {error ? (
            <p role='alert' className='qg-footer-error'>
              {error}
            </p>
          ) : null}
          {abandon ? (
            <QgPrimary
              label='Abandon this deposit'
              loading={busy}
              onClick={() => {
                setBusy(true)
                void abandonFunding(status)
                  .then(() => {
                    setSaved(null)
                    setSigned('')
                    setTxid('')
                    setError('')
                    setAbandon(false)
                    setStep('review')
                  })
                  .catch((err) => setError(err.message))
                  .finally(() => setBusy(false))
              }}
            />
          ) : confirmed ? (
            <QgPrimary label='Done' onClick={onBack || (() => setConfirmed(''))} />
          ) : txid ? (
            <QgPrimary label='Check confirmation' onClick={check} loading={busy} />
          ) : submission ? (
            <>
              <QgPrimary
                label={saved?.draft.signed ? 'Retry deposit submission' : 'Submit deposit'}
                onClick={() => void broadcast()}
                loading={busy}
              />
              <QgSecondary label='Check confirmation' onClick={check} disabled={busy} />
            </>
          ) : !saved ? (
            <QgPrimary label='Import unsigned deposit' onClick={() => input.current?.click()} loading={busy} />
          ) : step === 'review' ? (
            <QgPrimary label='Continue to signing' onClick={() => setStep('sign')} />
          ) : (
            <QgPrimary label='Import signed deposit' onClick={() => input.current?.click()} loading={busy} />
          )}
        </>
      }
    >
      {abandon ? (
        <>
          <h1>Check before starting over</h1>
          <p className='qg-copy'>
            Any transaction you already signed can still be broadcast and confirm. Abandon this deposit only after
            checking its status in your signing wallet, and stop using the previous file.
          </p>
          <QgSecondary label='Keep saved deposit' disabled={busy} onClick={() => setAbandon(false)} />
        </>
      ) : confirmed ? (
        <p role='status' className='qg-full-value'>
          Deposit confirmed: {confirmed}
        </p>
      ) : (
        <>
          {!saved ? (
            <>
              <h1>Fund Savings in one transaction</h1>
              <p className='qg-copy'>
                In your signing wallet, prepare a payment to this Savings address. Export an unsigned PSBT and import it
                here before signing.
              </p>
              <button
                type='button'
                className='qg-address-copy'
                onClick={() =>
                  void copyToClipboard(status.savingsAddress || '')
                    .then(() => setCopied(true))
                    .catch((err) => setError(err.message))
                }
              >
                <span className='qg-full-value'>{status.savingsAddress}</span>
                <strong>{copied ? 'Copied' : 'Copy Savings address'}</strong>
              </button>
              <p className='qg-copy'>
                The first deposit includes a 1,000-sat signer reserve. The remaining amount, after fees, goes to
                Savings. Your signing wallet keeps its change.
              </p>
              <details className='qg-guidance'>
                <summary>Prepare the unsigned payment</summary>
                <p>
                  Use a native SegWit or Taproot wallet. Create the payment in your wallet and save its PSBT before
                  signing. Vaulted will show the adjusted outputs and fee for review.
                </p>
              </details>
              {onAddress ? (
                <button type='button' className='qg-text' onClick={onAddress}>
                  Show receiving QR code
                </button>
              ) : null}
            </>
          ) : (
            <>
              <section className='qg-summary' aria-label='Deposit details'>
                <div>
                  <span>To Savings</span>
                  <strong>{saved.prepared.savings.toLocaleString()} sats</strong>
                </div>
                <div>
                  <span>Signer reserve</span>
                  <strong>
                    {saved.prepared.reserve
                      ? `${saved.prepared.reserve.toLocaleString()} sats included`
                      : 'Already funded'}
                  </strong>
                </div>
                <div>
                  <span>Network fee</span>
                  <strong>{saved.prepared.fee.toLocaleString()} sats</strong>
                </div>
              </section>
              {txid ? (
                <>
                  <p role='status' className='qg-copy'>
                    Deposit submitted. Savings and the reserve become available after Bitcoin confirmation.
                  </p>
                  <details className='qg-guidance'>
                    <summary>View transaction</summary>
                    <p className='qg-full-value'>{txid}</p>
                  </details>
                </>
              ) : submission ? (
                <p className='qg-copy'>
                  The signed deposit is verified before submission. A retry sends the same saved transaction.
                </p>
              ) : step === 'review' ? (
                <p className='qg-copy'>
                  Review this split, then open the prepared transaction in your signing wallet to check all outputs and
                  approve it.
                </p>
              ) : (
                <>
                  <p className='qg-copy'>
                    Open the prepared deposit in your signing wallet. Check the outputs and fee, sign, then import the
                    signed file here.
                  </p>
                  <QgSecondary label='Save deposit PSBT' onClick={download} disabled={busy} />
                  <details className='qg-guidance'>
                    <summary>Copy transaction instead</summary>
                    <QgSecondary
                      label={copied ? 'Copied' : 'Copy deposit PSBT'}
                      disabled={busy}
                      onClick={() =>
                        void copyToClipboard(base64.encode(hex.decode(saved.prepared.psbt)))
                          .then(() => setCopied(true))
                          .catch((err) => setError(err.message))
                      }
                    />
                  </details>
                </>
              )}
            </>
          )}
          {saved || error ? (
            <details className='qg-guidance'>
              <summary>Manage saved deposit</summary>
              <p>Check the transaction in your signing wallet before abandoning it.</p>
              <QgSecondary label='Start over' disabled={busy} onClick={() => setAbandon(true)} />
            </details>
          ) : null}
        </>
      )}
      <input
        ref={input}
        type='file'
        hidden
        aria-label={saved ? 'Signed deposit file' : 'Unsigned deposit file'}
        accept='.psbt,.txn,.txt'
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void importFile(file)
        }}
      />
    </QgScreen>
  )
}
