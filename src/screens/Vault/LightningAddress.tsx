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
import { formatMoney, hasUsdRate } from '../../lib/vault/fiatDisplay'
import { useDisplayUnit } from '../../lib/vault/useDisplayUnit'
import type { VaultStatus } from '../../lib/vault/types'

export default function LightningAddress({
  status,
  primary = false,
  onChange,
}: {
  status: VaultStatus
  primary?: boolean
  onChange?: (address: Address | undefined) => void
}) {
  return (
    <LightningAddressContent
      key={`${status.network}:${status.vaultId}`}
      status={status}
      primary={primary}
      onChange={onChange}
    />
  )
}

function LightningAddressContent({
  status,
  primary,
  onChange,
}: {
  status: VaultStatus
  primary: boolean
  onChange?: (address: Address | undefined) => void
}) {
  const denomination = useDisplayUnit()
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
      const updated = await configureLightningAddress(status, action, chosen)
      setAddress(updated)
      onChange?.(updated.active ? updated : undefined)
      setEditing(false)
      setCopied(false)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Lightning address setup failed.')
    } finally {
      setBusy(false)
    }
  }
  const shareAddress = async () => {
    if (!address?.active) return
    const data = { title: 'Vaulted Lightning address', text: address.address }
    try {
      if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare(data))) {
        await navigator.share(data)
        return
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
    }
    try {
      await copyToClipboard(address.address)
      setCopied(true)
    } catch {
      setError('Could not copy the address.')
    }
  }
  const fee = address
    ? denomination.unit === 'usd' && hasUsdRate(denomination.rate)
      ? formatMoney(address.maxFeeSats, denomination)
      : `${address.maxFeeSats.toLocaleString()} sats`
    : ''
  const qr = address?.active ? (
    <div className='qg-receive'>
      <div className='qg-qr' role='img' aria-label='Lightning address QR code'>
        <QrCode value={address.lnurl} compact={primary} />
      </div>
    </div>
  ) : null
  const content = (
    <div className='qg-stack'>
      {address?.active && !editing ? (
        <>
          <p className='qg-copy'>
            Receive into Spending while Vaulted is closed. Fees are deducted from the amount sent, up to {fee} per
            payment.
          </p>
          {!primary ? qr : null}
          <p className='qg-copy' style={{ overflowWrap: 'anywhere' }}>
            {address.address}
          </p>
          <button
            type='button'
            className='qg-secondary'
            onClick={() =>
              void copyToClipboard(address.address)
                .then(() => setCopied(true))
                .catch(() => setError('Could not copy the address.'))
            }
          >
            {copied ? 'Copied' : 'Copy address'}
          </button>
          {primary ? (
            <>
              <button type='button' className='qg-secondary' onClick={() => void shareAddress()}>
                Share Lightning address
              </button>
              <details>
                <summary className='qg-secondary'>Show Lightning QR code</summary>
                {qr}
              </details>
            </>
          ) : null}
          <button
            type='button'
            className='qg-secondary'
            disabled={busy}
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
  )
  if (primary && address?.active && !editing) {
    return (
      <section className='qg-prose qg-lightning' aria-label='Lightning address'>
        <h3 className='qg-receive-caption'>Your Lightning address</h3>
        <div className='qg-qr qg-qr-modest' role='img' aria-label='Lightning address QR code'>
          <QrCode value={address.lnurl} compact={primary} />
        </div>
        <div className='qg-lightning-address'>
          <button
            type='button'
            className='qg-receive-address'
            aria-label='Copy address'
            onClick={() =>
              void copyToClipboard(address.address)
                .then(() => setCopied(true))
                .catch(() => setError('Could not copy the address.'))
            }
          >
            <strong style={{ overflowWrap: 'anywhere', whiteSpace: 'normal', minWidth: 0 }}>{address.address}</strong>
            <span>{copied ? 'Copied' : 'Copy address'}</span>
          </button>
        </div>
        <details>
          <summary className='qg-receive-manage'>Address options</summary>
          <div className='qg-stack'>
            <button type='button' className='qg-secondary' onClick={() => void shareAddress()}>
              Share Lightning address
            </button>
            <button
              type='button'
              className='qg-secondary'
              disabled={busy}
              onClick={() => {
                setName(address.name && address.name !== address.id ? address.name : '')
                setError('')
                setEditing(true)
              }}
            >
              Edit address
            </button>
            <button type='button' className='qg-secondary' disabled={busy} onClick={() => void configure('revoke')}>
              {busy ? 'Updating…' : 'Disable address'}
            </button>
          </div>
        </details>
        {error ? (
          <p className='qg-copy' role='alert'>
            {error}
          </p>
        ) : null}
      </section>
    )
  }
  if (primary && address?.active) {
    return (
      <section className='qg-prose' aria-label='Lightning address'>
        <h3 className='qg-eyebrow'>Lightning</h3>
        {content}
      </section>
    )
  }
  return (
    <details className='qg-prose' aria-label='Reusable Lightning address'>
      <summary className='qg-secondary'>{primary ? 'Set up Lightning address' : 'Lightning address'}</summary>
      {content}
    </details>
  )
}
