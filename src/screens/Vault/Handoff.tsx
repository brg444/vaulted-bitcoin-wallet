import { readConnectorSignerFile } from '../../lib/vault/connectorSignerFile'
import { isConnectorTemplate } from '../../lib/vault/program/connector'
import QgAmount from './qg/QgAmount'
import { useContext, useMemo, useRef, useState } from 'react'
import { Clipboard, ScanLine, TriangleAlert, Upload } from 'lucide-react'
import ErrorMessage from '../../components/Error'
import { useToast } from '../../components/Toast'
import { copyToClipboard } from '../../lib/clipboard'
import { formatMoney } from '../../lib/vault/fiatDisplay'
import { encodePsbtFrames, parsePsbtFrame } from '../../lib/vault/savingsQr'
import { psbtFile as savingsPsbtFile, psbtHexToBase64, readPsbtFile } from '../../lib/vault/savingsSpend'
import { VaultContext } from '../../vault/context'
import { useBalanceDenomination, type BalanceDenomination } from './AccountBalance'
import PsbtQr from './PsbtQr'
import Scanner from './Scanner'
import QgScreen, { QgPrimary, QgSecondary, QgTextButton } from './qg/QgScreen'

type HandoffView = 'export' | 'import' | 'paste' | 'ready' | 'problem'

