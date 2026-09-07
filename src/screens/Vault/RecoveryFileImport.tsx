import { useEffect, useRef, useState } from 'react'
import { MAX_PORTABLE_RECOVERY_BYTES, parsePortableRecoveryPackage } from '../../lib/vault/recovery/portable'
import ErrorMessage from '../../components/Error'
import { parseEncryptedRecoveryBackup } from '../../lib/vault/recovery/backupCodec'

export default function RecoveryFileImport({
  busy,
  restore,
}: {
  busy: boolean
  restore: (raw: unknown) => Promise<void>
}) {
  const input = useRef<HTMLInputElement>(null)
  const active = useRef(false)
  const generation = useRef(0)
  const busyNow = useRef(busy)
  busyNow.current = busy
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )

  async function importFile(file: File) {
    if (active.current || busyNow.current) return
    setError('')
    if (file.size > MAX_PORTABLE_RECOVERY_BYTES) {
      setError('That file is too large. Choose a recovery package up to 32 MB.')
      return
    }
    active.current = true
    const request = ++generation.current
    setReading(true)
    try {
      let parsed
      try {
        const text = await file.text()
        if (request !== generation.current || busyNow.current) return
        if (new TextEncoder().encode(text).length > MAX_PORTABLE_RECOVERY_BYTES) throw new Error('File too large')
        const raw = JSON.parse(text)
        parsed =
          raw?.name === 'vaulted-recovery-package'
            ? parsePortableRecoveryPackage(raw).backup
            : parseEncryptedRecoveryBackup(raw)
      } catch {
        if (request === generation.current)
          setError(
            'Choose an encrypted recovery backup or recovery package JSON file. Use Access and recovery help to check a public Recovery Kit.',
          )
        return
      }
      // The existing restore flow owns passkey approval and its error display.
      await restore(parsed).catch(() => undefined)
    } finally {
      active.current = false
      if (request === generation.current) setReading(false)
    }
  }

  return (
    <>
      <button
        type='button'
        className='qg-text'
        disabled={busy || reading}
        aria-busy={reading || undefined}
        onClick={() => input.current?.click()}
      >
        {reading ? 'Opening recovery backup…' : 'Restore encrypted backup from a file'}
      </button>
      <input
        ref={input}
        type='file'
        accept='.json,application/json'
        hidden
        aria-label='Encrypted recovery backup file'
        disabled={busy || reading}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void importFile(file)
        }}
      />
      <p className='qg-copy'>Accepts recovery packages and encrypted archives. Your original passkey is required.</p>
      <ErrorMessage error={Boolean(error)} text={error} />
    </>
  )
}
