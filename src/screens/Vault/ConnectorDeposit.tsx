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
import { QgPrimary, QgSecondary } from './qg/QgScreen'

type SavedFunding = NonNullable<ReturnType<typeof loadFunding>>

export default function ConnectorDeposit({ status }: { status: VaultStatus }) {
  const [saved, setSaved] = useState<SavedFunding | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [txid, setTxid] = useState('')
  const [abandon, setAbandon] = useState(false)
  const [confirmed, setConfirmed] = useState('')
  const [copied, setCopied] = useState(false)
  const [signed, setSigned] = useState('')
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
  return (
    <section className='qg-note' aria-label='Fund Savings'>
      <div>
        <h2>Fund Savings in one transaction</h2>
        {confirmed ? <p role='status'>Deposit confirmed: {confirmed}</p> : null}
        {!saved ? (
          <>
            <p>
              In your signing wallet, prepare a payment to the Savings address above and export it as an unsigned PSBT.
              Import it here before signing. Use a native SegWit or Taproot wallet.
            </p>
            <p>
              Vaulted sets aside 1,000 sats from your first deposit for the signer reserve and adjusts the network fee.
              The rest goes to Savings; your change stays in your signing wallet.
            </p>
            <QgPrimary label='Import unsigned deposit' onClick={() => input.current?.click()} loading={busy} />
          </>
        ) : (
          <>
            <dl>
              <dt>To Savings</dt>
              <dd>{saved.prepared.savings.toLocaleString()} sats</dd>
              <dt>Signer reserve</dt>
              <dd>
                {saved.prepared.reserve ? `${saved.prepared.reserve.toLocaleString()} sats included` : 'Already funded'}
              </dd>
              <dt>Network fee</dt>
              <dd>{saved.prepared.fee.toLocaleString()} sats</dd>
            </dl>
            {txid ? (
              <p role='status'>
                Deposit submitted. Savings and the reserve become available after Bitcoin confirmation. Transaction:{' '}
                {txid}
              </p>
            ) : (
              <>
                <p>
                  Open this prepared transaction in your signing wallet, review its outputs and approve it. Import the
                  signed file here to submit it.
                </p>
                <QgSecondary label='Save deposit PSBT' onClick={download} disabled={busy} />
                <QgSecondary
                  label={copied ? 'Copied' : 'Copy deposit PSBT'}
                  disabled={busy}
                  onClick={() => {
                    void copyToClipboard(base64.encode(hex.decode(saved.prepared.psbt)))
                      .then(() => setCopied(true))
                      .catch((err) => setError(err.message))
                  }}
                />
                {!saved.draft.signed ? (
                  <QgSecondary label='Import signed deposit' onClick={() => input.current?.click()} disabled={busy} />
                ) : null}
                {signed || saved.draft.signed ? (
                  <QgPrimary
                    label={saved.draft.signed ? 'Retry deposit submission' : 'Submit deposit'}
                    onClick={() => void broadcast()}
                    loading={busy}
                  />
                ) : null}
              </>
            )}
            <QgSecondary
              label='Check confirmation'
              disabled={busy}
              onClick={() => {
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
              }}
            />
          </>
        )}
        {saved || error ? (
          <>
            {abandon ? (
              <>
                <p>
                  Any transaction you already signed can still be broadcast and confirm. Abandon this deposit only after
                  checking its status in your signing wallet, and stop using the previous file.
                </p>
                <QgSecondary label='Keep saved deposit' disabled={busy} onClick={() => setAbandon(false)} />
                <QgSecondary
                  label='Abandon this deposit'
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    void abandonFunding(status)
                      .then(() => {
                        setSaved(null)
                        setSigned('')
                        setTxid('')
                        setError('')
                        setAbandon(false)
                      })
                      .catch((err) => setError(err.message))
                      .finally(() => setBusy(false))
                  }}
                />
              </>
            ) : (
              <QgSecondary label='Start over' disabled={busy} onClick={() => setAbandon(true)} />
            )}
          </>
        ) : null}
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
        {error ? <p role='alert'>{error}</p> : null}
      </div>
    </section>
  )
}
