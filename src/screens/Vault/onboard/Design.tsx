import { useContext } from 'react'
import { VaultContext } from '../../../vault/context'
import ProtectionModel from '../qg/ProtectionModel'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

export default function VaultDesign({ onChooseLight }: { onChooseLight?: () => void }) {
  const { acceptDesign, enrollmentMode, lightAvailable, navigate } = useContext(VaultContext)
  if (onChooseLight && lightAvailable)
    return (
      <QgScreen title='Choose your Vault' back={() => navigate('welcome')}>
        <p className='qg-eyebrow'>Light · Standard · Advanced</p>
        <h1>Choose how you keep bitcoin</h1>
        <p className='qg-copy'>
          Every setup gives you passkey payments with per-payment and rolling 24-hour limits. Choose where you want to
          keep Savings and which keys you want to manage.
        </p>
        {onChooseLight ? (
          <div className='light-plan-options' aria-label='Choose your setup'>
            <button type='button' onClick={onChooseLight}>
              <strong>Light</strong>
              <small>Passkey spending with payment and daily limits. Watch Savings in another wallet.</small>
            </button>
            <button
              type='button'
              onClick={() => {
                acceptDesign('standard')
              }}
            >
              <strong>Standard</strong>
              <small>Passkey spending and two-key Savings with your hardware wallet.</small>
            </button>
            <button
              type='button'
              onClick={() => {
                acceptDesign('advanced')
              }}
            >
              <strong>Advanced</strong>
              <small>Standard protection with a separate recovery key.</small>
            </button>
          </div>
        ) : null}
        <p className='qg-copy'>
          Light needs a passkey and a saved recovery file with its separate secret. Standard and Advanced also need a
          compatible hardware wallet; Advanced adds a separate recovery key.
        </p>
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
