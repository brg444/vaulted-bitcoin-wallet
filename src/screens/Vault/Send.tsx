import PaymentNotice from './qg/PaymentNotice'
import { isVaultBitcoinAddress } from '../../lib/vault/bitcoin'
import { useContext, useEffect, useRef, useState } from 'react'
import type { NetworkName } from '@arkade-os/sdk'
import type { InvoiceFacts } from '@arkade-os/swap'
import { KeyRound } from 'lucide-react'
import { useToast } from '../../components/Toast'
import { prettyNumber } from '../../lib/format'
import { decodeVaultBip21, isVaultBip21 } from '../../lib/vault/bip21'
import { formatMoney, satsFromUsd, usdInputFromSats } from '../../lib/vault/fiatDisplay'
import {
  isVaultLightningInput,
  vaultLightningSendEnabled,
  vaultLightningSolverProfile,
} from '../../lib/vault/lightningConfig'
import { decodeVaultLightningInvoice } from '../../lib/vault/lightningInvoice'
import { humanizeVaultError } from '../../lib/vault/humanize'
import { reloadIfNewerWallet } from '../../lib/vault/update'
import { isSameVtxoPayment, loadPersistedVtxoSpend } from '../../lib/vault/vtxo/spend'
import { VaultContext } from '../../vault/context'
import { useBalanceDenomination, type BalanceDenomination } from './AccountBalance'
import Scanner from './Scanner'
import DestinationField from './qg/DestinationField'
import { amountSizeStyle } from './qg/QgAmount'
import QgScreen, { QgPrimary, QgSecondary } from './qg/QgScreen'

function lightningInvoice(value: string, network?: string): { invoice?: InvoiceFacts; error?: string } {
  if (!network || !vaultLightningSendEnabled(network as NetworkName) || !isVaultLightningInput(value)) return {}
  const profile = vaultLightningSolverProfile(network as NetworkName)
  if (!profile) return {}
  try {
    return { invoice: decodeVaultLightningInvoice(value, profile.network) }
  } catch (error) {
    return { error: humanizeVaultError(error) }
  }
}

function payloadFromScan(raw: string, allowLightning = true): { address: string; amount?: number } {
  const trimmed = raw.trim()
  if (isVaultBip21(trimmed)) {
    try {
      const decoded = decodeVaultBip21(trimmed)
      return {
        address: (
          (allowLightning ? decoded.lightning : '') ||
          decoded.arkadeAddress ||
          decoded.bitcoinAddress ||
          ''
        ).trim(),
        amount: decoded.satoshis,
      }
    } catch {
      return { address: trimmed }
    }
  }
  return { address: trimmed }
}

