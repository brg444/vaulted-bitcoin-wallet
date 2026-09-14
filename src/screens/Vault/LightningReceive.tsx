import { useEffect, useRef, useState } from 'react'
import { RestEmulatorProvider } from '@arkade-os/sdk'
import type { RfqSwapRecord } from '@arkade-os/swap'
import QrCode from '../../components/QrCode'
import { copyToClipboard } from '../../lib/clipboard'
import { discoverVaultLightningSolver, withVaultLightningTransport } from '../../lib/vault/lightning'
import { vaultLightningReceivePlan, vaultLightningSolverProfile } from '../../lib/vault/lightningConfig'
import { requestVaultLightningReceive, receiveProfile } from '../../lib/vault/lightningReceive'
import { observeVaultLightningReceive } from '../../lib/vault/lightningReceiveObservation'
import { vaultWalletRuntimeKey } from '../../lib/vault/accountRuntime'
import { withVaultLightningLifecycleLock } from '../../lib/vault/lightningLock'
import { withVaultWalletState } from '../../lib/vault/vtxo/walletWorker'
import { networkPins } from '../../lib/vault/networkPins'
import { vaultLatency } from '../../lib/vault/latency'
import { getOperatorInfo } from '../../lib/vault/operatorInfoCache'
import { forgetLightningReceivePrewarm, prewarmLightningReceive } from '../../lib/vault/lightningReceivePrewarm'
import type { VaultStatus } from '../../lib/vault/types'
import { formatMoney, satsFromUsd, usdInputFromSats } from '../../lib/vault/fiatDisplay'
import { useBalanceDenomination, type BalanceDenomination } from './AccountBalance'
import QgAmount, { amountSizeStyle } from './qg/QgAmount'
import { prettyAmount } from '../../lib/format'
import WalletScreen from './qg/WalletScreen'
import { QgPrimary } from './qg/QgScreen'

