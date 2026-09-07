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
          <small>Supports native SegWit (wpkh) and Taproot (tr) descriptors</small>
        </label>
      ) : value ? (
        <details className='qg-guidance qg-descriptor-review'>
          <summary>Review imported descriptor</summary>
          <code className='qg-full-value'>{value}</code>
        </details>
      ) : null}
      {!editing ? <p className='qg-helper'>Supports native SegWit (wpkh) and Taproot (tr) descriptors</p> : null}
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
      <details className='qg-guidance'>
        <summary>Find and check your wallet descriptor</summary>
        <div className='qg-guidance-body'>
          <p>
            In your wallet, look for an export option called Output Descriptor or Wallet Descriptor. Show its QR code or
            export a text file containing a public wpkh or tr descriptor with the key fingerprint and derivation path.
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
