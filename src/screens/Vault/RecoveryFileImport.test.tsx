import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import { buildRecoveryHeader, MAX_RECOVERY_BACKUP_BYTES } from '../../lib/vault/recovery/backupCodec'
import { recoveryFixture } from '../../lib/vault/recovery/testdata/helpers'
import RecoveryFileImport from './RecoveryFileImport'
import VaultWelcome from './Welcome'
import VaultUnlock from './Unlock'

vi.mock('../../lib/vault/webauthn', () => ({ isCoarsePhone: () => false }))

const { kit, status } = recoveryFixture(false)
const envelope = {
  name: 'vaulted-recovery-backup',
  version: 1,
  header: buildRecoveryHeader(kit, status, {
    vaultId: status.vaultId,
    credId: 'ab'.repeat(32),
    webauthnP256: kit.descriptor.keys.phoneDirectP256,
    phoneDirectP256: kit.descriptor.keys.phoneDirectP256,
    phoneBip340Pub: kit.descriptor.keys.phoneBip340,
    nonce: '11'.repeat(12),
    ciphertext: '22'.repeat(48),
  }),
  nonce: '33'.repeat(12),
  ciphertext: 'AQ==',
}
function file(text = JSON.stringify(envelope), size = new TextEncoder().encode(text).length) {
  return { size, text: vi.fn(async () => text) }
}
function choose(value?: ReturnType<typeof file>) {
  fireEvent.change(screen.getByLabelText('Encrypted recovery backup file'), { target: { files: value ? [value] : [] } })
}

describe('local encrypted recovery backup import', () => {
  it.each([VaultWelcome, VaultUnlock])(
    'exposes file restore beside cloud restore and preserves recovery help',
    async (Component) => {
      const restoreRecoveryArchive = vi.fn().mockResolvedValue(undefined)
      const context = {
        busy: false,
        error: '',
        locked: true,
        hasLocalEnrollment: true,
        navigate: vi.fn(),
        signIn: vi.fn(),
        restoreRecoveryArchive,
      } as unknown as VaultContextProps
      render(
        <VaultContext.Provider value={context}>
          <Component />
        </VaultContext.Provider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Help' }))
      fireEvent.click(screen.getByRole('button', { name: 'Restore backup' }))
      const input = screen.getByLabelText('Encrypted recovery backup file')
      const open = vi.spyOn(input, 'click')
      fireEvent.click(screen.getByRole('button', { name: 'Restore encrypted backup from a file' }))
      expect(open).toHaveBeenCalledOnce()
      choose(file())
      await waitFor(() => expect(restoreRecoveryArchive).toHaveBeenCalledWith(envelope))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      fireEvent.click(screen.getByRole('button', { name: 'Help' }))
      fireEvent.click(screen.getByRole('button', { name: 'Restore backup' }))
      fireEvent.click(screen.getByRole('button', { name: 'Restore encrypted cloud backup' }))
      expect(restoreRecoveryArchive).toHaveBeenLastCalledWith()
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      fireEvent.click(screen.getByRole('button', { name: 'Help' }))
      fireEvent.click(screen.getByRole('button', { name: 'Access and recovery help' }))
      expect(screen.getByRole('heading', { name: 'What do you still have access to?' })).toBeInTheDocument()
      expect(context.signIn).not.toHaveBeenCalled()
    },
  )
  it('rejects oversized files before reading or requesting a passkey', () => {
    const restore = vi.fn()
    render(<RecoveryFileImport busy={false} restore={restore} />)
    const oversized = file('', MAX_RECOVERY_BACKUP_BYTES + 1)
    choose(oversized)
    expect(screen.getByRole('alert')).toHaveTextContent('too large')
    expect(oversized.text).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })
  it.each([
    '{broken',
    JSON.stringify(kit),
    'null',
    JSON.stringify({ ...envelope, name: 'unknown' }),
    JSON.stringify({ ...envelope, nonce: 'bad' }),
  ])('rejects unsupported JSON or envelope data without restoring', async (text) => {
    const restore = vi.fn()
    render(<RecoveryFileImport busy={false} restore={restore} />)
    choose(file(text))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose an encrypted recovery backup')
    expect(restore).not.toHaveBeenCalled()
  })
  it('allows the same file after a read error and contains restore rejection', async () => {
    const restore = vi.fn().mockRejectedValue(new Error('Passkey cancelled'))
    render(<RecoveryFileImport busy={false} restore={restore} />)
    const unreadable = file()
    unreadable.text.mockRejectedValueOnce(new Error('Read failed'))
    choose(unreadable)
    await screen.findByRole('alert')
    choose(unreadable)
    await waitFor(() => expect(restore).toHaveBeenCalledWith(envelope))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Restore encrypted backup from a file' })).toBeEnabled(),
    )
    expect(screen.queryByRole('alert')).toBeNull()
    choose(unreadable)
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2))
  })
  it('ignores cancellation and prevents overlapping imports while restoring', async () => {
    let finish!: () => void
    const restore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(<RecoveryFileImport busy={false} restore={restore} />)
    choose()
    expect(restore).not.toHaveBeenCalled()
    choose(file())
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Opening recovery backup…' })).toBeDisabled()
    const next = file()
    choose(next)
    expect(next.text).not.toHaveBeenCalled()
    await act(async () => finish())
    expect(screen.getByRole('button', { name: 'Restore encrypted backup from a file' })).toBeEnabled()
  })
  it('does not begin restoration after leaving the screen or starting another operation', async () => {
    for (const unmountInstead of [false, true]) {
      let finish!: (text: string) => void
      const restore = vi.fn()
      const view = render(<RecoveryFileImport busy={false} restore={restore} />)
      const pending = file()
      pending.text.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      choose(pending)
      if (unmountInstead) view.unmount()
      else view.rerender(<RecoveryFileImport busy restore={restore} />)
      await act(async () => finish(JSON.stringify(envelope)))
      expect(restore).not.toHaveBeenCalled()
      view.unmount()
    }
  })
})
