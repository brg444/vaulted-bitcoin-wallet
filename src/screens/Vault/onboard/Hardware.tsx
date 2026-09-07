import { useContext, useRef, useState } from 'react'
import { Clipboard, QrCode, Upload, TriangleAlert } from 'lucide-react'
import Scanner from '../Scanner'
import { readDescriptorFile } from '../../../lib/vault/descriptorImport'
import ErrorMessage from '../../../components/Error'
import { VaultContext } from '../../../vault/context'
import '../qg/guidance.css'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

export default function VaultHardware() {
  const { applyConnectorDescriptor, error, navigate, setup, status, liveNetwork } = useContext(VaultContext)
  const [value, setValue] = useState(setup.complete ? '' : setup.connector?.descriptor || '')

  const [editing, setEditing] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [importError, setImportError] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const decoder = useRef<import('../../../lib/vault/descriptorQr').DescriptorQrDecoder | null>(null)
  const network = status?.network === 'mutinynet' || liveNetwork ? 'mutinynet' : 'mainnet'
  const ready = Boolean(value.trim()) && !importBusy
  const scan = async () => {
    setImportError('')
    setImportBusy(true)
    try {
      const { DescriptorQrDecoder } = await import('../../../lib/vault/descriptorQr')
      decoder.current = new DescriptorQrDecoder(network)
      setProgress(0)
      setScanning(true)
    } catch {
      setImportError('The scanner could not load. Try again, upload a file, or paste your descriptor.')
    } finally {
      setImportBusy(false)
    }
  }
  if (scanning)
    return (
      <Scanner
        label='Scan wallet descriptor'
        message={
          progress > 0
            ? `Reading animated QR… ${Math.round(progress * 100)}%`
            : 'Show your wallet’s descriptor QR code inside the frame'
        }
        close={() => setScanning(false)}
        manual={() => setScanning(false)}
        onError={() => {
          setScanning(false)
          setImportError('Camera unavailable. Upload a file or paste your descriptor.')
        }}
        onData={(raw) => {
          try {
            const result = decoder.current!.receive(raw)
            if (!result.descriptor) {
              setProgress(result.progress)
              return false
            }
            setValue(result.descriptor)
            setEditing(false)
            setScanning(false)
          } catch {
            setImportError(
              'This QR code could not be imported. Use a public descriptor QR or upload the descriptor file.',
            )
            setScanning(false)
          }
        }}
      />
    )

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
        Scan or upload a public descriptor exported from your wallet. You’ll use that wallet to provide the second
        approval for Savings transfers.
      </p>
      <div className='qg-import-actions'>
        <button type='button' disabled={importBusy} onClick={() => void scan()} aria-label='Scan descriptor QR code'>
          <QrCode />
          Scan QR
        </button>
        <button
          type='button'
          disabled={importBusy}
          onClick={() => fileInput.current?.click()}
          aria-label='Upload descriptor file'
        >
          <Upload />
          Upload
        </button>
        <button
          type='button'
          disabled={importBusy}
          onClick={() => {
            setEditing(true)
            setImportError('')
          }}
        >
          <Clipboard />
          Paste
        </button>
      </div>
      {editing ? (
        <label className='qg-field'>
          <span>Wallet descriptor</span>
          <textarea
            className='qg-descriptor-input'
            value={value}
            disabled={importBusy}
            data-testid='hardware-pub'
            aria-label='Wallet descriptor'
            placeholder='Paste your wallet descriptor here'
            autoCapitalize='none'
            autoCorrect='off'
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
            rows={3}
          />
          <small>Supports Taproot (tr) and native SegWit (wpkh) descriptors</small>
        </label>
      ) : value ? (
        <details className='qg-guidance qg-descriptor-review'>
          <summary>Review imported descriptor</summary>
          <code className='qg-full-value'>{value}</code>
        </details>
      ) : null}
      {!editing ? <p className='qg-helper'>Supports Taproot (tr) and native SegWit (wpkh) descriptors</p> : null}
      <input
        ref={fileInput}
        type='file'
        hidden
        accept='.txt,.json,text/plain,application/json'
        aria-label='Descriptor file'
        onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          setImportBusy(true)
          setImportError('')
          try {
            setValue(await readDescriptorFile(file, network))
            setEditing(false)
          } catch {
            setImportError(
              'This file could not be imported. Export a public output descriptor for one compatible wallet.',
            )
          } finally {
            setImportBusy(false)
          }
        }}
      />
      <ErrorMessage error={Boolean(importError)} text={importError} />
      <section className='qg-note'>
        <TriangleAlert />
        <div>
          <strong>Check your signer before depositing</strong>
          <p>
            Importing a descriptor does not confirm signing compatibility. Use a tested setup and check that you can
            approve a Savings transfer before adding more funds.
          </p>
        </div>
      </section>
      <details className='qg-guidance'>
        <summary>Compatible signing options</summary>
        <div className='qg-guidance-body'>
          <p>
            Sparrow 2.5.4 software signing and Bitcoin Core 31.0 RPC signing passed automated tests for native SegWit
            and Taproot. Hardware key protection requires a separate physical signing device.
          </p>
          <p>
            Ledger Bitcoin app 2.4.2 passed simulator tests. Physical Ledger approval and funded production tests remain
            incomplete. Jade is not compatible with this Savings signing flow; other hardware devices and Electrum have
            not been qualified for it.
          </p>
          <p>
            Sparrow and Ledger may show a non-default signature warning. Review the recipient and amount carefully; the
            two reserve signatures approve the recipient and protected change separately. Return the signed PSBT to
            Vaulted to complete the transfer.
          </p>
        </div>
      </details>
      <details className='qg-guidance'>
        <summary>Create a key and export with Sparrow</summary>
        <div className='qg-guidance-body'>
          <ol>
            <li>Create a new wallet in Sparrow and choose Single Signature, then Taproot (BIP86).</li>
            <li>
              For hardware protection, create the seed on your hardware device and add it through Connected Hardware
              Wallet. Keep the seed backup offline.
            </li>
            <li>
              Apply the wallet settings, then show the public Descriptor QR or export an Output Descriptor file from
              Sparrow. Scan, upload or paste it here.
            </li>
            <li>Compare Vaulted’s reserve address with the first receive address in your signing wallet.</li>
          </ol>
          <p>
            For software testing, choose New or Imported Software Wallet and create a BIP39 seed, or import a dedicated
            test seed. Use a new wallet for test keys and keep them separate from your savings.
          </p>
          <p>
            Native SegWit (BIP84) is also supported. Keep the wallet type and descriptor matched: tr for Taproot, wpkh
            for native SegWit. Choose a tested signing setup before funding Savings.
          </p>
        </div>
      </details>
      <details className='qg-guidance'>
        <summary>What to expect with Ledger</summary>
        <div className='qg-guidance-body'>
          <p>
            Keep the key on your Ledger and use a desktop wallet to exchange public descriptors and PSBT files with
            Vaulted. The complete Ledger and desktop-wallet flow still needs physical-device qualification.
          </p>
          <p>
            The tested Ledger simulator showed external-input and non-default signature warnings. Savings is an external
            input; Ledger signs the two reserve inputs. Review the recipient, any Savings change, both 500-sat reserve
            returns, the 240-sat anchor and the fee on the device.
          </p>
          <p>
            Each reserve signature commits to one output: the recipient first, then Savings change for a partial
            transfer or a returned reserve for a full transfer. The Emulator independently checks the remaining
            transaction rules.
          </p>
          <p>
            Return the partially signed PSBT to Vaulted, then complete the remaining approvals there. The desktop wallet
            may show only the reserve balance; use Vaulted to manage Savings and leave its reserve outputs available for
            transfers.
          </p>
        </div>
      </details>
      <details className='qg-guidance'>
        <summary>Find and check your wallet descriptor</summary>
        <div className='qg-guidance-body'>
          <p>
            In your wallet, look for an export option called Output Descriptor or Wallet Descriptor. Show its QR code or
            export a text file containing a public tr or wpkh descriptor with the key fingerprint and derivation path.
          </p>
          <p>
            The app selects the first address from a ranged descriptor and the receive branch from a multipath
            descriptor. The two 500-sat reserves return to that same address in each transfer; Savings pays the fee.
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
