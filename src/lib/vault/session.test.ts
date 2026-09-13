import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVaultSession, type VaultSession } from './session'
import { emptySetupPlan, saveSetupPlan, type VaultSetupPlan } from './setupPlan'
import { saveAddressPin, pinFromEnrolledStatus } from './pin'
import {
  loadStagedEnrollment,
  saveStagedEnrollment,
  saveEnrollment,
  saveSelectedVaultId,
  setSessionLocked,
  loadSessionLocked,
  type StagedEnrollment,
} from './enrollmentStore'
import type { EnrollmentSecrets } from './tenantEnrollment'
import type { VaultStatus } from './types'
import { ledgerRecoveryFixture } from './recovery/testdata/ledger'
import { sharedSpendingRecoveryFixture } from './recovery/testdata/helpers'
import { hashLedgerSavingsEnrollment } from './program/ledgerRecoveryDescriptor'
import { loadVaultPrivacyLock } from './prefs'

const mocks = vi.hoisted(() => ({
  renew: vi.fn(),
  setupRenewal: vi.fn(),
  discover: vi.fn(),
  openArchive: vi.fn(),
  restoreArchive: vi.fn(),
  liveStatus: vi.fn(),
  publicStatus: vi.fn(),
  reconcile: vi.fn(),
  enable: vi.fn(),
  begin: vi.fn(),
  finish: vi.fn(),
  completeLedger: vi.fn(),
  pullMap: vi.fn(),
  recover: vi.fn(),
  unlock: vi.fn(),
  saveKit: vi.fn(),
  shutdown: vi.fn(),
  deleteKey: vi.fn(),
  suspendKey: vi.fn(),
  push: vi.fn(),
  revoke: vi.fn(),
  connect: vi.fn(),
  readLedger: vi.fn(),
  registerLedger: vi.fn(),
}))
vi.mock('./recovery/backupCodec', async (original) => ({
  ...(await original<typeof import('./recovery/backupCodec')>()),
  openLocalRecoveryBackup: mocks.openArchive,
}))
vi.mock('./recovery/restore', () => ({ restoreVaultRecoveryFile: mocks.restoreArchive }))
vi.mock('./status', async (original) => ({
  ...(await original<typeof import('./status')>()),
  fetchVaultStatus: mocks.liveStatus,
  fetchPublicStatus: mocks.publicStatus,
}))
vi.mock('./vtxo/renewalCeremony', () => ({
  renewFromLocalUnlock: mocks.renew,
  setupSpendingRenewals: mocks.setupRenewal,
}))
vi.mock('./signIn', () => ({
  discoverVaultIdFromPasskey: mocks.discover,
  enablePasskeyLogin: mocks.enable,
  signInWithPasskey: mocks.recover,
  unlockLocalEnrollment: mocks.unlock,
}))
vi.mock('./tenantEnrollment', async (original) => ({
  ...(await original<typeof import('./tenantEnrollment')>()),
  beginTenantEnrollment: mocks.begin,
  finishTenantEnrollment: mocks.finish,
  completeLedgerTenantEnrollment: mocks.completeLedger,
  reconcileStagedEnrollment: mocks.reconcile,
}))
vi.mock('./program/kitBackup', async (original) => ({
  ...(await original<typeof import('./program/kitBackup')>()),
  pullMapBackup: mocks.pullMap,
  pushMapBackup: mocks.push,
}))
vi.mock('./program/kitStore', () => ({ saveLocalKit: mocks.saveKit }))
vi.mock('./vtxo/walletWorker', () => ({ shutdownVaultWalletWorker: mocks.shutdown }))
vi.mock('./vtxo/board', async (original) => ({
  ...(await original<typeof import('./vtxo/board')>()),
  deleteBoardingKey: mocks.deleteKey,
  suspendBoardingKey: mocks.suspendKey,
}))
vi.mock('./pushSubscription', () => ({ disableBackgroundPush: mocks.push }))
vi.mock('./vtxo/guardianRenewal', () => ({ clearSpendingRenewalReads: mocks.revoke }))
vi.mock('./ledgerClient', () => ({
  connectLedgerSavings: mocks.connect,
  readLedgerSavingsAccount: mocks.readLedger,
  registerLedgerSavings: mocks.registerLedger,
  signLedgerSavings: vi.fn(),
}))