export default function VaultHandoff({ denomination }: { denomination?: BalanceDenomination }) {
  const { busy, cancelSavingsHandoff, completeSavingsHandoff, error, handoffPsbt, navigate, spend, status } =
    useContext(VaultContext)
  const denom = useBalanceDenomination(denomination)
  const money = { unit: denom.unit, rate: denom.rate }
  const { toast } = useToast()
  const connector = isConnectorTemplate(status?.templateVersion)
  const payload = useMemo(() => (handoffPsbt ? psbtHexToBase64(handoffPsbt) : ''), [handoffPsbt])
  const frames = useMemo(() => (payload ? encodePsbtFrames(payload) : []), [payload])
  const [view, setView] = useState<HandoffView>('export')
  const [frame, setFrame] = useState(0)
  const [scan, setScan] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [pasted, setPasted] = useState('')
  const [selectedFile, setSelectedFile] = useState('')
  const [fileError, setFileError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const psbtFile = useMemo(
    () => (handoffPsbt ? savingsPsbtFile(handoffPsbt, 'Savings transfer.psbt') : null),
    [handoffPsbt],
  )
  const canShareFile = Boolean(
    psbtFile &&
      typeof navigator !== 'undefined' &&
      typeof navigator.share === 'function' &&
      (!navigator.canShare || navigator.canShare({ files: [psbtFile] })),
  )

  const sharePsbt = async () => {
    if (!psbtFile || !canShareFile) return
    try {
      await navigator.share({ files: [psbtFile], title: 'Savings transfer PSBT' })
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === 'AbortError') return
      toast('Sharing is unavailable. Copy the PSBT instead.')
    }
  }

  const current = frames[Math.min(frame, Math.max(frames.length - 1, 0))] || ''
  const signedReady = Boolean(pasted.trim())

  const acceptSigned = (value: string, fileName = '') => {
    setPasted(value)
    setSelectedFile(fileName)
    setFileError('')
    setView('ready')
  }

  if (scan) {
    return (
      <Scanner
        close={() => setScan(false)}
        label='Signed PSBT'
        onData={(data) => {
          const parsed = parsePsbtFrame(data)
          acceptSigned(parsed ? parsed.payload : data)
          setScan(false)
        }}
        onError={() => setScan(false)}
      />
    )
  }

  if (busy) {
    return (
      <div className='qg-screen qg-screen-progress'>
        <main className='qg-main qg-centered qg-progress-screen'>
          <span className='qg-spinner' aria-hidden='true' />
          <p className='qg-eyebrow'>Savings transfer</p>
          <h1>Checking and submitting</h1>
          <p className='qg-copy'>Keep this screen open until submission completes.</p>
        </main>
      </div>
    )
  }

  if (showQr)
    return (
      <QgScreen
        title='Scan transaction'
        back={() => setShowQr(false)}
        footer={
          frames.length > 1 ? (
            <QgPrimary label='Next QR' onClick={() => setFrame((n) => (n + 1) % frames.length)} />
          ) : undefined
        }
      >
        <PsbtQr value={current} />
        <p className='qg-copy'>Scan with your signing wallet. Then return to import the signed transaction.</p>
      </QgScreen>
    )

  if (view === 'import' || view === 'paste') {
    return (
      <QgScreen
        title={view === 'paste' ? 'Paste signed transaction' : 'Return signed transaction'}
        back={() => setView(view === 'paste' ? 'import' : 'export')}
        footer={
          view === 'paste' ? (
            <QgPrimary onClick={() => setView('ready')} disabled={!pasted.trim()} label='Use this PSBT' />
          ) : undefined
        }
      >
        <h1>Bring the signed PSBT back</h1>
        <p className='qg-copy'>Choose the method that matches your signing wallet.</p>
        <input
          ref={fileInput}
          hidden
          type='file'
          accept={connector ? '.psbt,.txn,.txt,application/octet-stream,text/plain' : '.psbt,application/octet-stream'}
          data-testid='savings-signed-psbt-file'
          onChange={(event) => {
            const input = event.currentTarget
            const file = input.files?.[0]
            input.value = ''
            if (!file) return
            void (connector ? readConnectorSignerFile(file) : readPsbtFile(file))
              .then((psbt) => acceptSigned(psbt, file.name))
              .catch(() => {
                setPasted('')
                setSelectedFile('')
                setFileError('The selected file is not a valid PSBT.')
                setView('problem')
              })
          }}
        />
        {view === 'import' ? (
          <div className='qg-methods'>
            <button type='button' onClick={() => fileInput.current?.click()}>
              <Upload />
              <span>
                <strong>Upload file</strong>
                <small>Choose a signed .psbt file</small>
              </span>
            </button>
            <button type='button' onClick={() => setScan(true)}>
              <ScanLine />
              <span>
                <strong>Scan QR</strong>
                <small>Scan the signed transaction</small>
              </span>
            </button>
            <button
              type='button'
              onClick={() => {
                setView('paste')
              }}
            >
              <Clipboard />
              <span>
                <strong>Paste</strong>
                <small>Base64 or hexadecimal PSBT</small>
              </span>
            </button>
          </div>
        ) : null}
        {view === 'paste' ? (
          <label className='qg-field'>
            <span>Signed PSBT</span>
            <input
              value={pasted}
              data-testid='savings-signed-psbt-paste'
              placeholder='Paste signed PSBT (base64 or hex)'
              onChange={(event) => setPasted(event.target.value)}
            />
          </label>
        ) : null}
      </QgScreen>
    )
  }

  if (view === 'ready') {
    return (
      <QgScreen
        title='Check transaction'
        back={() => setView('import')}
        footer={
          <>
            <ErrorMessage error={Boolean(fileError || error)} text={fileError || error} />
            <QgPrimary
              onClick={() => void completeSavingsHandoff(pasted)}
              disabled={!signedReady}
              label='Check and send transaction'
            />
          </>
        }
      >
        <div className='qg-status-line'>
          <Upload />
          <span>
            <strong>Transaction received</strong>
            <small>{selectedFile ? `${selectedFile} is ready to check.` : 'Your transaction is ready to check.'}</small>
          </span>
        </div>
        <section className='qg-details'>
          <div>
            <span>Amount</span>
            <strong>
              <QgAmount value={formatMoney(spend.amount, money)} />
            </strong>
          </div>
          <div>
            <span>{connector ? 'Network fee and 240-sat anchor' : 'Network fee'}</span>
            <strong>
              <QgAmount value={formatMoney(spend.fee, money)} />
            </strong>
          </div>
          <div>
            <span>Total</span>
            <strong>
              <QgAmount value={formatMoney(spend.amount + spend.fee, money)} />
            </strong>
          </div>
          <div>
            <span>To</span>
            <strong>{spend.address}</strong>
          </div>
          <div>
            <span>Network</span>
            <strong>{status?.network === 'mainnet' ? 'Bitcoin' : 'Mutinynet'}</strong>
          </div>
        </section>
        <p className='qg-copy'>
          The wallet will check the transfer details before sending this transaction to Bitcoin. Once sent, you cannot
          cancel it here.
        </p>
      </QgScreen>
    )
  }

  if (view === 'problem') {
    return (
      <QgScreen
        title='Check signed transaction'
        back={() => setView('import')}
        footer={
          <>
            <QgPrimary onClick={() => setView('import')} label='Choose another PSBT' />
            <QgSecondary onClick={() => setView('export')} label='Show PSBT again' />
          </>
        }
      >
        <p className='qg-eyebrow'>Nothing was broadcast</p>
        <h1>This signature can’t be used</h1>
        <p className='qg-copy'>The signed PSBT does not match the pending Savings transfer.</p>
        <section className='qg-alert'>
          <TriangleAlert />
          <div>
            <strong>Choose the transaction you just signed</strong>
            <p>Your pending transfer is still saved on this device.</p>
          </div>
        </section>
      </QgScreen>
    )
  }

  return (
    <QgScreen
      title={connector ? 'Signer next' : 'Hardware next'}
      close={() => navigate('home')}
      stepLabel='Saved'
      footer={
        <>
          <QgPrimary onClick={() => setView('import')} label='I’ve signed it' />
          <QgTextButton
            onClick={cancelSavingsHandoff}
            label={connector ? 'Keep pending and close' : 'Delete pending transfer'}
          />
        </>
      }
    >
      <h1>Approve with your signer</h1>
      <p className='qg-copy'>
        {connector
          ? 'Save the PSBT, check the destination and amount in your signing wallet, then return the signed file here.'
          : 'Save the PSBT, sign it with your hardware key, then return the signed file here.'}
      </p>
      <section className='qg-transfer'>
        <span>{formatMoney(spend.amount, money)}</span>
        <strong>{connector ? 'PSBT · awaiting signer' : 'PSBT · unsigned by hardware'}</strong>
      </section>
      {connector ? (
        <section className='qg-details' aria-label='Signer review'>
          <div>
            <span>Recipient</span>
            <strong style={{ overflowWrap: 'anywhere' }} data-testid='connector-signer-recipient'>
              {spend.address}
            </strong>
          </div>
          <div>
            <span>Signer reserve returned</span>
            <strong>{formatMoney(1000, money)}</strong>
          </div>
        </section>
      ) : null}
      <QgSecondary
        label={canShareFile ? 'Share PSBT' : 'Save PSBT file'}
        onClick={() => {
          if (canShareFile) {
            void sharePsbt()
            return
          }
          if (!psbtFile) return
          const url = URL.createObjectURL(psbtFile)
          const link = document.createElement('a')
          link.href = url
          link.download = psbtFile.name
          link.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        }}
      />
      <details className='qg-guidance'>
        <summary>Other signing methods</summary>
        <QgSecondary label='Copy PSBT' onClick={() => void copyToClipboard(payload).then(() => toast('PSBT copied'))} />
        <QgSecondary label='Show QR instead' onClick={() => setShowQr(true)} />
      </details>
    </QgScreen>
  )
}
