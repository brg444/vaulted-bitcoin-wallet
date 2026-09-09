import { useEffect, useRef, useState } from 'react'
import { RestArkProvider, RestEmulatorProvider } from '@arkade-os/sdk'
import type { RfqSwapRecord } from '@arkade-os/swap'
import QrCode from '../../components/QrCode'
import { copyToClipboard } from '../../lib/clipboard'
import { discoverVaultLightningSolver, withVaultLightningTransport } from '../../lib/vault/lightning'
import { vaultLightningReceivePlan, vaultLightningSolverProfile } from '../../lib/vault/lightningConfig'
import { requestVaultLightningReceive, receiveProfile } from '../../lib/vault/lightningReceive'
import { reconcileVaultLightningReceives } from '../../lib/vault/lightningReceiveClaim'
import { withVaultLightningLifecycleLock } from '../../lib/vault/lightningLock'
import { withVaultWalletState } from '../../lib/vault/vtxo/walletWorker'
import { networkPins } from '../../lib/vault/networkPins'
import type { VaultStatus } from '../../lib/vault/types'
import QgAmount, { amountSizeStyle } from './qg/QgAmount'
import { prettyAmount } from '../../lib/format'
import QgScreen, { QgPrimary } from './qg/QgScreen'

export default function LightningReceive({
  onBack,
  status,
  refreshBalance,
}: {
  onBack: () => void
  status: VaultStatus
  refreshBalance: () => Promise<void>
}) {
  const actions = useRef({ status, refreshBalance })
  actions.current = { status, refreshBalance }
  const vaultId = status.vaultId
  const [amount, setAmount] = useState('')
  const [record, setRecord] = useState<RfqSwapRecord>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Math.floor(Date.now() / 1000))
  const [copied, setCopied] = useState(false)
  const [progress, setProgress] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const current = record ? receiveProfile(record) : undefined
  const rfqId = record?.rfqId
  const paid = record?.state === 'settled'
  const expired = current ? now >= current.invoiceExpiresAt : false
  const profile = vaultLightningSolverProfile(status?.network)
  let estimate: ReturnType<typeof vaultLightningReceivePlan> | undefined
  try {
    if (profile && /^\d+$/.test(amount)) estimate = vaultLightningReceivePlan(Number(amount), profile)
  } catch {
    /* field is incomplete */
  }

  useEffect(() => {
    setRecord(undefined)
    setAmount('')
    setError('')
    setCopied(false)
    setBusy(false)
  }, [vaultId])

  useEffect(() => {
    if (!rfqId || paid) return
    const { status } = actions.current
    let stopped = false,
      running = false
    const poll = async () => {
      if (running) return
      running = true
      try {
        const saved = await withVaultLightningLifecycleLock(status.vaultId, () =>
          withVaultWalletState(status, async ({ swapRepository, contracts }) => {
            await reconcileVaultLightningReceives({ status, repository: swapRepository, contracts })
            return swapRepository.getRfqSwap(rfqId)
          }),
        )
        if (!stopped && saved) {
          setRecord(saved)
          if (saved.state === 'settled') setError('')
        }
        await actions.current.refreshBalance()
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : 'Waiting for payment status. Keep this wallet open.')
      } finally {
        running = false
      }
    }
    const timer = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000))
      void poll()
    }, 5000)
    void poll()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [rfqId, vaultId, paid])

  const create = async () => {
    if (!status || !estimate || busy) return
    setBusy(true)
    setError('')
    setProgress('Connecting to Lightning…')
    try {
      const pins = networkPins(status.network)
      const [emulatorInfo, verified, operatorInfo] = await Promise.all([
        new RestEmulatorProvider(pins.emulatorOrigin).getInfo(),
        discoverVaultLightningSolver(status.network),
        new RestArkProvider(pins.operatorOrigin).getInfo(),
      ])
      if (emulatorInfo.signerPubkey !== networkPins(status.network).emulatorSignerPub)
        throw new Error('The Lightning claim service does not match this wallet.')
      if (!verified) throw new Error('The Lightning solver card could not be verified.')
      setProgress('Requesting invoice…')
      const saved = await withVaultLightningLifecycleLock(status.vaultId, () =>
        withVaultWalletState(status, async ({ swapRepository, contracts }) => {
          const outstanding = (await swapRepository.getAllRfqSwaps()).find(
            (r) =>
              r.kind === 'lightning_receive' &&
              r.amount === Number(amount) &&
              r.state !== 'settled' &&
              r.state !== 'refunded' &&
              Math.floor(Date.now() / 1000) < receiveProfile(r).invoiceExpiresAt,
          )
          if (outstanding) return outstanding
          return withVaultLightningTransport(verified, async (transport) =>
            requestVaultLightningReceive({
              status,
              amountSats: Number(amount),
              profile: verified,
              transport,
              repository: swapRepository,
              contracts,
              operatorInfo,
            }),
          )
        }),
      )
      if (mounted.current && actions.current.status.vaultId === status.vaultId) {
        setRecord(saved)
        setNow(Math.floor(Date.now() / 1000))
        setCopied(false)
      }
    } catch (e) {
      if (mounted.current && actions.current.status.vaultId === status.vaultId)
        setError(e instanceof Error ? e.message : 'Could not create a Lightning invoice.')
    } finally {
      if (mounted.current && actions.current.status.vaultId === status.vaultId) setBusy(false)
    }
  }
  const another = () => {
    setRecord(undefined)
    setAmount('')
    setError('')
    setCopied(false)
  }
  return (
    <QgScreen
      title='Receive Lightning'
      dismiss={onBack}
      footer={
        current && !paid && !expired ? (
          <QgPrimary
            label={copied ? 'Copied' : 'Copy invoice'}
            disabled={busy}
            onClick={() =>
              void copyToClipboard(current.invoice)
                .then(() => setCopied(true))
                .catch(() => setError('Could not copy the invoice.'))
            }
          />
        ) : current ? (
          <QgPrimary label='Another invoice' disabled={busy} onClick={another} />
        ) : (
          <QgPrimary
            label={busy ? progress : 'Create invoice'}
            loading={busy}
            disabled={!estimate}
            onClick={() => void create()}
          />
        )
      }
    >
      <div className='qg-stack qg-invoice'>
        {current ? (
          <>
            <div className='qg-receive-copy'>
              <h1 style={amountSizeStyle(prettyAmount(record!.amount!))}>
                <QgAmount value={prettyAmount(record!.amount!)} />
              </h1>
              <p className='qg-copy' role='status' aria-live='polite'>
                {paid
                  ? `${record!.amount?.toLocaleString()} sats received in Spending.`
                  : expired
                    ? 'This invoice has expired. Any payment already in progress is still being checked.'
                    : 'Ready to receive. Keep Vaulted open until the payment arrives.'}
              </p>
            </div>
            <section className='qg-invoice-fee' aria-label='Sender fee'>
              <div>
                <span>Fee paid by sender</span>
                <strong>{(current.quote.from_amount - record!.amount!).toLocaleString()} sats</strong>
              </div>
              {!paid && !expired && current.quote.from_amount > current.estimatedPaySats ? (
                <p>
                  {(current.quote.from_amount - current.estimatedPaySats).toLocaleString()} sats above the advertised
                  estimate.
                </p>
              ) : null}
            </section>
            {!paid && !expired ? (
              <div className='qg-receive'>
                <div className='qg-qr' role='img' aria-label='Lightning invoice QR code'>
                  <QrCode large value={`lightning:${current.invoice}`} />
                </div>
              </div>
            ) : null}
            <section className='qg-details' aria-label='Invoice details'>
              <div>
                <span>You receive</span>
                <strong>{record!.amount?.toLocaleString()} sats</strong>
              </div>
              <div>
                <span>Sender total</span>
                <strong>{current.quote.from_amount.toLocaleString()} sats</strong>
              </div>
              {!paid && !expired ? (
                <div>
                  <span>Expires in</span>
                  <strong>{Math.max(1, Math.ceil((current.invoiceExpiresAt - now) / 60))} min</strong>
                </div>
              ) : null}
            </section>
          </>
        ) : (
          <>
            <section className='qg-amount-entry' style={amountSizeStyle(amount || '0')}>
              <label htmlFor='qg-receive-amount'>Amount to receive (sats)</label>
              <div>
                <span className='qg-denomination' aria-hidden='true'>
                  ₿
                </span>
                <input
                  id='qg-receive-amount'
                  aria-label='Amount to receive (sats)'
                  inputMode='numeric'
                  autoComplete='off'
                  placeholder='1,000'
                  disabled={busy}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
                />
              </div>
            </section>
            <p className='qg-helper'>
              {estimate
                ? `Estimated sender total: ${estimate.maxPaySats.toLocaleString()} sats.`
                : 'Enter the amount you want in Spending.'}
            </p>
            <p className='qg-copy'>
              The exact fee appears before you share the invoice. Keep Vaulted open while receiving.
            </p>
          </>
        )}
        {error ? (
          <p className='qg-field-error' role='alert'>
            {error}
          </p>
        ) : null}
      </div>
    </QgScreen>
  )
}