const { status, kit } = sharedSpendingRecoveryFixture()
const enrollment = {
  vaultId: status.vaultId,
  credId: '00',
  webauthnP256: '02',
  phoneDirectP256: status.phoneDirectP256,
  phoneBip340Pub: status.phoneBip340Pub,
  nonce: '00',
  ciphertext: '00',
} as EnrollmentSecrets
const ready: VaultSetupPlan = { ...emptySetupPlan(), protectionTier: 'light', acceptedDesign: true, complete: true }
const releases: (() => void)[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function create(plan = ready, local: EnrollmentSecrets | null = null, pinned = false) {
  saveSetupPlan(plan)
  if (local) {
    saveEnrollment(local)
    saveSelectedVaultId(local.vaultId)
    setSessionLocked(pinned)
  }
  if (pinned) saveAddressPin(pinFromEnrolledStatus(status))
  const session = createVaultSession()
  const release = session.retain()
  releases.push(release)
  await vi.waitFor(() => expect(session.getSnapshot().initialStatusChecked).toBe(true))
  return { session, release }
}
const outcome = (session: VaultSession) => session.getSnapshot().transition?.outcome
beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
  mocks.liveStatus.mockResolvedValue(status)
  mocks.publicStatus.mockResolvedValue({ network: status.network })
  mocks.reconcile.mockResolvedValue(null)
  mocks.enable.mockResolvedValue(status)
  mocks.discover.mockResolvedValue(status.vaultId)
  mocks.pullMap.mockResolvedValue(null)
  mocks.unlock.mockResolvedValue({ enrollment, status })
  mocks.recover.mockResolvedValue({ enrollment, status })
  mocks.begin.mockResolvedValue({ enrollment, enrollmentToken: 'original-token' })
  mocks.finish.mockResolvedValue({ enrollment, status })
  for (const fn of [mocks.shutdown, mocks.deleteKey, mocks.suspendKey, mocks.push]) fn.mockResolvedValue(undefined)
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.resolve()
  await Promise.resolve()
  vi.restoreAllMocks()
})

