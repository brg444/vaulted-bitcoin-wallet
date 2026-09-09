import { useState } from 'react'
import QrCode from '../../components/QrCode'
import { copyToClipboard } from '../../lib/clipboard'
import {
  configureLightningAddress,
  loadLightningAddress,
  lightningNameAvailable,
  validLightningName,
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
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  async function configure(action: 'register' | 'revoke') {
    setBusy(true)
    setError('')
    try {
      const chosen = action === 'register' ? name.trim().toLowerCase() : ''
      if (action === 'register') {
        if (!validLightningName(chosen))
          throw new Error('Use 3–32 characters, starting with a letter: a–z, 0–9, hyphens or underscores.')
        if (chosen !== address?.name && !(await lightningNameAvailable(chosen, address)))
          throw new Error('That name is unavailable. Please choose another.')
      }
      setAddress(await configureLightningAddress(status, action, chosen))
      setEditing(false)
      setCopied(false)
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
        {address?.active && !editing ? (
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
            <button
              className='qg-secondary'
              onClick={() => {
                setName(address.name && address.name !== address.id ? address.name : '')
                setError('')
                setEditing(true)
              }}
            >
              Edit address
            </button>
            <button className='qg-secondary' disabled={busy} onClick={() => void configure('revoke')}>
              {busy ? 'Updating…' : 'Disable address'}
            </button>
          </>
        ) : (
          <>
            <p className='qg-copy'>
              {editing
                ? 'Choose a new address name and confirm with your passkey.'
                : 'Create a reusable address to receive while Vaulted is closed. Confirm setup once with your passkey; individual payments need no approval. The receive fee comes out of the amount sent.'}
            </p>
            <label className='qg-field' htmlFor='lightning-address-name'>
              <span>Address name</span>
              <input
                id='lightning-address-name'
                value={name}
                maxLength={32}
                autoCapitalize='none'
                autoCorrect='off'
                spellCheck={false}
                autoComplete='off'
                placeholder='yourname'
                aria-describedby='lightning-address-preview'
                onChange={(event) => {
                  setName(event.target.value.toLowerCase())
                  setError('')
                }}
                disabled={busy}
              />
            </label>
            <p id='lightning-address-preview' className='qg-copy' style={{ overflowWrap: 'anywhere' }}>
              {name.trim() || 'yourname'}@ln.getvaulted.xyz
            </p>
            {editing ? <p className='qg-copy'>Previously shared addresses will keep working for this wallet.</p> : null}
            <button className='qg-secondary' disabled={busy || !name.trim()} onClick={() => void configure('register')}>
              {busy ? 'Updating…' : editing ? 'Save address' : 'Set up Lightning address'}
            </button>
            {editing ? (
              <button
                className='qg-secondary'
                disabled={busy}
                onClick={() => {
                  setEditing(false)
                  setError('')
                }}
              >
                Cancel
              </button>
            ) : null}
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
