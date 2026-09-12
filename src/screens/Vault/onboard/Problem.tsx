import { useContext } from 'react'
import { CircleHelp } from 'lucide-react'
import '../qg/guidance.css'
import { VaultContext } from '../../../vault/context'
import WalletScreen from '../qg/WalletScreen'
import { QgPrimary, QgSecondary } from '../qg/QgScreen'

export default function VaultProblem() {
  const { enrollmentMode, error, navigate } = useContext(VaultContext)
  return (
    <WalletScreen
      title='Setup help'
      back={() => navigate('passkey')}
      footer={
        <>
          <QgPrimary onClick={() => navigate('passkey')} label='Return to setup' />
          <QgSecondary onClick={() => navigate('signin')} label='I already have a vault' />
        </>
      }
    >
      <p className='qg-eyebrow'>Before trying again</p>
      <h1>Check what stopped setup</h1>
      <p className='qg-copy'>
        {error ||
          'A passkey prompt or connection problem may interrupt setup. Use the steps below for the problem you saw.'}
      </p>
      <section className='qg-alert'>
        <CircleHelp />
        <div>
          <strong>If setup may have finished</strong>
          <p>Try signing in with the passkey you created before starting another vault.</p>
        </div>
      </section>
      {enrollmentMode === 'token' ? (
        <details className='qg-guidance'>
          <summary>The invite was rejected</summary>
          <div className='qg-guidance-body'>
            <p>
              Check that you pasted the complete invite. It may have expired or already been used; ask the person who
              shared it for a new one if needed.
            </p>
          </div>
        </details>
      ) : null}
      <details className='qg-guidance'>
        <summary>The passkey prompt failed or closed</summary>
        <div className='qg-guidance-body'>
          <p>
            Return to setup and try the prompt again. Use a browser and passkey provider that support Vaulted’s unlock
            requirements; a successful device check alone does not confirm that support.
          </p>
        </div>
      </details>
      <details className='qg-guidance'>
        <summary>The service could not be reached</summary>
        <div className='qg-guidance-body'>
          <p>
            Check your connection and try signing in if you already created a passkey. Keep app data intact while you
            check whether setup completed.
          </p>
        </div>
      </details>
    </WalletScreen>
  )
}