describe('session admission and teardown', () => {
  it('persists the privacy preference for the next opening without closing the current session', async () => {
    const first = await create(ready, enrollment)
    await first.session.signIn()
    first.session.setPrivacyLock(true)
    expect(first.session.getSnapshot()).toMatchObject({ privacyLock: true, locked: false })
    expect(loadVaultPrivacyLock()).toBe(true)
    expect(loadSessionLocked()).toBe(true)
    first.release()
    await vi.waitFor(() => expect(mocks.shutdown).toHaveBeenCalledWith(enrollment.vaultId))
    const next = createVaultSession()
    releases.push(next.retain())
    await vi.waitFor(() => expect(next.getSnapshot().initialStatusChecked).toBe(true))
    expect(next.getSnapshot()).toMatchObject({ privacyLock: true, locked: true })
    expect(outcome(next)).toBe('unlock-required')
  })
  it('keeps an explicit sign-out locked when the next-opening preference is disabled', async () => {
    const { session } = await create(ready, enrollment)
    await session.signIn()
    session.setPrivacyLock(true)
    session.setPrivacyLock(false)
    expect(loadVaultPrivacyLock()).toBe(false)
    expect(loadSessionLocked()).toBe(false)
    window.dispatchEvent(new Event('pagehide'))
    expect(loadSessionLocked()).toBe(false)
    await session.signOut()
    expect(session.getSnapshot()).toMatchObject({ privacyLock: false, locked: true })
    expect(loadSessionLocked()).toBe(true)
  })
  it('authenticates missing-pin enrollment before publishing its identity', async () => {
    const { session } = await create(ready, enrollment)
    expect(outcome(session)).toBe('signin-required')
    await session.signIn()
    expect(mocks.enable).toHaveBeenCalledExactlyOnceWith(enrollment, expect.any(AbortSignal))
    expect(mocks.unlock).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({
      locked: false,
      account: { status, enrollment },
      status,
      addressPin: pinFromEnrolledStatus(status),
    })
    expect(outcome(session)).toBe('authenticated')
  })
  it('uses local unlock for a pinned enrollment and shares concurrent approvals', async () => {
    const { session } = await create(ready, enrollment, true)
    const pending = deferred<{ enrollment: EnrollmentSecrets; status: VaultStatus }>()
    mocks.unlock.mockReturnValue(pending.promise)
    const a = session.signIn(),
      b = session.signIn()
    expect(a).toBe(b)
    await vi.waitFor(() => expect(mocks.unlock).toHaveBeenCalledTimes(1))
    expect(outcome(session)).toBe('unlock-required')
    pending.resolve({ enrollment, status })
    await a
    expect(mocks.unlock).toHaveBeenCalledWith(enrollment, expect.any(Function), expect.any(AbortSignal))
    expect(outcome(session)).toBe('authenticated')
  })
  it('opens a verified fresh session when durable browser writes are denied', async () => {
    const { session } = await create()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    await session.signIn()
    expect(mocks.recover).toHaveBeenCalledWith(status.vaultId, expect.any(Function), expect.any(AbortSignal))
    expect(session.getSnapshot()).toMatchObject({ locked: false, account: { status, enrollment }, status, error: '' })
    expect(outcome(session)).toBe('authenticated')
  })
  it('does not wait for the optional map and prevents its late publication after sign-out', async () => {
    const { session } = await create(ready, enrollment, true)
    const map = deferred<{ kit: typeof kit }>()
    mocks.pullMap.mockReturnValue(map.promise)
    await session.signIn()
    expect(outcome(session)).toBe('authenticated')
    await session.signOut()
    map.resolve({ kit })
    await Promise.resolve()
    expect(mocks.saveKit).not.toHaveBeenCalled()
    expect(outcome(session)).toBe('signed-out')
  })
  it('drains a canceled approval and key deletion before allowing the next activation', async () => {
    const { session } = await create(ready, enrollment, true)
    const first = deferred<{ enrollment: EnrollmentSecrets; status: VaultStatus }>(),
      deletion = deferred<void>()
    mocks.unlock.mockReturnValueOnce(first.promise)
    mocks.deleteKey.mockReturnValueOnce(deletion.promise)
    const approval = session.signIn()
    await vi.waitFor(() => expect(mocks.unlock).toHaveBeenCalledTimes(1))
    const signal = mocks.unlock.mock.calls[0][2] as AbortSignal
    const closed = session.signOut(),
      next = session.signIn()
    expect(signal.aborted).toBe(true)
    first.resolve({ enrollment, status })
    await approval
    await vi.waitFor(() => expect(mocks.deleteKey).toHaveBeenCalledWith(status.vaultId))
    expect(session.getSnapshot().locked).toBe(true)
    expect(mocks.unlock).toHaveBeenCalledTimes(1)
    deletion.resolve()
    await closed
    await next
    expect(mocks.unlock).toHaveBeenCalledTimes(2)
    expect(session.getSnapshot().locked).toBe(false)
  })
  it('cancels an approval before its first microtask without deadlocking teardown', async () => {
    const { session } = await create(ready, enrollment, true)
    const approval = session.signIn(),
      closed = session.signOut()
    await Promise.all([approval, closed])
    expect(mocks.unlock).not.toHaveBeenCalled()
    expect(session.getSnapshot().locked).toBe(true)
  })
  it('publishes no partial unlocked identity when validation fails', async () => {
    const { session } = await create(ready, enrollment, true)
    const snapshots: ReturnType<VaultSession['getSnapshot']>[] = []
    session.subscribe(() => snapshots.push(session.getSnapshot()))
    mocks.unlock.mockResolvedValue({ enrollment, status: { ...status, vaultId: 'different-account' } })
    await session.signIn()
    expect(snapshots.every((s) => s.locked && s.status?.vaultId === status.vaultId)).toBe(true)
    expect(outcome(session)).toBe('unlock-required')
  })
  it('blocks an account change from a stale balance result', async () => {
    const { session } = await create(ready, enrollment, true)
    expect(() => session.acceptStatus({ ...status, vaultId: 'other' })).toThrow('selected account')
    expect(session.getSnapshot().status?.vaultId).toBe(status.vaultId)
  })
  it('does not publish a live refresh that changes the admitted account identity', async () => {
    const { session } = await create(ready, enrollment, true)
    await session.signIn()
    const admitted = session.getSnapshot().account
    expect(admitted).not.toBeNull()
    expect(() => session.acceptStatus({ ...status, phoneDirectP256: `02${'11'.repeat(32)}` })).toThrow()
    expect(session.getSnapshot().account).toBe(admitted)
  })
  it('ignores a boot status response that arrives after sign-out', async () => {
    saveEnrollment(enrollment)
    saveSelectedVaultId(enrollment.vaultId)
    saveAddressPin(pinFromEnrolledStatus(status))
    const read = deferred<VaultStatus>()
    mocks.liveStatus.mockReturnValue(read.promise)
    const session = createVaultSession()
    releases.push(session.retain())
    await vi.waitFor(() => expect(mocks.liveStatus).toHaveBeenCalledTimes(1))
    const closing = session.signOut()
    read.resolve(status)
    await closing
    expect(outcome(session)).toBe('signed-out')
    expect(session.getSnapshot()).toMatchObject({ locked: true, status: null })
  })
  it('does not publish an unchanged error or accept a late balance update while locked', async () => {
    const { session } = await create(ready, enrollment, true)
    const listener = vi.fn(),
      before = session.getSnapshot()
    session.subscribe(listener)
    session.clearError()
    session.clearError()
    session.acceptStatus({ ...status, periodSpent: 1 })
    expect(listener).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toBe(before)
  })
  it('forgets completed teardown targets so later sign-out cannot revoke another account', async () => {
    const { session } = await create(ready, enrollment, true)
    await session.signOut()
    expect(mocks.deleteKey).toHaveBeenCalledExactlyOnceWith(status.vaultId)
    await session.signOut()
    expect(mocks.deleteKey).toHaveBeenCalledTimes(1)
    await session.signIn()
    await session.signOut()
    expect(mocks.deleteKey).toHaveBeenCalledTimes(2)
  })
  it('exposes immutable snapshots and keeps cancellation from mutating captured inputs', async () => {
    const { session } = await create(ready, enrollment, true)
    const snapshot = session.getSnapshot()
    expect(() => {
      snapshot.setup.txCapSats = 1
    }).toThrow(TypeError)
    expect(() => {
      snapshot.account!.enrollment.vaultId = 'other'
    }).toThrow(TypeError)
    expect(() => {
      snapshot.status!.vaultId = 'other'
    }).toThrow(TypeError)
    await session.signIn()
    expect(session.getSnapshot().status?.vaultId).toBe(status.vaultId)
  })
  it('shares deployment observation and discards its result when the view leaves', async () => {
    const { session } = await create()
    const read = deferred<{ network: string }>()
    mocks.publicStatus.mockReturnValue(read.promise)
    session.observeDeployment(true)
    session.observeDeployment(true)
    expect(mocks.publicStatus).toHaveBeenCalledTimes(1)
    const signal = mocks.publicStatus.mock.calls[0][0] as AbortSignal
    session.observeDeployment(false)
    expect(signal.aborted).toBe(true)
    read.resolve({ network: 'mainnet' })
    await Promise.resolve()
    expect(session.getSnapshot().deployment).toBeNull()
  })
  it('preserves one owner across immediate detach/reattach and makes release idempotent', async () => {
    const { session, release } = await create(ready, enrollment, true)
    release()
    release()
    const retained = session.retain()
    releases.push(retained)
    await Promise.resolve()
    expect(mocks.shutdown).not.toHaveBeenCalled()
    expect(mocks.liveStatus).toHaveBeenCalledTimes(1)
  })
})