export default function VaultSend({ denomination }: { denomination?: BalanceDenomination }) {
  const {
    account,
    boardingAddress,
    busy,
    clearSendScan,
    dailyRemaining,
    error,
    navigate,
    reviewSpend,
    pendingPayments = [],
    openPendingPayment,
    canReplaceInFlightSend,
    replaceInFlightSend,
    scanOnSend,
    setSpendDraft,
    spend,
    setup,
    status,
    positions,
  } = useContext(VaultContext)
  const { toast } = useToast()
  const denom = useBalanceDenomination(denomination)
  const money = { unit: denom.unit, rate: denom.rate }
  // The USD entry is display-only: canonical sats live in spend.amount, so a
  // rounded two-decimal field can never destroy precise values like 331 sats.
  const showUsd = denom.unit === 'usd' && Boolean(denom.rate)
  const fromSavings = account === 'savings'
  const movingToSpending = fromSavings && Boolean(boardingAddress) && spend.address === boardingAddress
  const destNetwork = status?.network
  const lightningValidation = fromSavings ? {} : lightningInvoice(spend.address, destNetwork)
  const lightning = Boolean(lightningValidation.invoice)
  const [scan, setScan] = useState(Boolean(scanOnSend))
  const [usdInput, setUsdInput] = useState('')
  // Canonical sats last produced by typing. External replacements (scans,
  // pastes, resumed drafts) bypass it, so the effect below can tell them apart.
  const typedSats = useRef<number | null>(null)
  const availableSpend = Math.max(0, Math.min(dailyRemaining, positions.spending.availableSats))
  const available = fromSavings ? positions.savings.availableSats : availableSpend
  const bitcoinChange = !fromSavings && isVaultBitcoinAddress(spend.address, destNetwork) ? 330 : 0
  const maximum = Math.max(
    0,
    Math.min(available - Math.max(0, spend.fee) - bitcoinChange, fromSavings ? available : setup.txCapSats),
  )
  const pendingSend = !fromSavings && status?.vaultId ? loadPersistedVtxoSpend(status.vaultId) : undefined
  const resumingPayment = Boolean(pendingSend && isSameVtxoPayment(pendingSend, spend.address, spend.amount))
  const reservedSats = pendingSend?.reservedInputs?.reduce((total, input) => total + input.valueSats, 0)
  const blockedByPending = !fromSavings && pendingPayments.some((payment) => payment.authorized) && !resumingPayment
  const amountError = blockedByPending
    ? 'A payment is still pending. Resume it below before starting another.'
    : spend.amount <= 0
      ? ''
      : spend.amount < 330
        ? `The smallest send is ${formatMoney(330, money)}.`
        : spend.amount > available && !resumingPayment
          ? fromSavings
            ? 'That is more than Savings has available.'
            : 'That is more than you can send now.'
          : !fromSavings && spend.amount > setup.txCapSats
            ? `Up to ${formatMoney(setup.txCapSats, money)} per payment.`
            : ''

  useEffect(() => {
    void reloadIfNewerWallet()
  }, [])

  useEffect(() => {
    if (!scanOnSend) return
    setScan(true)
  }, [scanOnSend])

  // Follow the shared unit and every external amount replacement without
  // disturbing in-progress typing: derive the USD field whenever the canonical
  // amount differs from what typing last produced.
  const displayedRate = useRef<number | null>(null)
  useEffect(() => {
    if (denom.unit !== 'usd' || !denom.rate) {
      displayedRate.current = null
      return
    }
    if (spend.amount !== typedSats.current || displayedRate.current !== denom.rate.pricePerBtc) {
      displayedRate.current = denom.rate.pricePerBtc
      typedSats.current = spend.amount
      setUsdInput(spend.amount ? usdInputFromSats(spend.amount, denom.rate) : '')
    }
  }, [denom.unit, denom.rate, spend.amount])

  const closeScan = () => {
    if (scanOnSend) {
      clearSendScan()
      navigate('home')
      return
    }
    setScan(false)
  }

  const setAmount = (raw: string) => {
    if (showUsd) {
      const normalized = raw.replace(/[^\d.]/g, '')
      if (!/^\d*(?:\.\d{0,2})?$/.test(normalized)) return
      setUsdInput(normalized)
      const sats = satsFromUsd(Number(normalized) || 0, denom.rate?.pricePerBtc || 0)
      typedSats.current = sats
      setSpendDraft({ amount: sats })
      return
    }
    typedSats.current = null
    const digits = raw.replace(/\D/g, '')
    setSpendDraft({ amount: Number(digits) || 0 })
  }

  const toggleAmountUnit = async () => {
    if (denom.unit === 'usd') {
      await denom.setUnit('sats')
      return
    }
    const rate = await denom.setUnit('usd')
    if (!rate) {
      toast('USD amounts are unavailable. Try again later.')
      return
    }
    setUsdInput(spend.amount ? usdInputFromSats(spend.amount, rate) : '')
  }

  const setAddress = (value: string) => {
    const next = payloadFromScan(value, !fromSavings)
    const lightningAmount = fromSavings ? undefined : lightningInvoice(next.address, destNetwork).invoice?.amountSats
    setSpendDraft({
      address: next.address,
      ...(lightningAmount === undefined && next.amount === undefined ? {} : { amount: lightningAmount ?? next.amount }),
    })
  }

  if (scan) {
    return (
      <Scanner
        close={closeScan}
        manual={() => {
          clearSendScan()
          setScan(false)
        }}
        label={fromSavings ? 'Scan Bitcoin address' : 'Scan payment'}
        onData={(data) => {
          const next = payloadFromScan(data, !fromSavings)
          const lightningAmount = fromSavings
            ? undefined
            : lightningInvoice(next.address, destNetwork).invoice?.amountSats
          setSpendDraft({
            address: next.address,
            ...(lightningAmount || next.amount ? { amount: lightningAmount || next.amount } : {}),
          })
          clearSendScan()
          setScan(false)
        }}
        onError={() => {
          toast('Camera unavailable. Enter the destination manually.')
          clearSendScan()
          setScan(false)
        }}
      />
    )
  }

  return (
    <QgScreen
      title={movingToSpending ? 'Transfer' : fromSavings ? 'Send from Savings' : 'Send'}
      dismiss={() => navigate('home')}
      footer={
        <>
          {error ? <PaymentNotice message={error} /> : null}
          {!fromSavings
            ? pendingPayments.map((payment) => (
                <QgSecondary
                  key={payment.operationId}
                  label='Open pending payment'
                  onClick={() => void openPendingPayment(payment.operationId)}
                  disabled={busy}
                />
              ))
            : null}
          {canReplaceInFlightSend ? (
            <QgSecondary label='Abort reserved send' onClick={() => void replaceInFlightSend()} disabled={busy} />
          ) : null}
          <QgPrimary
            onClick={() => void reviewSpend()}
            disabled={
              busy ||
              Boolean(amountError) ||
              Boolean(lightningValidation.error) ||
              spend.amount <= 0 ||
              !spend.address.trim()
            }
            loading={busy}
            label={
              busy
                ? resumingPayment
                  ? 'Resuming…'
                  : 'Confirming fee…'
                : movingToSpending
                  ? 'Review transfer'
                  : fromSavings
                    ? 'Review send'
                    : resumingPayment
                      ? 'Resume payment'
                      : 'Review payment'
            }
          />
        </>
      }
    >
      <section className='qg-amount-entry' style={amountSizeStyle(showUsd ? usdInput : prettyNumber(spend.amount, 0))}>
        <label htmlFor='qg-send-amount'>Amount</label>
        <div>
          <button
            type='button'
            className='qg-denomination'
            aria-label={`Amount in ${showUsd ? 'US dollars' : 'bitcoin satoshis'}. Change denomination`}
            onClick={() => void toggleAmountUnit()}
          >
            {showUsd ? '$' : '₿'}
          </button>
          <input
            id='qg-send-amount'
            value={showUsd ? usdInput : spend.amount ? prettyNumber(spend.amount, 0) : ''}
            inputMode={showUsd ? 'decimal' : 'numeric'}
            readOnly={lightning}
            data-testid='vault-send-amount'
            placeholder={showUsd ? '0.00' : '20,000'}
            onChange={(event) => setAmount(event.target.value)}
          />
          {lightning ? null : (
            <button
              type='button'
              className='qg-max'
              onClick={() => {
                setSpendDraft({ amount: maximum })
                if (showUsd && denom.rate) {
                  setUsdInput(usdInputFromSats(maximum, denom.rate))
                }
              }}
            >
              Max
            </button>
          )}
        </div>
        {amountError ? (
          <p className='qg-field-error' role='alert'>
            {amountError}
          </p>
        ) : null}
        {denom.unit === 'usd' && !denom.rate ? (
          <p className='qg-helper' role='status'>
            USD rate unavailable — enter bitcoin instead.
          </p>
        ) : null}
      </section>
      <DestinationField
        label='To'
        value={spend.address}
        name='vault-send-destination'
        placeholder={fromSavings ? 'Bitcoin address' : 'Payment address or Lightning invoice'}
        onChange={(event) => setAddress(event.target.value)}
        onScan={() => setScan(true)}
        hint={fromSavings ? 'Bitcoin address' : undefined}
        aria-invalid={Boolean(lightningValidation.error)}
        aria-describedby={lightningValidation.error ? 'vault-send-lightning-error' : undefined}
      />
      {lightningValidation.error ? (
        <p id='vault-send-lightning-error' className='qg-inline-error' role='alert'>
          {lightningValidation.error}
        </p>
      ) : null}
      {fromSavings ? (
        <p className='qg-available'>{formatMoney(positions.savings.availableSats, money)} available</p>
      ) : (
        <p className='qg-available' aria-label='Spending capacity'>
          {resumingPayment
            ? `${formatMoney(reservedSats || pendingSend?.amountSats || spend.amount, money)} reserved for this payment`
            : `${formatMoney(availableSpend, money)} available within your rolling limit`}
        </p>
      )}
      {fromSavings ? (
        <section className='qg-note'>
          <KeyRound />
          <div>
            <strong>Two approvals are required</strong>
            <p>Your passkey signs first. Your hardware key signs next.</p>
          </div>
        </section>
      ) : (
        <p className='qg-helper'>
          {lightning
            ? 'The payment fee appears before approval.'
            : `Up to ${formatMoney(setup.txCapSats, money)} per payment. The fee appears before approval.`}
        </p>
      )}
    </QgScreen>
  )
}
