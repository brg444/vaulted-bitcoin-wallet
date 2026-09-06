import { useContext, useState } from 'react'
import { Fingerprint } from 'lucide-react'
import ErrorMessage from '../../components/Error'
import { isCoarsePhone } from '../../lib/vault/webauthn'
import { VaultContext } from '../../vault/context'
import QgScreen, { QgPrimary, QgTextButton } from './qg/QgScreen'

import RecoveryHelp from './RecoveryHelp'

export default function VaultUnlock() {
  const { busy, error, signIn, restoreRecoveryArchive } = useContext(VaultContext)
  const onPhone = isCoarsePhone()
  const [showHelp, setShowHelp] = useState(false)

  if (showHelp) return <RecoveryHelp onBack={() => setShowHelp(false)} />

  return (
    <QgScreen
      variant='unlock'
      footer={
        <>
          <QgTextButton onClick={() => setShowHelp(true)} label='Access and recovery help' />
          <QgTextButton
            onClick={() => void restoreRecoveryArchive().catch(() => undefined)}
            label='Restore encrypted cloud backup'
          />
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
    </QgScreen>
  )
}
