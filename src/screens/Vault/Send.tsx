import PaymentNotice from './qg/PaymentNotice'
import { isVaultBitcoinAddress } from '../../lib/vault/bitcoin'
import { useContext, useEffect, useState } from 'react'
import type { NetworkName } from '@arkade-os/sdk'
import { KeyRound } from 'lucide-react'
import { useToast } from '../../components/Toast'
import { prettyAmount, prettyNumber } from '../../lib/format'
import { decodeVaultBip21, isVaultBip21 } from '../../lib/vault/bip21'
import { satsFromUsd, usdFromSats } from '../../lib/vault/fiatDisplay'
import {
  isVaultLightningInput,
  vaultLightningSendEnabled,
  vaultLightningSolverProfile,
} from '../../lib/vault/lightningConfig'
import { decodeVaultLightningInvoice } from '../../lib/vault/lightningInvoice'
import { reloadIfNewerWallet } from '../../lib/vault/update'
import { isSameVtxoPayment, loadPersistedVtxoSpend } from '../../lib/vault/vtxo/spend'
import { VaultContext } from '../../vault/context'
import Scanner from './Scanner'
import DestinationField from './qg/DestinationField'
import { amountSizeStyle } from './qg/QgAmount'
import QgScreen, { QgPrimary, QgSecondary } from './qg/QgScreen'

function lightningInvoice(value: string, network?: string) {
  if (!network || !vaultLightningSendEnabled(network as NetworkName) || !isVaultLightningInput(value)) return undefined
  const profile = vaultLightningSolverProfile(network as NetworkName)
  if (!profile) return undefined
  try {
    return decodeVaultLightningInvoice(value, profile.network)
  } catch {
    return undefined
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

export default function VaultSend() {
  const {
    account,
    boardingAddress,
    busy,
    clearSendScan,
    dailyRemaining,
    error,
    fiatDisplayRate,
    navigate,
    reviewSpend,
    pendingPayments = [],
    openPendingPayment,
    canReplaceInFlightSend,
    replaceInFlightSend,
    scanOnSend,
    setSpendDraft,
    setFiatDisplay,
    spend,
    setup,
    status,
    positions,
  } = useContext(VaultContext)
  const { toast } = useToast()
  const fromSavings = account === 'savings'
  const movingToSpending = fromSavings && Boolean(boardingAddress) && spend.address === boardingAddress
  const destNetwork = status?.network
  const lightning = !fromSavings && Boolean(lightningInvoice(spend.address, destNetwork))
  const [scan, setScan] = useState(Boolean(scanOnSend))
  const [amountUnit, setAmountUnit] = useState<'sats' | 'usd'>('sats')
  const [usdInput, setUsdInput] = useState('')
  const [amountRate, setAmountRate] = useState(fiatDisplayRate)
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
        ? 'The smallest send is ₿330.'
        : spend.amount > available && !resumingPayment
          ? fromSavings
            ? 'That is more than Savings has available.'
            : 'That is more than you can send now.'
          : !fromSavings && spend.amount > setup.txCapSats
            ? `Up to ${prettyAmount(setup.txCapSats)} per payment.`
            : ''

  useEffect(() => {
    void reloadIfNewerWallet()
  }, [])

  useEffect(() => {
    if (!scanOnSend) return
    setScan(true)
  }, [scanOnSend])

  const closeScan = () => {
    if (scanOnSend) {
      clearSendScan()
      navigate('home')
      return
    }
    setScan(false)
  }

  const setAmount = (raw: string) => {
    if (amountUnit === 'usd') {
      const normalized = raw.replace(/[^\d.]/g, '')
      if (!/^\d*(?:\.\d{0,2})?$/.test(normalized)) return
      setUsdInput(normalized)
      setSpendDraft({ amount: satsFromUsd(Number(normalized) || 0, amountRate?.pricePerBtc || 0) })
      return
    }
    const digits = raw.replace(/\D/g, '')
    setSpendDraft({ amount: Number(digits) || 0 })
  }

  const toggleAmountUnit = async () => {
    if (amountUnit === 'usd') {
      setAmountUnit('sats')
      return
    }
    const rate = fiatDisplayRate || (await setFiatDisplay(true))
    if (!rate) {
      toast('USD amounts are unavailable. Try again later.')
      return
    }
    setAmountRate(rate)
    setUsdInput(spend.amount ? usdFromSats(spend.amount, rate.pricePerBtc).toFixed(2) : '')
    setAmountUnit('usd')
  }

  const setAddress = (value: string) => {
    const next = payloadFromScan(value, !fromSavings)
    const lightningAmount = fromSavings ? undefined : lightningInvoice(next.address, destNetwork)?.amountSats
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
          const lightningAmount = fromSavings ? undefined : lightningInvoice(next.address, destNetwork)?.amountSats
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
            disabled={busy || Boolean(amountError) || spend.amount <= 0 || !spend.address.trim()}
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
      <section
        className='qg-amount-entry'
        style={amountSizeStyle(amountUnit === 'usd' ? usdInput : prettyNumber(spend.amount, 0))}
      >
        <label htmlFor='qg-send-amount'>Amount</label>
        <div>
          <button
            type='button'
            className='qg-denomination'
            aria-label={`Amount in ${amountUnit === 'usd' ? 'US dollars' : 'bitcoin satoshis'}. Change denomination`}
            onClick={() => void toggleAmountUnit()}
          >
            {amountUnit === 'usd' ? '$' : '₿'}
          </button>
          <input
            id='qg-send-amount'
            value={amountUnit === 'usd' ? usdInput : spend.amount ? prettyNumber(spend.amount, 0) : ''}
            inputMode={amountUnit === 'usd' ? 'decimal' : 'numeric'}
            readOnly={lightning}
            data-testid='vault-send-amount'
            placeholder={amountUnit === 'usd' ? '0.00' : '20,000'}
            onChange={(event) => setAmount(event.target.value)}
          />
          {lightning ? null : (
            <button
              type='button'
              className='qg-max'
              onClick={() => {
                setSpendDraft({ amount: maximum })
                if (amountUnit === 'usd' && amountRate) {
                  setUsdInput(usdFromSats(maximum, amountRate.pricePerBtc).toFixed(2))
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
      </section>
      <DestinationField
        label='To'
        value={spend.address}
        name='vault-send-destination'
        placeholder={fromSavings ? 'Bitcoin address' : 'Payment address or Lightning invoice'}
        onChange={(event) => setAddress(event.target.value)}
        onScan={() => setScan(true)}
        hint={fromSavings ? 'Bitcoin address' : undefined}
      />
      {fromSavings ? (
        <p className='qg-available'>₿{prettyNumber(positions.savings.availableSats, 0)} available</p>
      ) : (
        <p className='qg-available' aria-label='Spending capacity'>
          {resumingPayment
            ? `₿${prettyNumber(reservedSats || pendingSend?.amountSats || spend.amount, 0)} reserved for this payment`
            : `₿${prettyNumber(availableSpend, 0)} available within your rolling limit`}
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
            : `Up to ${prettyAmount(setup.txCapSats)} per payment. The fee appears before approval.`}
        </p>
      )}
    </QgScreen>
  )
}
