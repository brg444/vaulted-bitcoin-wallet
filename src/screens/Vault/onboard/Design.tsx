import { useContext } from 'react'
import { VaultContext } from '../../../vault/context'
import ProtectionModel from '../qg/ProtectionModel'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

export default function VaultDesign({ onChooseLight }: { onChooseLight?: () => void }) {
  const { acceptDesign, enrollmentMode, lightAvailable, navigate } = useContext(VaultContext)
  if (lightAvailable && onChooseLight)
    return (
      <QgScreen title='Choose your Vault' back={() => navigate('welcome')}>
        <p className='qg-eyebrow'>Multisig protection</p>
        <h1>Choose your protection</h1>
        <p className='qg-copy'>
          Your device and Vaulted approve payments together. Add a hardware key to protect Savings with independent
          keys.
        </p>
        <div className='qg-setup-options' aria-label='Choose your setup'>
          <button type='button' onClick={onChooseLight}>
            <strong>Light</strong>
            <small>Passkey spending with payment limits. Watch Savings held in another wallet.</small>
          </button>
          <button type='button' onClick={() => acceptDesign('standard')}>
            <strong>Standard</strong>
            <small>Passkey spending, with Savings protected by your device and hardware keys.</small>
          </button>
          <button type='button' onClick={() => acceptDesign('advanced')}>
            <strong>Advanced</strong>
            <small>Standard protection, plus a separate recovery key.</small>
          </button>
        </div>
        <p className='qg-copy'>Standard and Advanced require a compatible hardware wallet.</p>
      </QgScreen>
    )
  return (
    <QgScreen
      title='How it works'
      stepLabel='1 of 6'
      back={() => navigate('welcome')}
      footer={<QgPrimary onClick={acceptDesign} label='Continue' />}
    >
      <p className='qg-eyebrow'>Spending and Savings</p>
      <h1>Everyday spending, protected savings</h1>
      <p className='qg-copy'>
        Approve everyday payments with your passkey, within the limits you choose. Savings requires two independent
        keys: the wallet key your passkey unlocks and your hardware key.
      </p>
      <ProtectionModel />
      <p className='qg-copy'>
        You’ll need {enrollmentMode === 'token' ? 'an invite and ' : ''}a hardware wallet that can sign Vaulted
        transactions. Advanced protection also needs a separate recovery key, stored independently.
      </p>
    </QgScreen>
  )
}
