import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultStatus } from './types'
import type { EnrollmentSecrets } from './tenantEnrollment'
import type { VaultSessionSnapshot } from './session'

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  acknowledge: vi.fn(),
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

const status = { vaultId: 'test', network: 'mainnet', enrolled: true, templateVersion: 5 } as unknown as VaultStatus
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
    enrollment,
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
    session.set({ enrollment: { vaultId: 'other' } as EnrollmentSecrets })
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
})

describe('single capture owner', () => {
  it('serializes background observation and explicit export into one capture writer', async () => {
    const session = sessionFor()
    const commands = recoveryCommandsForSession(session)
    const release = commands.retain()
    let active = 0
    let maxActive = 0
    const pending: (() => void)[] = []
    mocks.capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          active++
          maxActive = Math.max(maxActive, active)
          pending.push(() => {
            active--
            resolve(captured)
          })
        }),
    )
    const operation = commands.downloadRecoveryArchive()
    await vi.waitFor(() => expect(pending.length).toBe(1))
    const background = observed!.run(new AbortController().signal)
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    pending.shift()!()
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(2))
    pending.shift()!()
    await Promise.all([operation, background])
    expect(maxActive).toBe(1)
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
})
