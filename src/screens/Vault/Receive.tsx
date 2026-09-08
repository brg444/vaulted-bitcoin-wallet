import LightningReceive from './LightningReceive'
import { vaultLightningReceiveEnabled } from '../../lib/vault/lightningConfig'
import ConnectorDeposit from './ConnectorDeposit'
import ConnectorSetup from './ConnectorSetup'
import { isConnectorTemplate } from '../../lib/vault/program/connector'
import { useContext, useMemo, useState } from 'react'
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

export default function VaultReceive() {
  const {
    account,
    boardingAddress,
    navigate,
    savingsAddress,
    spendingArkAddress,
    status,
    backupRecoveryArchive,
    refreshBalance,
  } = useContext(VaultContext)
  const { toast } = useToast()
  const [copied, setCopied] = useState('')
  const spending = account === 'spend'
  const [view, setView] = useState<'receive' | 'setup' | 'deposit' | 'lightning'>('receive')
  const unified = useMemo(
    () =>
      boardingAddress && spendingArkAddress
        ? encodeVaultBip21({ bitcoinAddress: boardingAddress, arkadeAddress: spendingArkAddress })
        : '',
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
    return (
      <LightningReceive
        status={status}
        backupRecoveryArchive={backupRecoveryArchive}
        refreshBalance={refreshBalance}
        onBack={() => setView('receive')}
      />
    )

  if (view === 'setup' && status)
    return <ConnectorSetup status={status} onBack={() => setView('receive')} onDeposit={() => setView('deposit')} />
  if (view === 'deposit' && status)
    return <ConnectorDeposit status={status} onBack={() => setView('setup')} onAddress={() => setView('receive')} />

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
        <span className='qg-protected'>
          {spending ? <ShieldCheck /> : <KeyRound />}
          {spending ? 'Spending limits' : 'Two-key Savings'}
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
            <AddressRow
              label='Bitcoin'
              value={boardingAddress}
              testId='receive-bitcoin-address'
              copied={copied === boardingAddress}
              onCopy={() => void copy(boardingAddress, 'Bitcoin address')}
            />
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
        <QgSecondary label='Receive Lightning' onClick={() => setView('lightning')} />
      ) : null}
      {!spending && isConnectorTemplate(status?.templateVersion) ? (
        <QgSecondary label='Set up Savings signer' onClick={() => setView('setup')} />
      ) : null}
    </QgScreen>
  )
}
