import { useSession } from '../../vault/sessionContext'
import { Fingerprint } from 'lucide-react'
import ErrorMessage from '../../components/Error'
import { isCoarsePhone } from '../../lib/vault/webauthn'
import { useVaultInteraction } from '../../vault/appContexts'
import WalletScreen from './qg/WalletScreen'
import { QgPrimary } from './qg/QgScreen'

export default function VaultUnlock() {
  const { signIn } = useSession()
  const { busy, error } = useVaultInteraction()
  const onPhone = isCoarsePhone()

  return (
    <WalletScreen
      variant='unlock'
      footer={
        <>
          <ErrorMessage error={Boolean(error)} text={error} />
          <QgPrimary
            onClick={() => void signIn()}
            disabled={busy}
            loading={busy}
            icon={<Fingerprint />}
            testId='privacy-unlock'
            label={busy ? 'Unlocking…' : error ? 'Try again' : 'Unlock with passkey'}
          />
          <p>
            {onPhone
              ? 'Face recognition, a fingerprint, or your device PIN'
              : 'Approve with the passkey on this device'}
          </p>
        </>
      }
    >
      <div className='qg-unlock'>
        <span className='qg-unlock-mark' aria-hidden='true'>
          <Fingerprint />
        </span>
        <h1>Unlock</h1>
        <p className='qg-copy'>This vault stays hidden until this device approves.</p>
      </div>
    </WalletScreen>
  )
}
