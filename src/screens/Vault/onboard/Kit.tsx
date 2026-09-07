import { useContext, useState } from 'react'
import { Download, LockKeyhole } from 'lucide-react'
import { useToast } from '../../../components/Toast'
import { VaultContext } from '../../../vault/context'
import { useBackupConfirmation } from '../qg/useBackupConfirmation'
import QgScreen, { QgMark, QgPrimary, QgTextButton } from '../qg/QgScreen'
import '../qg/guidance.css'

function downloadJson(name: string, body: string) {
  const hidden = document.createElement('a')
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
  hidden.href = url
  hidden.download = name
  document.body.appendChild(hidden)
  hidden.click()
  hidden.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export default function VaultKit() {
  const { downloadRecoveryKit, navigate } = useContext(VaultContext)
  const { confirmed, confirm } = useBackupConfirmation()
  const [hasSeparateCopy, setHasSeparateCopy] = useState(confirmed)
  const [downloadRequested, setDownloadRequested] = useState(false)
  const { toast } = useToast()

  const save = () => {
    try {
      downloadJson('Recovery Kit.json', downloadRecoveryKit())
      setDownloadRequested(true)
      toast('Download requested. Check your saved files.')
    } catch {
      toast('Could not download the Recovery Kit. Try again.')
    }
  }

  return (
    <QgScreen
      title='Recovery Kit'
      stepLabel='Backup'
      back={() => navigate('home')}
      footer={
        <>
          {!downloadRequested && !confirmed ? (
            <QgPrimary
              onClick={save}
              icon={<Download />}
              label='Download Recovery Kit'
              testId='download-recovery-kit'
            />
          ) : null}
          {downloadRequested || confirmed ? (
            <QgPrimary
              onClick={() => {
                if (!confirm()) {
                  toast('Could not save your backup confirmation on this device. Try again.')
                  return
                }
                navigate('home')
              }}
              disabled={!hasSeparateCopy}
              label='Open your Vault'
            />
          ) : null}
          <QgTextButton onClick={() => navigate('home')} label='I’ll save a separate copy later' />
        </>
      }
    >
      <h1>Save your Recovery Kit</h1>
      <p className='qg-copy'>
        Your Recovery Kit records Savings addresses and recovery rules. It contains no private keys. Recovery also needs
        the keys and transaction data for the selected path.
      </p>
      {!downloadRequested && !confirmed ? (
        <>
          <section className='qg-document'>
            <QgMark />
            <div>
              <strong>Recovery Kit</strong>
              <small>Public vault map · no private keys</small>
            </div>
            <LockKeyhole />
          </section>
          <p className='qg-copy'>
            Keep a private copy outside this device, somewhere you can reach if this device is lost.
          </p>
        </>
      ) : null}
      {downloadRequested ? (
        <p className='qg-backup-status' role='status'>
          Check that Recovery Kit.json appears in your saved files, then copy it outside this device.
        </p>
      ) : null}
      {downloadRequested || confirmed ? <QgTextButton onClick={save} label='Download Recovery Kit again' /> : null}
      {downloadRequested || confirmed ? (
        <>
          <label className='qg-consent'>
            <input
              type='checkbox'
              checked={hasSeparateCopy}
              onChange={(event) => setHasSeparateCopy(event.target.checked)}
            />
            <span>I have a copy of this vault’s Recovery Kit outside this device.</span>
          </label>
          <p className='qg-copy'>This records your confirmation; the app cannot check where you saved the file.</p>
        </>
      ) : null}
    </QgScreen>
  )
}
