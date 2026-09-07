import { useContext } from 'react'
import { VaultContext } from '../../../vault/context'
import QgScreen from '../qg/QgScreen'

export default function VaultDesign({ onChooseLight }: { onChooseLight?: () => void }) {
  const { acceptDesign, lightAvailable, navigate } = useContext(VaultContext)
  return (
    <QgScreen title='Choose your Vault' stepLabel='1 of 6' back={() => navigate('welcome')}>
      <h1>Choose your protection</h1>
      <div className='qg-setup-options' aria-label='Choose your setup'>
        {lightAvailable && onChooseLight ? (
          <button type='button' onClick={onChooseLight}>
            <strong>Light</strong>
            <small>Passkey payments. Watch Savings held in another wallet.</small>
          </button>
        ) : null}
        <button type='button' onClick={() => acceptDesign('standard')}>
          <strong>Standard</strong>
          <small>Passkey payments and Savings protected by your hardware wallet.</small>
        </button>
        <button type='button' onClick={() => acceptDesign('advanced')}>
          <strong>Advanced</strong>
          <small>Standard protection, plus a separate key for delayed Savings recovery.</small>
        </button>
      </div>
      <p className='qg-copy'>
        Standard and Advanced require a compatible hardware wallet. Your protection choice is fixed after setup.
      </p>
    </QgScreen>
  )
}