export default function LightningReceive({
  onBack,
  status,
  denomination,
}: {
  onBack: () => void
  status: VaultStatus
  denomination?: BalanceDenomination
}) {
  const scope = vaultWalletRuntimeKey(status)
  const actions = useRef({ status, scope })
  actions.current = { status, scope }
  const generation = useRef(0)
  const [amount, setAmount] = useState('')
  const [usdInput, setUsdInput] = useState('')
  // Canonical sats last produced by typing; vault switches bypass it.
  const typedSats = useRef<string | null>(null)
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
  const denom = useBalanceDenomination(denomination)
  const money = { unit: denom.unit, rate: denom.rate }
  const fiatActive = denom.unit === 'usd' && Boolean(denom.rate)
  // The reusable address lives on the primary receive screen; this view only
  // creates amount-specific invoices. Amounts stay canonical sats; the USD
  // field is display-only so rounding can never alter the invoice amount.
  const showUsd = fiatActive
  const moneyText = (sats: number) => (fiatActive ? formatMoney(sats, money) : `${sats.toLocaleString()} sats`)
  const heroAmount = (sats: number) => (fiatActive ? formatMoney(sats, money) : prettyAmount(sats))
  const profile = vaultLightningSolverProfile(status?.network)
  let estimate: ReturnType<typeof vaultLightningReceivePlan> | undefined
  try {
    if (profile && /^\d+$/.test(amount)) estimate = vaultLightningReceivePlan(Number(amount), profile)
  } catch {
    /* field is incomplete */
  }

  useEffect(() => {
    generation.current++
    setRecord(undefined)
    setAmount('')
    setUsdInput('')
    typedSats.current = null
    setError('')
    setCopied(false)
    setBusy(false)
  }, [scope])

  // Warm only the read-only receive setup while this enrolled screen is open.
  // Failures are non-fatal; the explicit Generate invoice click retries. The
  // warm session is dropped when the selected wallet/network changes so a late
  // result cannot populate a new account.
  const lastScope = useRef(scope)
  useEffect(() => {
    if (lastScope.current !== scope) {
      forgetLightningReceivePrewarm(status)
      lastScope.current = scope
    }
    void prewarmLightningReceive(status).catch(() => undefined)
  }, [scope, status])

  const displayedRate = useRef<number | null>(null)
  useEffect(() => {
    if (denom.unit !== 'usd' || !denom.rate) {
      displayedRate.current = null
      return
    }
    if (amount !== typedSats.current || displayedRate.current !== denom.rate.pricePerBtc) {
      displayedRate.current = denom.rate.pricePerBtc
      typedSats.current = amount
      setUsdInput(amount && Number(amount) > 0 ? usdInputFromSats(Number(amount), denom.rate) : '')
    }
  }, [denom.unit, denom.rate, amount])

  useEffect(() => {
    if (!rfqId || paid) return
    const { status } = actions.current
    const stop = observeVaultLightningReceive(status, rfqId, ({ record, error }) => {
      if (record) setRecord(record)
      setError(record?.state === 'settled' ? '' : error)
    })
    // This clock renders invoice expiry; the account owner reconciles payment.
    const timer = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000))
    }, 5000)
    return () => {
      stop()
      window.clearInterval(timer)
    }
  }, [rfqId, scope, paid])

  const create = async () => {
    if (!status || !estimate || busy) return
    const version = generation.current
    const unchanged = () => mounted.current && generation.current === version && actions.current.scope === scope
    setBusy(true)
    setError('')
    setProgress('Connecting to Lightning…')
    try {
      const pins = networkPins(status.network)
      // Start the claim-service check now, but validate it only after worker
      // setup and the outstanding-quote scan, so it overlaps that work while
      // still running before any invoice is requested or persisted.
      const emulatorInfoPromise = new RestEmulatorProvider(pins.emulatorOrigin).getInfo()
      const [verified, operatorInfo] = await vaultLatency.measure('public-setup', () =>
        Promise.all([discoverVaultLightningSolver(status.network), getOperatorInfo(pins.operatorOrigin)]),
      )
      if (!unchanged()) return
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
          const emulatorInfo = await emulatorInfoPromise
          if (emulatorInfo.signerPubkey !== networkPins(status.network).emulatorSignerPub)
            throw new Error('The Lightning claim service does not match this wallet.')
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
      if (unchanged()) {
        setRecord(saved)
        setNow(Math.floor(Date.now() / 1000))
        setCopied(false)
      }
    } catch (e) {
      if (unchanged()) setError(e instanceof Error ? e.message : 'Could not create a Lightning invoice.')
    } finally {
      if (unchanged()) setBusy(false)
    }
  }
  const another = () => {
    setRecord(undefined)
    setAmount('')
    setUsdInput('')
    typedSats.current = null
    setError('')
    setCopied(false)
  }

  const setReceiveAmount = (raw: string) => {
    if (showUsd) {
      const normalized = raw.replace(/[^\d.]/g, '')
      if (!/^\d*(?:\.\d{0,2})?$/.test(normalized)) return
      setUsdInput(normalized)
      const sats = String(satsFromUsd(Number(normalized) || 0, denom.rate?.pricePerBtc || 0))
      typedSats.current = sats
      setAmount(sats)
      return
    }
    typedSats.current = null
    setAmount(raw.replace(/[^0-9]/g, ''))
  }

  const toggleReceiveUnit = async () => {
    if (denom.unit === 'usd') {
      await denom.setUnit('sats')
      return
    }
    const rate = await denom.setUnit('usd')
    if (!rate) {
      setError('USD amounts are unavailable. Enter bitcoin instead.')
      return
    }
    setUsdInput(amount ? usdInputFromSats(Number(amount), rate) : '')
  }
  return (
    <WalletScreen
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
            <div className='qg-receive-copy qg-invoice-summary'>
              <p className='qg-invoice-label'>You receive</p>
              <h1 style={amountSizeStyle(heroAmount(record!.amount!))}>
                <QgAmount value={heroAmount(record!.amount!)} />
              </h1>
              {paid || expired ? (
                <p className='qg-copy' role='status' aria-live='polite'>
                  {paid
                    ? `${fiatActive ? formatMoney(record!.amount!, money) : `${record!.amount?.toLocaleString()} sats`} received in Spending.`
                    : 'This invoice has expired. Any payment already in progress is still being checked.'}
                </p>
              ) : null}
            </div>
            <section className='qg-invoice-fee' aria-label='Sender fee'>
              <div>
                <span>Fee paid by sender</span>
                <strong>{moneyText(current.quote.from_amount - record!.amount!)}</strong>
              </div>
              {!paid && !expired && current.quote.from_amount > current.estimatedPaySats ? (
                <p>{moneyText(current.quote.from_amount - current.estimatedPaySats)} above the advertised estimate.</p>
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
                <span>Sender total</span>
                <strong>{moneyText(current.quote.from_amount)}</strong>
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
            <section className='qg-amount-entry' style={amountSizeStyle(showUsd ? usdInput || '0' : amount || '0')}>
              <label htmlFor='qg-receive-amount'>Amount to receive ({showUsd ? 'USD' : 'sats'})</label>
              <div>
                <button
                  type='button'
                  className='qg-denomination'
                  aria-label={`Amount in ${showUsd ? 'US dollars' : 'bitcoin satoshis'}. Change denomination`}
                  onClick={() => void toggleReceiveUnit()}
                >
                  {showUsd ? '$' : '₿'}
                </button>
                <input
                  id='qg-receive-amount'
                  aria-label={`Amount to receive (${showUsd ? 'USD' : 'sats'})`}
                  inputMode={showUsd ? 'decimal' : 'numeric'}
                  autoComplete='off'
                  placeholder={showUsd ? '0.00' : '1,000'}
                  disabled={busy}
                  value={showUsd ? usdInput : amount}
                  onChange={(e) => setReceiveAmount(e.target.value)}
                />
              </div>
            </section>
            <p className='qg-helper'>
              {estimate
                ? `Estimated sender total: ${moneyText(estimate.maxPaySats)}.`
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
    </WalletScreen>
  )
}
