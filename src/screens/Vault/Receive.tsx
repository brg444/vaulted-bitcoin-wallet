import SpendingReceive from './SpendingReceive'
import { lightningAddressEnabled } from '../../lib/vault/lnurl'
import LightningReceive from './LightningReceive'
import { vaultLightningReceiveEnabled } from '../../lib/vault/lightningConfig'
import PaymentArrivalBanners from './PaymentArrivals'
import CatchUpBanner from './CatchUpBanner'
import ConnectorDeposit from './ConnectorDeposit'
import ConnectorSetup from './ConnectorSetup'
import { isConnectorTemplate } from '../../lib/vault/program/connector'
import { useContext, useEffect, useMemo, useState } from 'react'
import { KeyRound, Share2, ShieldCheck } from 'lucide-react'
import { useToast } from '../../components/Toast'
import QrCode from '../../components/QrCode'
import { copyToClipboard } from '../../lib/clipboard'
import { encodeVaultBip21 } from '../../lib/vault/bip21'
import { truncateAddress } from '../../lib/vault/policy'
import { VaultContext } from '../../vault/context'
import QgScreen, { QgPrimary, QgSecondary } from './qg/QgScreen'

function AddressRow({
  label,
  value,
  testId,
  copied,
  onCopy,
}: {
  label: string
  value: string
  testId: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <button type='button' data-testid={testId} onClick={onCopy}>
      <span>
        <small>{label}</small>
        <strong>{truncateAddress(value, 10)}</strong>
      </span>
      <b>{copied ? 'Copied' : 'Copy'}</b>
    </button>
  )
}

/** Visible receive polling, matching the Lightning invoice screen cadence. */
const RECEIVE_POLL_MS = 5000

