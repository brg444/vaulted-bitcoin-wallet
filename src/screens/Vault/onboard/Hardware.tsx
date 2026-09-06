import { useContext, useState } from 'react'
import { Clipboard, TriangleAlert } from 'lucide-react'
import ErrorMessage from '../../../components/Error'
import { pasteFromClipboard } from '../../../lib/clipboard'
import { VaultContext } from '../../../vault/context'
import '../qg/guidance.css'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

export default function VaultHardware() {
  const { applyConnectorDescriptor, applyHardware, error, navigate, setup, status } = useContext(VaultContext)
  const required = status?.externalOwnerWalletPub || ''
  const [value, setValue] = useState(required || setup.connector?.descriptor || '')
  const connector = setup.connector

  const ready = Boolean(required || value.trim())

  const submit = () => {
    const raw = (required || value).trim()
    if (required) applyHardware(required)
    else applyConnectorDescriptor(raw)
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
      <p className='qg-eyebrow'>Protect Savings</p>
      <h1>Add your hardware key</h1>
      <p className='qg-copy'>
        {required
          ? 'This vault already has a hardware key. Check that you can still use the hardware wallet that holds it.'
          : 'Savings transfers need approval from your signing wallet as well as your passkey. Paste the public output descriptor from Sparrow: the app derives the signer reserve address and never asks for a seed phrase or private key.'}
      </p>
      <label className='qg-field'>
        <span>Wallet descriptor</span>
        <textarea
          value={value}
          readOnly={Boolean(required)}
          data-testid='hardware-pub'
          aria-label='Wallet descriptor'
          placeholder='wpkh([fingerprint/path]xpub…/<0;1>/*)'
          onChange={(event) => setValue(event.target.value)}
          rows={3}
        />
        <small>wpkh or tr descriptor with a fingerprint origin, available from Sparrow</small>
      </label>
      {connector ? (
        <section className='qg-note' data-testid='connector-import-result'>
          <div>
            <strong>Signer reserve address</strong>
            <p data-testid='connector-import-address'>{connector.address}</p>
            <p>{connector.selectedPath}</p>
            <p>
              Send exactly 1,000 sats to this address for the signer reserve. Savings deposits use a separate address
              shown after setup.
            </p>
          </div>
        </section>
      ) : null}
      {required ? null : (
        <button
          type='button'
          className='qg-paste'
          onClick={() => void pasteFromClipboard().then((next) => setValue(next || value))}
        >
          <Clipboard />
          Paste descriptor
        </button>
      )}
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