describe('enrollment ownership', () => {
  it('requires Ledger before protected Savings and retains the draft', async () => {
    const { session } = await create({ ...ready, protectionTier: 'standard' })
    await session.enroll()
    expect(outcome(session)).toBe('hardware-required')
    expect(mocks.begin).not.toHaveBeenCalled()
  })
  it('creates shared Spending and retains a warning when both optional login installs fail', async () => {
    const { session } = await create()
    mocks.enable.mockRejectedValue(new Error('install unavailable'))
    await session.enroll('original-token')
    expect(mocks.begin).toHaveBeenCalledWith(
      'original-token',
      expect.objectContaining({ protectionTier: 'light' }),
      expect.any(AbortSignal),
    )
    expect(mocks.finish).toHaveBeenCalledWith('original-token', localStorage, expect.any(AbortSignal))
    expect(mocks.enable).toHaveBeenCalledTimes(2)
    expect(outcome(session)).toBe('created')
    expect(session.getSnapshot().error).toMatch(/sign-in after a restart is not on yet/)
  })
  async function nativeSetup(advanced = false) {
    const f = await ledgerRecoveryFixture(advanced)
    const contract = f.composite.savings
    const selected: VaultSetupPlan = {
      ...emptySetupPlan(),
      acceptedDesign: true,
      complete: true,
      protectionTier: advanced ? 'advanced' : 'standard',
      hardwarePub: f.status.externalOwnerWalletPub!,
      recoveryPub: f.status.recoveryPub || '',
      txCapSats: contract.spendingPolicy.txRecipientCapSats,
      dailyLimitSats: contract.spendingPolicy.periodAllowanceSats,
      absoluteFeeCapSats: contract.spendingPolicy.absoluteFeeCapSats,
      feerateCapSatPerV: contract.spendingPolicy.feerateCapSatPerV,
      ledger: {
        hardware: contract.context.hardware,
        ...(contract.context.recovery ? { recovery: contract.context.recovery } : {}),
      },
    }
    const { ledgerSavings, ...phone } = f.enrollment
    const draft = {
      version: ledgerSavings.version,
      contract: ledgerSavings.contract,
      phoneSeedBackup: ledgerSavings.phoneSeedBackup,
    }
    const saved: StagedEnrollment = {
      ...phone,
      handle: 'original-handle',
      userHandle: 'ab',
      clientDataJSON: '01',
      authenticatorData: '02',
      attestationObject: '03',
      hardwareXOnly: selected.hardwarePub.slice(2),
      ...(selected.recoveryPub ? { recoveryXOnly: selected.recoveryPub.slice(2) } : {}),
      inviteToken: 'original-token',
      descriptorHash: hashLedgerSavingsEnrollment(f.composite),
      boardingPub: f.composite.boarding.boardingPub,
      boardingDescriptor: f.composite.boarding,
      boardingDescriptorHash: hashLedgerSavingsEnrollment(f.composite),
      protectionTier: selected.protectionTier,
      spendingPolicy: contract.spendingPolicy,
      spendingPolicyDigest: contract.context.policyDigest,
      ledgerSavingsDraft: draft,
      ledgerSavingsDescriptor: f.composite,
    }
    return { f, selected, saved }
  }
  it('closes a late hardware connection without changing the setup after navigation cancels it', async () => {
    const { session } = await create()
    const { LEDGER_NATIVE_TEMPLATE } = await import('./program/ledgerNativeKeys')
    mocks.publicStatus.mockResolvedValue({
      network: 'mutinynet',
      ledgerSavingsCapability: { version: 1, templateVersion: LEDGER_NATIVE_TEMPLATE },
    })
    session.observeDeployment(true)
    await vi.waitFor(() => expect(session.getSnapshot().deployment).not.toBeNull())
    const close = vi.fn().mockResolvedValue(undefined),
      connection = deferred<{ app: object; close: typeof close }>()
    mocks.connect.mockReturnValue(connection.promise)
    const command = session.connectLedgerKey('hardware')
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
    session.cancelLedgerConnection()
    connection.resolve({ app: {}, close })
    await command
    expect(close).toHaveBeenCalledTimes(1)
    expect(mocks.readLedger).not.toHaveBeenCalled()
    expect(session.getSnapshot().setup).toEqual(ready)
    expect(session.getSnapshot().pending).toBeNull()
  })
  it.each([false, true])(
    'resumes the exact unregistered Ledger identity after remount (advanced=%s)',
    async (advanced) => {
      const { f, saved, selected } = await nativeSetup(advanced)
      mocks.begin.mockImplementation(async () => {
        saveStagedEnrollment(saved)
        return { enrollment: f.enrollment, enrollmentToken: saved.inviteToken }
      })
      const first = await create(selected)
      await first.session.enroll('original-token')
      first.release()
      await Promise.resolve()
      const next = await create(selected)
      await next.session.enroll('replacement-token')
      expect(mocks.begin).toHaveBeenCalledTimes(1)
      expect(mocks.finish).not.toHaveBeenCalled()
      expect(outcome(next.session)).toBe('registration-required')
      expect(loadStagedEnrollment()).toEqual(saved)
    },
  )
  it.each(['connecting', 'approving'])(
    'discards canceled Ledger registration during %s and closes the device',
    async (phase) => {
      const { f, selected, saved } = await nativeSetup()
      saveStagedEnrollment(saved)
      const { session } = await create(selected)
      const close = vi.fn().mockResolvedValue(undefined)
      const connection = deferred<{ app: object; close: typeof close }>()
      const registration = deferred<typeof f.enrollment.ledgerSavings.registration>()
      mocks.connect.mockReturnValue(connection.promise)
      mocks.registerLedger.mockReturnValue(registration.promise)
      const pending = session.approveLedgerEnrollment()
      await vi.waitFor(() => expect(session.getSnapshot().ledgerApprovalPhase).toBe('connecting'))
      if (phase === 'approving') {
        connection.resolve({ app: {}, close })
        await vi.waitFor(() => expect(mocks.registerLedger).toHaveBeenCalledOnce())
      }
      session.cancelLedgerRegistration()
      connection.resolve({ app: {}, close })
      registration.resolve(f.enrollment.ledgerSavings.registration)
      await pending
      expect(mocks.completeLedger).not.toHaveBeenCalled()
      expect(loadStagedEnrollment()).toEqual(saved)
      expect(close).toHaveBeenCalledOnce()
      if (phase === 'connecting') expect(mocks.registerLedger).not.toHaveBeenCalled()
    },
  )

  it('shares Ledger registration and finishes accepted persistence before closing the device', async () => {
    const { f, selected, saved } = await nativeSetup()
    saveStagedEnrollment(saved)
    const { session } = await create(selected)
    const close = vi.fn().mockResolvedValue(undefined)
    const finish = deferred<{ enrollment: EnrollmentSecrets; status: VaultStatus }>()
    mocks.connect.mockResolvedValue({ app: {}, close })
    mocks.registerLedger.mockResolvedValue(f.enrollment.ledgerSavings.registration)
    mocks.completeLedger.mockReturnValue(finish.promise)
    mocks.enable.mockResolvedValue(f.status)
    const pending = session.approveLedgerEnrollment()
    expect(session.approveLedgerEnrollment()).toBe(pending)
    await vi.waitFor(() => expect(session.getSnapshot().ledgerApprovalPhase).toBe('saving'))
    session.cancelLedgerRegistration()
    expect(close).not.toHaveBeenCalled()
    saveStagedEnrollment({ ...saved, ledgerSavings: f.enrollment.ledgerSavings })
    finish.resolve({ enrollment: f.enrollment, status: f.status })
    await pending
    expect(session.getSnapshot().ledgerApprovalPhase).toBe('complete')
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(mocks.registerLedger).toHaveBeenCalledOnce()
    expect(mocks.completeLedger).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('retains registration after a lost finish response and resumes without another approval', async () => {
    const { f, selected, saved } = await nativeSetup(true)
    saveStagedEnrollment(saved)
    const first = await create(selected)
    expect(first.session.getSnapshot().stagedEnrollment).toEqual(saved)
    mocks.connect.mockResolvedValue({ app: {}, close: vi.fn().mockResolvedValue(undefined) })
    mocks.registerLedger.mockResolvedValue(f.enrollment.ledgerSavings.registration)
    mocks.completeLedger.mockImplementation(async () => {
      saveStagedEnrollment({ ...saved, ledgerSavings: f.enrollment.ledgerSavings })
      throw new Error('finish response lost')
    })
    await expect(first.session.approveLedgerEnrollment()).rejects.toThrow('finish response lost')
    expect(first.session.getSnapshot().stagedEnrollment?.ledgerSavings).toEqual(f.enrollment.ledgerSavings)
    first.release()
    await Promise.resolve()
    const second = await create(selected)
    mocks.finish.mockResolvedValue({ enrollment: f.enrollment, status: f.status })
    mocks.enable.mockResolvedValue(f.status)
    await second.session.enroll('replacement-token')
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith('original-token', localStorage, expect.any(AbortSignal))
    expect(mocks.completeLedger).toHaveBeenCalledTimes(1)
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(outcome(second.session)).toBe('created')
  })
  it.each(['hardware', 'recovery', 'policy'] as const)(
    'rejects changed %s while a Ledger identity is staged',
    async (field) => {
      const { selected, saved } = await nativeSetup(true)
      saveStagedEnrollment(saved)
      const altered = structuredClone(selected)
      if (field === 'policy') altered.txCapSats -= 1
      else altered.ledger![field]!.fingerprint = 'ffffffff'
      const { session } = await create(altered)
      await session.enroll()
      expect(session.getSnapshot().error).toContain('already in progress')
      expect(mocks.begin).not.toHaveBeenCalled()
      expect(mocks.finish).not.toHaveBeenCalled()
      expect(loadStagedEnrollment()).toEqual(saved)
    },
  )
  it('revokes an interrupted activation while preserving the staged key for exact resumption', async () => {
    const { selected, saved, f } = await nativeSetup()
    saveStagedEnrollment({ ...saved, ledgerSavings: f.enrollment.ledgerSavings })
    const { session } = await create(selected)
    const finish = deferred<{ enrollment: EnrollmentSecrets; status: VaultStatus }>()
    mocks.finish.mockReturnValue(finish.promise)
    const operation = session.enroll()
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalled())
    const closed = session.signOut()
    finish.resolve({ enrollment: f.enrollment, status: f.status })
    await operation
    await closed
    expect(session.getSnapshot().locked).toBe(true)
    expect(mocks.suspendKey).toHaveBeenCalledWith(f.status.vaultId)
    expect(mocks.deleteKey).not.toHaveBeenCalledWith(f.status.vaultId)
    expect(loadStagedEnrollment()?.vaultId).toBe(f.status.vaultId)
    expect(loadSessionLocked()).toBe(true)
  })
})

describe('recovery import', () => {
  it('retains imported evidence when offline without publishing an empty unlocked session, then retries', async () => {
    const { session } = await create()
    const file = { header: { enrollment, status, binding: { vaultId: enrollment.vaultId } } }
    mocks.restoreArchive.mockImplementation(async () => {
      localStorage.setItem('imported-fixture', JSON.stringify(file))
    })
    mocks.openArchive.mockImplementation(async (_raw, restore) => {
      await restore(file, new Uint8Array(32))
      return file
    })
    mocks.liveStatus.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce(status)
    await expect(session.restoreRecoveryArchive({ name: 'encrypted-fixture' })).rejects.toThrow('Failed to fetch')
    expect(localStorage.getItem('imported-fixture')).toBe(JSON.stringify(file))
    expect(session.getSnapshot()).toMatchObject({ account: null, status: null, pending: null })
    expect(outcome(session)).not.toBe('authenticated')
    expect(session.getSnapshot().error).toBe(
      'Recovery data is saved on this device. Live balances could not be loaded.',
    )
    await session.restoreRecoveryArchive({ name: 'encrypted-fixture' })
    expect(session.getSnapshot()).toMatchObject({ account: { status, enrollment }, status, locked: false })
    expect(outcome(session)).toBe('authenticated')
  })
})
