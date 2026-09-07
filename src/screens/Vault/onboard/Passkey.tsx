import { useContext, useEffect, useState } from 'react'
import { Clipboard, Fingerprint } from 'lucide-react'
import ErrorMessage from '../../../components/Error'
import { pasteFromClipboard } from '../../../lib/clipboard'
import { isPlatformPasskeyAvailable } from '../../../lib/vault/webauthn'
import { VaultContext } from '../../../vault/context'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

export default function VaultPasskey() {
  const { busy, enroll, enrollmentMode, error, navigate } = useContext(VaultContext)
  const [token, setToken] = useState('')
  const [passkeyAvailable, setPasskeyAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    void isPlatformPasskeyAvailable().then((available) => {
      if (active) setPasskeyAvailable(available)
    })
    return () => {
      active = false
    }
  }, [])

  const inviteOnly = enrollmentMode === 'token'
  const accessReady = enrollmentMode === 'open' || (inviteOnly && token.trim().length >= 32)
  return (
    <QgScreen
      title='Secure this device'
      stepLabel='6 of 6'
      back={() => navigate('plan')}
      footer={
        <>
          <ErrorMessage error={Boolean(error)} text={error || ''} />
          <QgPrimary
            onClick={() => void enroll(inviteOnly ? token.trim() : '')}
            disabled={busy || !accessReady || passkeyAvailable !== true}
            icon={<Fingerprint />}
            label={busy ? 'Check your device…' : 'Create Vault'}
          />
        </>
      }
    >
      <h1>Create your passkey</h1>
      <p className='qg-copy'>
        Approve with face recognition, a fingerprint, or your device PIN. Your passkey unlocks the wallet key; biometric
        data stays on your device.
      </p>
      <section className='qg-device-key'>
        <Fingerprint />
        <span>
          <strong>
            {passkeyAvailable === null
              ? 'Checking passkey support…'
              : passkeyAvailable
                ? 'Device supports passkeys'
                : 'Passkey unavailable'}
          </strong>
          <small>
            {passkeyAvailable === false
              ? 'Open Vaulted in Safari or Chrome on a phone or computer with Face ID, Touch ID, or a device PIN.'
              : passkeyAvailable === null
                ? 'Checking this browser and device'
                : 'Vaulted will check the required unlock support when you create your passkey.'}
          </small>
        </span>
      </section>
      {error ? (
        <button type='button' className='qg-text' onClick={() => navigate('problem')}>
          Setup help
        </button>
      ) : null}
      {passkeyAvailable === false ? <div data-testid='passkey-unavailable' className='qg-visually-hidden' /> : null}
      {enrollmentMode === 'loading' ? <p role='status'>Checking setup availability…</p> : null}
      {inviteOnly ? (
        <>
          <label className='qg-field'>
            <span>One-time invite</span>
            <input
              value={token}
              data-testid='enrollment-token'
              aria-label='One-time invite'
              placeholder='Paste your invite'
              onChange={(event) => setToken(event.target.value)}
            />
            <small>Your invite can create one vault and is checked when you continue.</small>
          </label>
          <button
            type='button'
            className='qg-paste'
            onClick={() => void pasteFromClipboard().then((next) => setToken(next || token))}
          >
            <Clipboard />
            Paste invite
          </button>
        </>
      ) : null}
    </QgScreen>
  )
}
