import { useEffect, useRef, useState } from 'react'
import QrCode from '../../components/QrCode'
import { copyToClipboard } from '../../lib/clipboard'
import SpendingSignerFunding from './SpendingSignerFunding'
import {
  readSavingsSetup,
  supportsSpendingSignerSetup,
  checkSpendingSignerFunding,
} from '../../lib/vault/savingsSetupFunding'
import { SETUP_EVENT } from '../../lib/vault/savingsSetupStore'
import { checkConnectorSetup } from '../../lib/vault/connectorSetup'
import type { VaultStatus } from '../../lib/vault/types'
import QgScreen, { QgPrimary, QgSecondary } from './qg/QgScreen'

type Setup = Awaited<ReturnType<typeof checkConnectorSetup>>

export default function ConnectorSetup({
  status,
  onBack,
  onDeposit,
}: {
  status: VaultStatus
  onBack: () => void
  onDeposit: () => void
}) {
  const [result, setResult] = useState<Setup | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(true)
  const [revision, setRevision] = useState(0)
  const [copied, setCopied] = useState(false)
  const [sent, setSent] = useState(false)
  const [spendingSupported, setSpendingSupported] = useState(false)
  const [pendingFunding, setPendingFunding] = useState(false)
  const [fundingMessage, setFundingMessage] = useState('')
  const [fundingBusy, setFundingBusy] = useState(false)
  const latestStatus = useRef(status)
  latestStatus.current = status
  useEffect(() => {
    const status = latestStatus.current
    let active = true
    setChecking(true)
    setResult(null)
    setError('')
    setPendingFunding(false)
    void (async () => {
      if (readSavingsSetup(status)) {
        const payment = await checkSpendingSignerFunding(status)
        if (readSavingsSetup(status)) {
          if (active) {
            setPendingFunding(true)
            setFundingMessage(
              payment?.state === 'confirmed'
                ? 'Signer funding confirmed. Saving the updated Spending recovery data.'
                : payment?.state === 'submitted'
                  ? 'Waiting for Bitcoin confirmation.'
                  : 'Funding is still pending. Check its status before trying again.',
            )
          }
          return null
        }
      }
      if (active) setPendingFunding(false)
      const next = await checkConnectorSetup(status)
      const supported = await supportsSpendingSignerSetup(status).catch(() => false)
      if (active) setSpendingSupported(supported)
      return next
    })()
      .then((next) => {
        if (active) setResult(next)
      })
      .catch((err: Error) => {
        if (active) setError(err.message)
      })
      .finally(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
    }
  }, [status.vaultId, revision])

  useEffect(() => {
    const outcome = () => {
      const saved = readSavingsSetup(latestStatus.current)
      return saved ? `${saved.operationId}:${saved.stage}:${saved.receipt?.state || ''}` : ''
    }
    let previous = ''
    try {
      previous = outcome()
    } catch {
      /* The main check displays invalid saved state. */
    }
    const changed = () => {
      try {
        const next = outcome()
        if (next !== previous && !fundingBusy) setRevision((value) => value + 1)
        previous = next
      } catch (error) {
        setError((error as Error).message)
      }
    }
    window.addEventListener(SETUP_EVENT, changed)
    return () => window.removeEventListener(SETUP_EVENT, changed)
  }, [status.vaultId, fundingBusy])

  const ready = result?.state === 'checked' && result.confirmed >= result.required
  const canFund = result?.state === 'checked' && result.missing > 0
  const request = canFund && !sent ? `bitcoin:${result.address}?amount=${(result.amount / 100_000_000).toFixed(8)}` : ''
  const copy = async () => {
    try {
      await copyToClipboard(request)
      setCopied(true)
    } catch {
      setError('Could not copy the payment request. Try scanning the QR code.')
    }
  }

  return (
    <QgScreen
      title='Savings signer setup'
      back={onBack}
      footer={
        <QgPrimary
          label={fundingBusy ? 'Funding signer…' : checking ? 'Checking…' : ready ? 'Done' : 'Check status'}
          disabled={checking || fundingBusy}
          onClick={ready ? onBack : () => setRevision((value) => value + 1)}
        />
      }
    >
      <h1 className='qg-title'>{ready ? 'Your signer is ready' : 'Set up once, approve future transfers'}</h1>
      <p className='qg-copy'>
        You can receive Bitcoin in Savings now. Before moving it, your signer needs small approval outputs that return
        to its address after each transfer.
      </p>
      {error ? <p role='alert'>{error}</p> : null}
      {pendingFunding ? (
        <p className='qg-copy' role='status'>
          {fundingMessage}
        </p>
      ) : null}
      {result?.state === 'deposit' ? (
        <>
          <p className='qg-copy'>A prepared deposit is saved. Continue it before funding your signer separately.</p>
          <QgSecondary label='Continue prepared deposit' onClick={onDeposit} />
        </>
      ) : result?.state === 'withdrawal' ? (
        <p className='qg-copy'>
          A Savings transfer is pending. Return to the wallet to continue it; wait for its outcome before adding
          approval outputs.
        </p>
      ) : result?.state === 'checked' ? (
        <>
          <p className='qg-copy' role='status'>
            {Math.min(result.confirmed, result.required)} of {result.required} approval outputs confirmed
            {result.pending ? ` · ${result.pending} awaiting Bitcoin confirmation` : ''}.
          </p>
          {canFund ? (
            <>
              {spendingSupported ? (
                <SpendingSignerFunding
                  status={status}
                  onBusyChange={setFundingBusy}
                  onFinished={() => setRevision((value) => value + 1)}
                />
              ) : (
                <p className='qg-copy'>Funding from Spending is unavailable on this deployment.</p>
              )}
              <details>
                <summary>Use an external Bitcoin wallet</summary>
                <p className='qg-copy'>
                  {result.missing === 2
                    ? 'Send two separate payments of 500 sats to this signer address from an external Bitcoin wallet. Do not combine them into one 1,000-sat payment.'
                    : `Send one payment of exactly ${result.amount.toLocaleString('en-US')} sats to this signer address from an external Bitcoin wallet.`}{' '}
                  Network fees are additional. Compare this address with the receiving address you enrolled for your
                  signer.
                </p>
                {request ? (
                  <>
                    <div className='qg-receive'>
                      <div className='qg-qr' role='img' aria-label='Signer funding QR code'>
                        <QrCode large value={request} />
                      </div>
                      <p className='qg-copy' style={{ overflowWrap: 'anywhere' }}>
                        {result.address}
                      </p>
                    </div>
                    <QgSecondary label={copied ? 'Copied' : 'Copy payment request'} onClick={() => void copy()} />
                    <QgSecondary label='I’ve sent the payment' onClick={() => setSent(true)} />
                  </>
                ) : (
                  <>
                    <p className='qg-copy'>
                      Check status after sending. If a payment is not visible yet, check your sending wallet before
                      paying again.
                    </p>
                    <QgSecondary label='Show payment request' onClick={() => setSent(false)} />
                  </>
                )}
              </details>
            </>
          ) : ready ? (
            <p className='qg-copy'>
              Keep these outputs unspent in your signing wallet so they remain available for Savings approvals.
            </p>
          ) : (
            <p className='qg-copy'>
              All required payments are visible. Wait for Bitcoin confirmation; no further payment is needed.
            </p>
          )}
          <details>
            <summary>Advanced: fund with a Savings deposit</summary>
            <p className='qg-copy'>
              If your wallet exports unsigned PSBTs, you can fund Savings and create the approval outputs together.
            </p>
            <QgSecondary label='Prepare combined deposit' onClick={onDeposit} />
          </details>
        </>
      ) : null}
    </QgScreen>
  )
}
