import { useContext, useState } from 'react'
import { Clipboard, TriangleAlert } from 'lucide-react'
import ErrorMessage from '../../../components/Error'
import { pasteFromClipboard } from '../../../lib/clipboard'
import { VaultContext } from '../../../vault/context'
import '../qg/guidance.css'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

export default function VaultHardware() {
  const { applyConnectorDescriptor, error, navigate, setup } = useContext(VaultContext)
  const [value, setValue] = useState(setup.complete ? '' : setup.connector?.descriptor || '')

  const ready = Boolean(value.trim())

  const submit = () => {
    applyConnectorDescriptor(value.trim())
  }

  return (
    <QgScreen
      title='Hardware key'
      stepLabel='2 of 6'
      back={() => navigate('design')}
      footer={
        <>
          <ErrorMessage error={Boolean(error)} text={error || ''} />
          <QgPrimary onClick={submit} disabled={!ready} label='Use this hardware key' />
        </>
      }
    >
      <h1>Add your hardware key</h1>
      <p className='qg-copy'>
        Paste your public wallet descriptor from Sparrow. This wallet will provide the second approval for Savings
        transfers.
      </p>
      <label className='qg-field'>
        <span>Wallet descriptor</span>
        <textarea
          value={value}
          data-testid='hardware-pub'
          aria-label='Wallet descriptor'
          placeholder='wpkh([fingerprint/path]xpub…/<0;1>/*)'
          onChange={(event) => setValue(event.target.value)}
          rows={3}
        />
        <small>Supports native SegWit (wpkh) and Taproot (tr) descriptors</small>
      </label>
      <button
        type='button'
        className='qg-paste'
        onClick={() => void pasteFromClipboard().then((next) => setValue(next || value))}
      >
        <Clipboard />
        Paste descriptor
      </button>
      <details className='qg-guidance'>
        <summary>Find and check your wallet descriptor</summary>
        <div className='qg-guidance-body'>
          <p>
            In Sparrow, open Settings, then Export and choose Output Descriptor. Copy one wpkh or tr descriptor with its
            fingerprint and derivation path. Electrum can sign compatible native SegWit transactions, but preparing its
            public descriptor requires its master public key, fingerprint, and derivation path.
          </p>
          <p>
            The app selects the first address from a ranged descriptor and the receive branch from a multipath
            descriptor. The 1,000-sat reserve returns to that same address in each transfer; Savings pays the fee.
          </p>
          <p>
            Before depositing, confirm that your signing workflow supports Vaulted’s Savings transactions. Accepting a
            descriptor here checks its format, not whether your signer can sign.
          </p>
        </div>
      </details>
      <section className='qg-note'>
        <TriangleAlert />
        <div>
          <strong>Public descriptor only</strong>
          <p>Never enter a seed phrase or private key.</p>
        </div>
      </section>
    </QgScreen>
  )
}
