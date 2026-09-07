import { useContext } from 'react'
import { Fingerprint } from 'lucide-react'
import ErrorMessage from '../../../components/Error'
import { isCoarsePhone } from '../../../lib/vault/webauthn'
import { VaultContext } from '../../../vault/context'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

export default function VaultSignIn() {
  const { busy, error, navigate, signIn } = useContext(VaultContext)
  const onPhone = isCoarsePhone()

  return (
    <QgScreen
      title='Sign in'
      back={() => navigate('welcome')}
      footer={
        <>
          <ErrorMessage error={Boolean(error)} text={error} />
          <QgPrimary
            onClick={() => void signIn()}
            disabled={busy}
            loading={busy}
            icon={<Fingerprint />}
            label={busy ? 'Waiting for passkey…' : error ? 'Try again' : 'Sign in with passkey'}
          />
        </>
      }
    >
      <p className='qg-eyebrow'>Existing vault</p>
      <h1>Sign in with your passkey</h1>
      <p className='qg-copy'>
        Use the passkey saved during setup. Your browser may offer a saved passkey or a QR code for another device;
        follow the options it provides.
      </p>
      <section className='qg-device-key'>
        <Fingerprint />
        <span>
          <strong>This device</strong>
          <small>
            {onPhone
              ? 'Approve with face recognition, a fingerprint, or your device PIN when prompted.'
              : 'Choose your existing vault passkey when the browser prompts you.'}
          </small>
        </span>
      </section>
    </QgScreen>
  )
}
