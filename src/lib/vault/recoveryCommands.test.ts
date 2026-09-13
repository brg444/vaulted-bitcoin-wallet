import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultStatus } from './types'
import type { AdmittedAccount } from './admittedAccount'
import type { EnrollmentSecrets } from './tenantEnrollment'
import type { VaultSessionSnapshot } from './session'

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  acknowledge: vi.fn(),
  spendingAcknowledge: vi.fn(),
  open: vi.fn(),
  sync: vi.fn(),
  header: vi.fn(),
  encrypt: vi.fn(),
  key: vi.fn(),
  unlock: vi.fn(),
  record: vi.fn(),
  save: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  boarding: vi.fn(),
  refreshBalance: vi.fn(),
  kitFromFacts: vi.fn(),
  loadLocalKit: vi.fn(),
  kitMatches: vi.fn(),
  observe: vi.fn(),
}))

const account = {
  maintenance: { observe: mocks.observe },
  bitcoinPayments: { acknowledgeRecovery: mocks.acknowledge },
  spendingPayments: { acknowledgeSettledRecovery: mocks.spendingAcknowledge },
  balances: { refreshBalance: mocks.refreshBalance },
}

vi.mock('./accountRuntime', () => ({
  vaultWalletRuntimeKey: () => 'key',
  vaultAccountRuntime: () => account,
}))
vi.mock('./recovery/capture', () => ({ captureVaultRecoveryFile: mocks.capture }))
vi.mock('./recovery/packageCheck', () => ({ recordRecoveryFileCopy: mocks.record }))
vi.mock('./recovery/cloudBackup', () => ({
  openRecoveryCloudBackup: mocks.open,
  syncRecoveryCloudBackup: mocks.sync,
}))
vi.mock('./recovery/backupCodec', () => ({
  buildRecoveryHeader: mocks.header,
  encryptRecoveryBackup: mocks.encrypt,
  recoveryBackupKey: mocks.key,
}))
vi.mock('./recovery/portable', () => ({ createPortableRecoveryPackage: vi.fn() }))
vi.mock('./program/kitBackup', () => ({
  kitFromFacts: mocks.kitFromFacts,
  pullMapBackup: mocks.pull,
  pushMapBackup: mocks.push,
}))
vi.mock('./program/kitStore', () => ({ loadLocalKit: mocks.loadLocalKit, saveLocalKit: mocks.save }))
vi.mock('./program/liveKit', () => ({ kitMatchesLiveVault: mocks.kitMatches }))
vi.mock('./savingsSpend', () => ({ unlockPhoneBip340: mocks.unlock }))
vi.mock('./vtxo/boardingRecovery', () => ({ recoverMatureBoardingInputs: mocks.boarding }))
vi.mock('./ceremony/directauth', () => ({ zeroBytes: (bytes: Uint8Array) => bytes.fill(0) }))

import { recoveryCommandsForSession } from './recoveryCommands'
import { SPENDING_ONLY_TEMPLATE } from './spendingEnrollment'

const status = {
  vaultId: 'test',
  network: 'mainnet',
  enrolled: true,
  templateVersion: SPENDING_ONLY_TEMPLATE,
} as unknown as VaultStatus
const enrollment = { vaultId: 'test' } as EnrollmentSecrets
const file = { header: { binding: { vaultId: 'test' } }, archive: { spending: {} } }
const coverage = { vaultId: 'test', network: 'mainnet', descriptorHash: 'aa', fileDigest: 'bb', outputs: [] }
const captured = { file, coverage }
const kit = { descriptor: { vaultId: 'test', templateVersion: 5 } }

let observed:
  | { run: (signal: AbortSignal) => Promise<unknown>; options: { requested: () => void; failed: (e: unknown) => void } }
  | undefined

function sessionFor(overrides: Partial<VaultSessionSnapshot> = {}) {
  let snapshot: VaultSessionSnapshot = {
    setup: { hardwarePub: '', recoveryPub: '' },
    account: { savings: 'absent', status, enrollment } as AdmittedAccount,
    stagedEnrollment: null,
    privacyLock: false,
    ledgerApprovalPhase: 'idle',
    status,
    addressPin: null,
    deployment: null,
    locked: false,
    loaded: true,
    initialStatusChecked: true,
    pending: null,
    error: '',
    transition: null,
    ...overrides,
  } as VaultSessionSnapshot
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next: Partial<VaultSessionSnapshot>) {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  observed = undefined
  mocks.capture.mockResolvedValue(captured)
  mocks.acknowledge.mockResolvedValue(undefined)
  mocks.spendingAcknowledge.mockResolvedValue(undefined)
  mocks.record.mockResolvedValue(undefined)
  mocks.sync.mockResolvedValue(file)
  mocks.open.mockResolvedValue({
    header: file.header,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    key: {},
  })
  mocks.header.mockReturnValue(file.header)
  mocks.encrypt.mockResolvedValue({ encrypted: true })
  mocks.key.mockResolvedValue({})
  mocks.unlock.mockResolvedValue(new Uint8Array(32).fill(1))
  mocks.boarding.mockResolvedValue('00'.repeat(32))
  mocks.refreshBalance.mockResolvedValue(undefined)
  mocks.kitFromFacts.mockReturnValue(kit)
  mocks.loadLocalKit.mockReturnValue(null)
  mocks.kitMatches.mockReturnValue(false)
  mocks.observe.mockImplementation((_name, run, options) => {
    observed = { run, options }
    return {
      request: vi.fn(),
      refresh: vi.fn(),
      isDisposed: () => false,
      dispose: vi.fn().mockResolvedValue(undefined),
    }
  })
})

