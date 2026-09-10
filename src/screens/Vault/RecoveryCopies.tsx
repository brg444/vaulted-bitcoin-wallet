import { useEffect, useState } from 'react'
import {
  readRecoveryCopies,
  recoveryCopiesEvent,
  recoveryCopyDescription,
  recoveryContentsDescription,
  type RecoveryCopies as Copies,
  type RecoveryCopyKind,
} from '../../lib/vault/recovery/copyStatus'

export default function RecoveryCopies({ vaultId, network }: { vaultId: string; network: string }) {
  const [copies, setCopies] = useState<Copies>({})
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const refresh = () =>
      void readRecoveryCopies(vaultId, network)
        .then((next) => {
          if (active) {
            setCopies(next)
            setError('')
          }
        })
        .catch(() => {
          if (active) setError('Saved-copy status is unavailable on this device.')
        })
    refresh()
    window.addEventListener(recoveryCopiesEvent, refresh)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.removeEventListener(recoveryCopiesEvent, refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [vaultId, network])
  return (
    <details className='qg-guidance'>
      <summary>Saved copies</summary>
      {error ? (
        <p role='alert'>{error}</p>
      ) : (
        (['local', 'service', 'downloaded', 'checked'] as RecoveryCopyKind[]).map((kind) => (
          <p key={kind}>
            <strong>
              {
                {
                  local: 'On this device',
                  service: 'Verified service copy',
                  downloaded: 'Last download',
                  checked: 'Last file check',
                }[kind]
              }
            </strong>
            <br />
            {recoveryCopyDescription(copies, kind)}
            <br />
            {recoveryContentsDescription(copies, kind)}
          </p>
        ))
      )}
      <p>
        Saved paths and protected records are compared separately. A passkey file check confirms access at that time.
        Hardware and recovery keys, later activity, and the location of your downloaded copy still need checking.
      </p>
    </details>
  )
}