export default function VaultReceive() {
  const {
    account,
    boardingAddress,
    navigate,
    savingsAddress,
    spendingArkAddress,
    status,
    refreshBalance,
    arrivals = [],
    dismissArrival,
    openArrival,
    catchUp,
    dismissCatchUp,
  } = useContext(VaultContext)
  const { toast } = useToast()
  const [copied, setCopied] = useState('')
  const spending = account === 'spend'
  const [view, setView] = useState<'receive' | 'setup' | 'deposit' | 'lightning'>('receive')
  useEffect(() => {
    // A payment arriving while the request screen is open must surface
    // without waiting for a worker event, focus change, or manual refresh.
    // Polling reuses the ordinary balance refresh, so detection, baseline,
    // and dedup behave exactly as elsewhere. The Lightning invoice screen
    // polls on its own; skip while it owns the view.
    if (view !== 'receive') return
    let stopped = false
    let inFlight = false
    const poll = () => {
      if (stopped || inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      void refreshBalance()
        .catch(() => {
          // Balance refresh reports through context state.
        })
        .finally(() => {
          inFlight = false
        })
    }
    poll()
    const timer = window.setInterval(poll, RECEIVE_POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [view, refreshBalance])
  const unified = useMemo(
    () =>
      boardingAddress && spendingArkAddress
        ? encodeVaultBip21({ bitcoinAddress: boardingAddress, arkadeAddress: spendingArkAddress })
        : spendingArkAddress,
    [boardingAddress, spendingArkAddress],
  )
  const request = spending ? unified : savingsAddress

  const copy = async (value: string, label: string) => {
    if (!value) return
    await copyToClipboard(value)
    setCopied(value)
    toast(`${label} copied`)
  }

  const shareRequest = async () => {
    if (!request) return
    const data = {
      title: spending ? 'Vaulted payment request' : 'Vaulted Savings address',
      text: request,
    }
    try {
      if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare(data))) {
        await navigator.share(data)
        return
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
    }
    await copy(request, spending ? 'Payment request' : 'Savings address')
  }

  if (view === 'lightning' && spending && status)
    return <LightningReceive status={status} refreshBalance={refreshBalance} onBack={() => setView('receive')} />

  if (view === 'setup' && status && isConnectorTemplate(status.templateVersion))
    return <ConnectorSetup status={status} onBack={() => setView('receive')} onDeposit={() => setView('deposit')} />
  if (view === 'deposit' && status && isConnectorTemplate(status.templateVersion))
    return <ConnectorDeposit status={status} onBack={() => setView('setup')} onAddress={() => setView('receive')} />

  if (spending && status && lightningAddressEnabled() && vaultLightningReceiveEnabled(status.network, status.vaultId))
    return (
      <SpendingReceive
        status={status}
        fastAddress={spendingArkAddress}
        bitcoinAddress={boardingAddress}
        onClose={() => navigate('home')}
        onInvoice={() => setView('lightning')}
        arrivals={
          <>
            <PaymentArrivalBanners
              arrivals={arrivals}
              onOpen={(arrival) => openArrival(arrival.key)}
              onDismiss={dismissArrival}
            />
            {catchUp ? (
              <CatchUpBanner
                catchUp={catchUp}
                onOpenActivity={() => navigate('activity')}
                onDismiss={dismissCatchUp}
              />
            ) : null}
          </>
        }
      />
    )

  return (
    <QgScreen
      title='Receive'
      dismiss={() => navigate('home')}
      footer={
        <QgPrimary
          onClick={() => void shareRequest()}
          disabled={!request}
          icon={<Share2 />}
          testId='receive-share'
          label='Share'
        />
      }
    >
      <div className='qg-receive'>
        <PaymentArrivalBanners
          arrivals={arrivals}
          onOpen={(arrival) => openArrival(arrival.key)}
          onDismiss={dismissArrival}
        />
        {catchUp ? (
          <CatchUpBanner
            catchUp={catchUp}
            onOpenActivity={() => navigate('activity')}
            onDismiss={dismissCatchUp}
          />
        ) : null}
        <span className='qg-protected'>
          {spending ? <ShieldCheck /> : <KeyRound />}
          {spending ? 'Spending limits' : status?.protectionTier === 'light' ? 'Watch-only Savings' : 'Two-key Savings'}
        </span>
        {request ? (
          <div className='qg-qr' role='img' aria-label='Payment request QR code'>
            <QrCode large value={request} />
          </div>
        ) : (
          <p className='qg-copy'>
            {spending
              ? 'Spending receive is unavailable. Return to the wallet and try again.'
              : 'Savings is not restored on this device. Sign in again to restore it.'}
          </p>
        )}
        {spending ? (
          <section className='qg-addresses' aria-label='Payment addresses'>
            <AddressRow
              label='Fast'
              value={spendingArkAddress}
              testId='receive-arkade-address'
              copied={copied === spendingArkAddress}
              onCopy={() => void copy(spendingArkAddress, 'Fast payment address')}
            />
            {boardingAddress ? (
              <AddressRow
                label='Bitcoin'
                value={boardingAddress}
                testId='receive-bitcoin-address'
                copied={copied === boardingAddress}
                onCopy={() => void copy(boardingAddress, 'Bitcoin address')}
              />
            ) : null}
          </section>
        ) : savingsAddress ? (
          <section className='qg-addresses' aria-label='Payment addresses'>
            <AddressRow
              label='Bitcoin'
              value={savingsAddress}
              testId='receive-address'
              copied={copied === savingsAddress}
              onCopy={() => void copy(savingsAddress, 'Savings address')}
            />
          </section>
        ) : null}
      </div>
      {spending && vaultLightningReceiveEnabled(status?.network, status?.vaultId) ? (
        <QgSecondary label='Create invoice' onClick={() => setView('lightning')} />
      ) : null}
      {!spending && isConnectorTemplate(status?.templateVersion) ? (
        <QgSecondary label='Set up Savings signer' onClick={() => setView('setup')} />
      ) : null}
    </QgScreen>
  )
}
