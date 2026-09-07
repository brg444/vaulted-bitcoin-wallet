import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { CircleHelp, X } from 'lucide-react'
import { VaultContext } from '../../../vault/context'
import RecoveryHelp from '../RecoveryHelp'
import RecoveryFileImport from '../RecoveryFileImport'
import InstallNotice from './InstallNotice'

export const WalletHelpContext = createContext<{ light?: boolean; restore?: () => void }>({})

export default function WalletHelp() {
  const { busy, error, restoreRecoveryArchive } = useContext(VaultContext)
  const wallet = useContext(WalletHelpContext)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'menu' | 'restore' | 'access'>('menu')
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => {
    dialog.current?.close()
    setOpen(false)
    setView('menu')
    trigger.current?.focus()
  }
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
  }, [open])
  return (
    <>
      <button ref={trigger} type='button' className='qg-help-trigger' aria-label='Help' onClick={() => setOpen(true)}>
        <CircleHelp aria-hidden='true' />
        <span>Help</span>
      </button>
      {open ? (
        <dialog
          ref={dialog}
          className='qg-help-dialog'
          aria-label='Wallet help'
          onCancel={(e) => {
            if (e.target !== e.currentTarget) return
            e.preventDefault()
            close()
          }}
        >
          <div className='qg-help-heading'>
            <strong>{view === 'restore' ? 'Restore backup' : 'Help'}</strong>
            <button type='button' aria-label='Close help' onClick={close}>
              <X />
            </button>
          </div>
          {view === 'access' && !wallet.light ? (
            <RecoveryHelp onBack={() => setView('menu')} />
          ) : (
            <div className='qg-help-body'>
              {view === 'menu' ? (
                <>
                  <button className='qg-secondary' type='button' onClick={() => setView('access')}>
                    Access and recovery help
                  </button>
                  <button
                    className='qg-secondary'
                    type='button'
                    onClick={() => {
                      if (wallet.restore) {
                        close()
                        wallet.restore()
                      } else setView('restore')
                    }}
                  >
                    Restore backup
                  </button>
                  {!wallet.light ? (
                    <a
                      className='qg-secondary'
                      href='https://github.com/brg444/vaulted-bitcoin-wallet/blob/main/docs/ledger-guide.md'
                      target='_blank'
                      rel='noopener noreferrer'
                      aria-label='Ledger setup and signing guide (opens in a new tab)'
                    >
                      Ledger setup and signing guide
                    </a>
                  ) : null}
                  <InstallNotice autoOffer={false} />
                </>
              ) : view === 'access' ? (
                <>
                  <h2>Keep access to your passkey</h2>
                  <p>
                    Try the device and passkey provider you used during setup. Keep your saved backup and app data while
                    checking access.
                  </p>
                  <p>
                    Light backup and Bitcoin recovery options are available from Restore. Recovery requires the data and
                    unlocking method saved for this wallet.
                  </p>
                  <button
                    className='qg-primary'
                    type='button'
                    onClick={() => {
                      close()
                      wallet.restore?.()
                    }}
                  >
                    Open restore options
                  </button>
                </>
              ) : (
                <>
                  <p>Choose where you saved your encrypted backup. Your passkey is required to unlock it.</p>
                  <button
                    className='qg-primary'
                    type='button'
                    disabled={busy}
                    onClick={() =>
                      void restoreRecoveryArchive()
                        .then(close)
                        .catch(() => undefined)
                    }
                  >
                    {busy ? 'Opening backup…' : 'Restore encrypted cloud backup'}
                  </button>
                  <RecoveryFileImport
                    busy={busy}
                    restore={async (raw) => {
                      await restoreRecoveryArchive(raw)
                      close()
                    }}
                  />
                  {error ? <p role='alert'>{error}</p> : null}
                  <p>A public Recovery Kit describes your vault. Use access help to inspect it.</p>
                </>
              )}
              {view !== 'menu' ? (
                <button className='qg-text' type='button' onClick={() => setView('menu')}>
                  Back to Help
                </button>
              ) : null}
            </div>
          )}
        </dialog>
      ) : null}
    </>
  )
}
