import { useState } from 'react'
import QrCode from '../../components/QrCode'
import { copyToClipboard } from '../../lib/clipboard'
import {
  configureLightningAddress,
  loadLightningAddress,
  type LightningAddress as Address,
} from '../../lib/vault/lnurl'
import type { VaultStatus } from '../../lib/vault/types'

export default function LightningAddress({ status }: { status: VaultStatus }) {
  const [address, setAddress] = useState<Address | undefined>(() => {
    try {
      return loadLightningAddress(status)
    } catch {
      return undefined
    }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  async function configure(action: 'register' | 'revoke') {
    setBusy(true)
    setError('')
    try {
      setAddress(await configureLightningAddress(status, action))
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Lightning address setup failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className='qg-prose' aria-label='Reusable Lightning address'>
      <summary className='qg-secondary'>Lightning address</summary>
      <div className='qg-stack'>
        {address?.active ? (
          <>
            <p className='qg-copy'>
              Receive into Spending while Vaulted is closed. Fees are deducted from the amount sent, up to{' '}
              {address.maxFeeSats.toLocaleString()} sats per payment.
            </p>
            <div className='qg-receive'>
              <div className='qg-qr'>
                <QrCode value={address.lnurl} />
              </div>
            </div>
            <p className='qg-copy' style={{ overflowWrap: 'anywhere' }}>
              {address.address}
            </p>
            <button
              className='qg-secondary'
              onClick={() =>
                void copyToClipboard(address.address)
                  .then(() => setCopied(true))
                  .catch(() => setError('Could not copy the address.'))
              }
            >
              {copied ? 'Copied' : 'Copy address'}
            </button>
            <button className='qg-secondary' disabled={busy} onClick={() => void configure('revoke')}>
              {busy ? 'Updating…' : 'Disable address'}
            </button>
          </>
        ) : (
          <>
            <p className='qg-copy'>
              Create a reusable address to receive while Vaulted is closed. Confirm setup once with your passkey;
              individual payments need no approval. The receive fee comes out of the amount sent.
            </p>
            <button className='qg-secondary' disabled={busy} onClick={() => void configure('register')}>
              {busy ? 'Setting up…' : 'Set up Lightning address'}
            </button>
          </>
        )}
        {error ? (
          <p className='qg-copy' role='alert'>
            {error}
          </p>
        ) : null}
      </div>
    </details>
  )
}
