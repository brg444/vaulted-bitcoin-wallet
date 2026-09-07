import { useContext, useState } from 'react'
import { Clipboard } from 'lucide-react'
import ErrorMessage from '../../../components/Error'
import { pasteFromClipboard } from '../../../lib/clipboard'
import { VaultContext } from '../../../vault/context'
import RecoveryExplanation from '../qg/RecoveryExplanation'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

export default function VaultRecovery() {
  const { applyRecovery, error, navigate, setup, networkLabel } = useContext(VaultContext)
  const [value, setValue] = useState(setup.recoveryPub)
  return (
    <QgScreen
      title='Recovery key'
      stepLabel='3 of 6'
      back={() => navigate('hardware')}
      footer={
        <>
          <ErrorMessage error={Boolean(error)} text={error || ''} />
          <QgPrimary onClick={() => applyRecovery(value)} disabled={!value.trim()} label='Use this recovery key' />
        </>
      }
    >
      <h1>Add your recovery key</h1>
      <p className='qg-copy'>Use an independent key, stored separately from your passkey and hardware backup.</p>
      <label className='qg-field'>
        <span>Recovery public key</span>
        <input
          value={value}
          data-testid='recovery-pub'
          aria-label='Recovery public key'
          placeholder='02… or 03…'
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button
        type='button'
        className='qg-paste'
        onClick={() => void pasteFromClipboard().then((next) => setValue(next || value))}
      >
        <Clipboard />
        Paste public key
      </button>
      <p className='qg-copy'>
        This key can start delayed Savings recovery if both normal keys are lost. Starting recovery requires the
        recovery services. Your protection choice is fixed after setup.
      </p>
      <RecoveryExplanation advanced mainnet={networkLabel === 'Bitcoin'} />
      <button type='button' className='qg-text' onClick={() => navigate('design')}>
        Change protection
      </button>
    </QgScreen>
  )
}