describe('session-owned recovery commands', () => {
  it('captures, acknowledges and exports locally without opening cloud backup', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    const phone = new Uint8Array(32).fill(9)
    mocks.unlock.mockResolvedValue(phone)
    const exported = await commands.downloadRecoveryArchive()
    expect(exported).toContain('encrypted')
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.acknowledge).toHaveBeenCalledWith(coverage)
    expect(mocks.record).toHaveBeenCalledWith('local', file)
    expect(phone.every((byte) => byte === 0)).toBe(true)
    release()
  })

  it('acknowledges committed Spending evidence after capture through the account owner', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    await commands.downloadRecoveryArchive()
    expect(mocks.acknowledge).toHaveBeenCalledWith(coverage)
    expect(mocks.spendingAcknowledge).toHaveBeenCalledWith(coverage)
    expect(mocks.acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.spendingAcknowledge.mock.invocationCallOrder[0],
    )
    release()
  })

  it('skips Spending acknowledgment when activity arrives during a delayed capture', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finishCapture!: (value: unknown) => void
    mocks.capture.mockImplementationOnce(() => new Promise((resolve) => (finishCapture = resolve)))
    const operation = commands.downloadRecoveryArchive()
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1))
    observed!.options.requested()
    finishCapture(captured)
    await operation
    expect(mocks.spendingAcknowledge).not.toHaveBeenCalled()
    release()
  })

  it('skips Spending acknowledgment when the session is replaced during capture', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finishCapture!: (value: unknown) => void
    mocks.capture.mockImplementationOnce(() => new Promise((resolve) => (finishCapture = resolve)))
    const operation = commands.downloadRecoveryArchive().catch(() => undefined)
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1))
    session.set({
      account: { savings: 'absent', status, enrollment: { vaultId: 'test', credId: 'replacement' } } as AdmittedAccount,
    })
    finishCapture(captured)
    await operation
    expect(mocks.spendingAcknowledge).not.toHaveBeenCalled()
    release()
  })

  it('opens cloud backup once and reports verified synchronization', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    await commands.backupRecoveryArchive()
    expect(mocks.open).toHaveBeenCalledTimes(1)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    expect(commands.getSnapshot().archiveStatus).toContain('cloud backup verified')
    release()
  })

  it('rejects an explicit backup when the wallet locks during capture', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finish!: (value: unknown) => void
    mocks.capture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const operation = commands.backupRecoveryArchive()
    const rejected = expect(operation).rejects.toThrow()
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1))
    session.set({ locked: true })
    finish(captured)
    await rejected
    expect(mocks.sync).not.toHaveBeenCalled()
    release()
  })

  it('drops a cloud session whose unlock finishes after the wallet locks', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finish!: (value: unknown) => void
    mocks.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const operation = commands.backupRecoveryArchive()
    const rejected = expect(operation).rejects.toThrow()
    session.set({ locked: true })
    finish({ header: file.header, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), key: {} })
    await rejected
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(commands.getSnapshot().archiveStatus).toBe('')
    release()
  })

  it('completes an explicit backup across activity without reporting its snapshot as current', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finish!: (value: unknown) => void
    mocks.capture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const operation = commands.backupRecoveryArchive()
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1))
    observed!.options.requested()
    finish(captured)
    await operation
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    expect(commands.getSnapshot().archiveStatus).not.toContain('verified')
    release()
  })

  it('exports locally without a cloud session and reports a local save', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    await commands.downloadRecoveryArchive()
    expect(mocks.open).not.toHaveBeenCalled()
    release()
  })

  it('wipes the device key before saving and pushing a Recovery Kit', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    const secret = new Uint8Array(32).fill(7)
    mocks.unlock.mockResolvedValue(secret)
    mocks.push.mockImplementation(async () => {
      expect(secret.every((byte) => byte === 0)).toBe(true)
      return true
    })
    await commands.backupRecoveryKit()
    expect(mocks.save).toHaveBeenCalledWith(kit)
    expect(secret.every((byte) => byte === 0)).toBe(true)
    release()
  })

  it('does not fetch or replace the map after passkey rejection', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    mocks.unlock.mockRejectedValue(new DOMException('Canceled', 'NotAllowedError'))
    await expect(commands.restoreRecoveryKit()).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(mocks.pull).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    release()
  })

  it('coalesces concurrent mature boarding recovery into one flight', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finish!: (value: string) => void
    mocks.boarding.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    const first = commands.recoverMatureBoarding()
    const second = commands.recoverMatureBoarding()
    expect(first).toBe(second)
    expect(mocks.boarding).toHaveBeenCalledTimes(1)
    finish('66'.repeat(32))
    await expect(first).resolves.toBe('66'.repeat(32))
    await vi.waitFor(() => expect(mocks.refreshBalance).toHaveBeenCalledWith('test'))
    release()
  })

  it('abandons a mature boarding flight when the session identity changes', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finish!: (value: string) => void
    mocks.boarding.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    const operation = commands.recoverMatureBoarding()
    const rejected = expect(operation).rejects.toThrow()
    session.set({ account: { savings: 'absent', status, enrollment: { vaultId: 'other' } } as AdmittedAccount })
    finish('66'.repeat(32))
    await rejected
    release()
  })

  it('refuses recovery commands once the account runtime suspends the owner', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    release()
    expect(() => commands.downloadRecoveryKit()).toThrow('Sign in')
    await expect(commands.downloadRecoveryArchive()).rejects.toThrow()
  })
})

