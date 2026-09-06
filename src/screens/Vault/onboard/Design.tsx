import { useContext } from 'react'
import { VaultContext } from '../../../vault/context'
import ProtectionModel from '../qg/ProtectionModel'
import QgScreen, { QgPrimary, QgTextButton } from '../qg/QgScreen'

export default function VaultDesign({ onChooseLight }: { onChooseLight?: () => void }) {
  const { acceptDesign, enrollmentMode, lightAvailable, navigate } = useContext(VaultContext)
  return (
    <QgScreen
      title='How it works'
      stepLabel='1 of 6'
      back={() => navigate('welcome')}
      footer={
        <>
          <QgPrimary onClick={acceptDesign} label='Continue' />
          {lightAvailable && onChooseLight ? (
            <QgTextButton onClick={onChooseLight} label='Use Light without a hardware wallet' />
          ) : null}
        </>
      }
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
