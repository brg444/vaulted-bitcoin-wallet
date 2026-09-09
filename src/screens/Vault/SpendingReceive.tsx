import { useState } from 'react'
import { ArrowDownLeft, Bitcoin, Share2, Zap } from 'lucide-react'
import QrCode from '../../components/QrCode'
import { useToast } from '../../components/Toast'
import { copyToClipboard } from '../../lib/clipboard'
import { loadLightningAddress, type LightningAddress as Address } from '../../lib/vault/lnurl'
import type { VaultStatus } from '../../lib/vault/types'
import ReceiveMethods, { LightningReceiveMethod } from './qg/ReceiveMethods'
import QgScreen, { QgPrimary } from './qg/QgScreen'

export default function SpendingReceive(props: {
  status: VaultStatus
  fastAddress: string
  bitcoinAddress?: string
  onClose: () => void
  onInvoice: () => void
}) {
  return <ReceiveContent key={`${props.status.network}:${props.status.vaultId}`} {...props} />
}

function ReceiveContent({
  status,
  fastAddress,
  bitcoinAddress,
  onClose,
  onInvoice,
}: Parameters<typeof SpendingReceive>[0]) {
  const { toast } = useToast()
  const [address, setAddress] = useState<Address | undefined>(() => {
    try {
      const saved = loadLightningAddress(status)
      return saved?.active ? saved : undefined
    } catch {
      return undefined
    }
  })
  const [method, setMethod] = useState(address ? 'lightning' : 'fast')
  const [copied, setCopied] = useState('')
  const payload =
    method === 'lightning'
      ? address?.active
        ? address.address
        : ''
      : method === 'bitcoin'
        ? bitcoinAddress || ''
        : fastAddress
  const copy = async (value: string) => {
    try {
      await copyToClipboard(value)
      setCopied(value)
      toast('Address copied')
    } catch {
      toast('Could not copy the address')
    }
  }
  const share = async () => {
    if (!payload) return
    const data = {
      title: `Vaulted ${method === 'lightning' ? 'Lightning' : method === 'bitcoin' ? 'Bitcoin' : 'Spending'} address`,
      text: payload,
    }
    try {
      if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare(data))) {
        await navigator.share(data)
        return
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
    }
    await copy(payload)
  }
  const addressMethod = (value: string, bitcoin = false) => (
    <section
      className='qg-receive-destination'
      aria-label={bitcoin ? 'Bitcoin payment address' : 'Fast payment address'}
    >
      {value ? (
        <>
          <div
            className='qg-qr qg-qr-modest'
            role='img'
            aria-label={bitcoin ? 'Bitcoin address QR code' : 'Fast payment QR code'}
          >
            <QrCode value={value} />
          </div>
          <p className='qg-receive-caption'>{bitcoin ? 'Your Bitcoin address' : 'Your Arkade address'}</p>
          <button
            className='qg-receive-address'
            type='button'
            data-testid={bitcoin ? 'receive-bitcoin-address' : 'receive-arkade-address'}
            onClick={() => void copy(value)}
          >
            <strong>{value}</strong>
            <span>{copied === value ? 'Copied' : 'Copy address'}</span>
          </button>
          <p className='qg-receive-note'>
            {bitcoin
              ? 'Available in Spending after Bitcoin confirmation.'
              : 'Receive directly into Spending from an Arkade wallet.'}
          </p>
        </>
      ) : (
        <p className='qg-copy'>This receiving address is unavailable. Return to the wallet and try again.</p>
      )}
    </section>
  )
  return (
    <QgScreen
      title='Receive'
      dismiss={onClose}
      footer={
        <QgPrimary
          label='Share address'
          testId='receive-share'
          icon={<Share2 />}
          disabled={!payload}
          onClick={() => void share()}
        />
      }
    >
      <ReceiveMethods
        activeId={method}
        onChange={setMethod}
        methods={[
          {
            id: 'lightning',
            label: 'Lightning',
            icon: <Zap />,
            render: () => <LightningReceiveMethod status={status} onAddress={setAddress} onInvoice={onInvoice} />,
          },
          { id: 'fast', label: 'Fast', icon: <ArrowDownLeft />, render: () => addressMethod(fastAddress) },
          ...(bitcoinAddress
            ? [
                {
                  id: 'bitcoin',
                  label: 'Bitcoin',
                  icon: <Bitcoin />,
                  render: () => addressMethod(bitcoinAddress, true),
                },
              ]
            : []),
        ]}
      />
    </QgScreen>
  )
}