describe('Codex independent recovery-owner review', () => {
  it('exports locally when an existing cloud session cannot synchronize', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    try {
      await commands.backupRecoveryArchive()
      mocks.sync.mockRejectedValueOnce(new Error('cloud offline'))
      await expect(commands.downloadRecoveryArchive()).resolves.toContain('encrypted')
      expect(mocks.sync).toHaveBeenCalledTimes(1)
    } finally {
      release()
    }
  })

  it('rejects a download whose encryption completes after session locking', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finish!: (value: unknown) => void
    mocks.encrypt.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    try {
      const operation = commands.downloadRecoveryArchive()
      await vi.waitFor(() => expect(mocks.encrypt).toHaveBeenCalledTimes(1))
      session.set({ locked: true })
      const outcome = expect(operation).rejects.toThrow()
      finish({ encrypted: true })
      await outcome
    } finally {
      release()
    }
  })

  it('rejects a kit backup whose accepted push completes after locking', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finish!: (value: boolean) => void
    mocks.push.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    try {
      const operation = commands.backupRecoveryKit()
      await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1))
      session.set({ locked: true })
      const outcome = expect(operation).rejects.toThrow()
      finish(true)
      await outcome
      expect(mocks.save).toHaveBeenCalledWith(kit)
    } finally {
      release()
    }
  })
})

describe('single capture owner', () => {
  it('shares one capture across background observation and explicit export at the same activity', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finish!: (value: unknown) => void
    mocks.capture.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const operation = commands.downloadRecoveryArchive()
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1))
    const background = observed!.run(new AbortController().signal)
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    finish(captured)
    await Promise.all([operation, background])
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    observed!.options.requested()
    await observed!.run(new AbortController().signal)
    expect(mocks.capture).toHaveBeenCalledTimes(2)
    release()
  })

  it('fails a capture queued before a session change at its admission fence', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finish!: (value: unknown) => void
    mocks.capture.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const foreground = commands.downloadRecoveryArchive()
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1))
    observed!.options.requested()
    const background = observed!.run(new AbortController().signal)
    const foregroundOutcome = expect(foreground).rejects.toThrow()
    const backgroundOutcome = expect(background).rejects.toThrow()
    session.set({ locked: true })
    finish(captured)
    await foregroundOutcome
    await backgroundOutcome
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    release()
  })

  it('allows a later capture after fresh activity', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    await observed!.run(new AbortController().signal)
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    observed!.options.requested()
    await observed!.run(new AbortController().signal)
    expect(mocks.capture).toHaveBeenCalledTimes(2)
    release()
  })

  it('drains in-flight capture work during teardown', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finishCapture!: (value: unknown) => void
    mocks.capture.mockImplementationOnce(() => new Promise((resolve) => (finishCapture = resolve)))
    const operation = commands.downloadRecoveryArchive().catch(() => undefined)
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1))
    let drained = false
    const teardown = commands.suspend().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    finishCapture(captured)
    await operation
    await teardown
    expect(drained).toBe(true)
    release()
  })
})

describe('cloud session admission', () => {
  it('drains an admitted cloud write after lock while rejecting the caller', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let finishSync!: (value: unknown) => void
    mocks.sync.mockImplementationOnce(() => new Promise((resolve) => (finishSync = resolve)))
    const operation = commands.backupRecoveryArchive()
    await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1))
    const rejected = expect(operation).rejects.toThrow()
    session.set({ locked: true })
    finishSync(file)
    await rejected
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    expect(mocks.record).not.toHaveBeenCalledWith('service', file)
    release()
  })

  it('does not adopt a previous account cloud session after identity replacement', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    await commands.backupRecoveryArchive()
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    session.set({
      account: { savings: 'absent', status, enrollment: { vaultId: 'test', credId: 'replacement' } } as AdmittedAccount,
    })
    await observed!.run(new AbortController().signal)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    release()
  })
})
