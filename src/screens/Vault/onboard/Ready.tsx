import { useContext } from 'react'
import { VaultContext } from '../../../vault/context'
import QgScreen, { QgCheck, QgPrimary, QgTextButton } from '../qg/QgScreen'
import '../qg/guidance.css'

export default function VaultReady() {
  const { navigate, networkLabel, openRecover } = useContext(VaultContext)
  return (
    <QgScreen
      variant='success'
      footer={
        <>
          <QgPrimary onClick={() => navigate('home')} label='Open your Vault' />
          <QgTextButton onClick={() => openRecover('kit', 'home')} label='Save recovery package' />
        </>
      }
    >
      <div className='qg-centered qg-success-screen'>
        <div className='qg-success-label'>
          <span>
            <QgCheck />
          </span>
          <p>Vault created</p>
        </div>
        <h1>Your vault is ready to use</h1>
        <p className='qg-copy'>You can now receive bitcoin into Spending or Savings on {networkLabel}.</p>
        <section className='qg-next'>
          <strong>Your setup</strong>
          <span>
            <QgCheck />
            Savings transfers need your passkey and hardware wallet
          </span>
          <span>
            <QgCheck />
            Your Spending limits are registered
          </span>
        </section>
        <p className='qg-backup-status' data-testid='backup-status'>
          Save a recovery package outside this device, and update it after transaction activity.
        </p>
      </div>
    </QgScreen>
  )
}
