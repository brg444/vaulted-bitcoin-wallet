import { useContext, useEffect, useState } from 'react'
import { Fingerprint, ShieldCheck } from 'lucide-react'
import ErrorMessage from '../../components/Error'
import { isCoarsePhone } from '../../lib/vault/webauthn'
import { VaultContext } from '../../vault/context'
import QgScreen, { QgPrimary, QgTextButton } from './qg/QgScreen'

import RecoveryHelp from './RecoveryHelp'
import InstallNotice from './qg/InstallNotice'

export default function VaultWelcome() {
  const { busy, enrollmentMode, lightAvailable, error, hasLocalEnrollment, locked, navigate, signIn } =
    useContext(VaultContext)
  const onPhone = isCoarsePhone()
  const [showHelp, setShowHelp] = useState(false)

  useEffect(() => {
    if (hasLocalEnrollment && !locked) navigate('home')
  }, [hasLocalEnrollment, locked, navigate])

  if (showHelp) return <RecoveryHelp onBack={() => setShowHelp(false)} />

  return (
    <QgScreen
      variant='welcome'
      brand
      footer={
        <>
          <QgTextButton onClick={() => setShowHelp(true)} label='Access and recovery help' />
          <ErrorMessage error={Boolean(error)} text={error} />
          {locked ? (
            <QgPrimary
              onClick={() => void signIn()}
              disabled={busy}
              loading={busy}
              label={busy ? 'Unlocking…' : error ? 'Try again' : 'Unlock vault'}
            />
          ) : (
            <QgPrimary onClick={() => navigate('design')} label='Get started' />
          )}
          {locked ? (
            <QgTextButton onClick={() => navigate('design')} label='Set up another vault' />
          ) : (
            <QgTextButton onClick={() => void signIn()} label='Sign in to an existing vault' />
          )}
          <p>
            {locked
              ? onPhone
                ? 'Use face recognition, a fingerprint, or your device PIN'
                : 'Approve with the passkey on this device'
              : lightAvailable
                ? `${enrollmentMode === 'token' ? 'An invite is required. ' : ''}Start with a passkey, or add hardware protection for Savings.`
                : enrollmentMode === 'token'
                  ? 'Setup needs an invite and a compatible hardware wallet.'
                  : 'Setup needs a compatible hardware wallet.'}
          </p>
        </>
      }
    >
      <p className='qg-eyebrow'>Bitcoin, vaulted</p>
      <h1>
        Everyday spending.
        <br />
        Protected savings.
      </h1>
      <p className='qg-lead'>
        {lightAvailable
          ? 'Pay with your passkey, within the limits you choose. Keep Savings in another wallet or protect it here with independent keys.'
          : 'Use your passkey for everyday payments and your hardware wallet for a second Savings approval.'}
      </p>
      <div className='qg-assurances'>
        <span>
          <Fingerprint />
          Passkey protected
        </span>
        <span>
          <ShieldCheck />
          {lightAvailable ? 'Choose your protection' : 'Two-key Savings'}
        </span>
      </div>
      <InstallNotice />
    </QgScreen>
  )
}
