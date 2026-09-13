import type { VaultStatus } from './types'
import type { RecoveryKit } from './program/kit'
import type { VaultSession } from './session'
import type { VaultMaintenanceTask } from './accountMaintenance'
import { vaultAccountRuntime, vaultWalletRuntimeKey } from './accountRuntime'
import { unlockPhoneBip340 } from './savingsSpend'
import { zeroBytes } from './ceremony/directauth'
import { captureVaultRecoveryFile } from './recovery/capture'
import { openRecoveryCloudBackup, syncRecoveryCloudBackup, type RecoveryBackupSession } from './recovery/cloudBackup'
import { buildRecoveryHeader, encryptRecoveryBackup, recoveryBackupKey } from './recovery/backupCodec'
import { createPortableRecoveryPackage } from './recovery/portable'
import { recordRecoveryFileCopy } from './recovery/packageCheck'
import { kitFromFacts, pullMapBackup, pushMapBackup } from './program/kitBackup'
import { loadLocalKit, saveLocalKit } from './program/kitStore'
import { kitMatchesLiveVault } from './program/liveKit'
import { recoverMatureBoardingInputs } from './vtxo/boardingRecovery'

/** Recovery commands bind the enrolled session identity and own their flights. */
interface RecoverySnapshot {
  archiveStatus: string
  archiveError: string
  hasKit: boolean
  pending: 'archive' | 'backup' | 'kit' | 'boarding' | null
}
interface CaptureFence {
  generation: number
  identity: string
  activity: number
}
interface CaptureLocal {
  status: VaultStatus
  file: Awaited<ReturnType<typeof captureVaultRecoveryFile>>['file']
  context: number
  epoch: string
  activity: number
  current: () => boolean
}
type SessionSource = Pick<VaultSession, 'getSnapshot' | 'subscribe'>
const owners = new WeakMap<SessionSource, RecoveryCommands>()
class RecoveryError extends Error {}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

export function recoveryCommandsForSession(session: SessionSource) {
  let owner = owners.get(session)
  if (!owner) {
    owner = createRecoveryCommands(session)
    owners.set(session, owner)
  }
  return owner
}

function createRecoveryCommands(session: SessionSource) {
  let snapshot: RecoverySnapshot = freeze({ archiveStatus: '', archiveError: '', hasKit: false, pending: null })
  let consumers = 0
  let identity = ''
  let locked = true
  let generation = 0
  let activityEpoch = 0
  let cloud: { session: RecoveryBackupSession; identity: string } | null = null
  let observation: VaultMaintenanceTask<void> | undefined
  let flight: { key: string; abort: AbortController; promise: Promise<unknown> } | undefined
  let captureTail: Promise<unknown> = Promise.resolve()
  let captureFlight: { key: string; promise: Promise<CaptureLocal> } | undefined
  let cloudChain: Promise<unknown> = Promise.resolve()
  let unsubscribe: (() => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (change: Partial<RecoverySnapshot>) => {
    if (Object.entries(change).every(([key, value]) => Object.is(snapshot[key as keyof RecoverySnapshot], value)))
      return
    snapshot = freeze({ ...snapshot, ...change })
    for (const listener of listeners) listener()
  }
  const sessionIdentity = () => {
    const { account } = session.getSnapshot()
    return account ? JSON.stringify([vaultWalletRuntimeKey(account.status), account.enrollment]) : ''
  }
  const access = () => {
    const { account, setup, locked: isLocked } = session.getSnapshot()
    if (!consumers || !identity || identity !== sessionIdentity() || !account)
      throw new RecoveryError('Sign in with the passkey that created this vault.')
    return { account, status: account.status, enrollment: account.enrollment, setup, locked: isLocked }
  }
  const unlocked = () => {
    const current = access()
    if (current.locked) throw new RecoveryError('Unlock this vault first')
    return current
  }
  const resolveKit = (): RecoveryKit | null => {
    const { status, enrollment, setup } = access()
    const id = status.vaultId || enrollment.vaultId || ''
    const stored = id ? loadLocalKit(id) : null
    if (status.enrolled && stored && kitMatchesLiveVault(stored, status)) return stored
    return kitFromFacts({
      enrollment,
      status,
      hardwarePub: setup.hardwarePub,
      recoveryPub: setup.recoveryPub || status.recoveryPub,
    })
  }
  const refreshKit = () => {
    if (!consumers || !identity || identity !== sessionIdentity()) {
      if (snapshot.hasKit) publish({ hasKit: false })
      return
    }
    let hasKit = false
    try {
      hasKit = Boolean(resolveKit())
    } catch {
      hasKit = false
    }
    if (hasKit !== snapshot.hasKit) publish({ hasKit })
  }
  const dropObservation = async () => {
    const task = observation
    observation = undefined
    await task?.dispose()
  }
  const cancel = () => {
    generation++
    flight?.abort.abort(new DOMException('Recovery session ended', 'AbortError'))
    void dropObservation()
    cloud = null
  }
  const currentFence = (): CaptureFence => ({ generation, identity: sessionIdentity(), activity: activityEpoch })
  const captureLocalWork = async (signal: AbortSignal | undefined, fence: CaptureFence): Promise<CaptureLocal> => {
    if (fence.generation !== generation || fence.identity !== sessionIdentity())
      throw new DOMException('Recovery session ended', 'AbortError')
    const { status, enrollment } = unlocked()
    const context = generation
    const epoch = identity
    const activity = fence.activity
    const { file, coverage } = await captureVaultRecoveryFile(status, enrollment)
    const current = () =>
      !signal?.aborted && context === generation && epoch === sessionIdentity() && activity === activityEpoch
    if (context !== generation) throw new RecoveryError('Wallet session changed during recovery backup')
    if (current()) {
      const account = vaultAccountRuntime(status)
      await account.bitcoinPayments?.acknowledgeRecovery(coverage)
      if (current()) await account.spendingPayments?.acknowledgeSettledRecovery(coverage)
    }
    if (context !== generation) throw new RecoveryError('Wallet session changed during recovery backup')
    await recordRecoveryFileCopy('local', file)
    return { status, file, context, epoch, activity, current }
  }
  // Concurrent demand for the same generation and activity shares one capture;
  // later activity queues the later capture it requires. A queued capture checks
  // its fence before touching the session, so a stale command fails admission.
  // Account-runtime disposal drains the tail and the cloud chain.
  const captureFor = (fence: CaptureFence, signal?: AbortSignal): Promise<CaptureLocal> => {
    const key = JSON.stringify([fence.generation, fence.identity, fence.activity])
    if (captureFlight && captureFlight.key === key) return captureFlight.promise
    const promise = captureTail.catch(() => undefined).then(() => captureLocalWork(signal, fence))
    const entry = { key, promise }
    captureFlight = entry
    captureTail = promise.then(
      () => undefined,
      () => undefined,
    )
    void promise
      .catch(() => undefined)
      .finally(() => {
        if (captureFlight === entry) captureFlight = undefined
      })
    return promise
  }
  const withCloud = <T>(work: () => Promise<T>): Promise<T> => {
    const next = cloudChain.catch(() => undefined).then(work)
    cloudChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const captureArchive = async (requireCloudBackup: boolean, signal: AbortSignal | undefined, fence: CaptureFence) => {
    // Admit the immutable cloud session before awaiting capture. A session
    // opened for another account identity is never adopted, and an already
    // admitted write still drains after lock while new authority is refused.
    const admitted = cloud && cloud.identity === fence.identity ? cloud.session : null
    const { status, file, context, current } = await captureFor(fence, signal)
    if (admitted && admitted.header.binding.vaultId === status.vaultId) {
      await withCloud(() => syncRecoveryCloudBackup(admitted, file))
      if (requireCloudBackup && context !== generation)
        throw new RecoveryError('Wallet session changed during recovery backup')
      await recordRecoveryFileCopy('service', file)
      if (current())
        publish({ archiveStatus: `Encrypted cloud backup verified ${new Date().toLocaleString()}`, archiveError: '' })
    } else {
      if (requireCloudBackup) throw new RecoveryError('Unlock this vault again to enable backup')
      if (current())
        publish({
          archiveStatus: `Transaction recovery data saved on this device ${new Date().toLocaleString()}`,
          archiveError: '',
        })
    }
    return file
  }
  const startObservation = (status: VaultStatus) => {
    observation = vaultAccountRuntime(status).maintenance.observe(
      'recovery-archive',
      async (signal) => {
        await captureArchive(false, signal, currentFence())
      },
      {
        intervalMs: 30_000,
        events: ['wallet', 'focus', 'online', 'visibilitychange', 'vaulted-savings-setup'],
        trailing: true,
        requested: () => {
          activityEpoch++
          if (identity === sessionIdentity()) publish({ archiveStatus: 'Checking recovery data against your wallet…' })
        },
        failed: (error) => {
          if (identity !== sessionIdentity()) return
          publish({
            archiveStatus: 'Recovery data update incomplete',
            archiveError:
              error instanceof Error ? error.message : 'Recovery update failed; the previous copy is retained',
          })
        },
      },
    )
    observation.request()
  }
  const bind = () => {
    const next = sessionIdentity()
    const nextLocked = session.getSnapshot().locked
    if (next !== identity || nextLocked !== locked) {
      cancel()
      identity = next
      locked = nextLocked
      cloud = null
      activityEpoch = 0
      publish({ archiveStatus: '', archiveError: '', pending: null })
    }
    refreshKit()
    if (!consumers || !identity || locked) return
    const { status } = session.getSnapshot()
    if (!status || observation) return
    vaultAccountRuntime(status).recoveryCommands = owner
    startObservation(status)
  }
  const run = <T>(
    kind: NonNullable<RecoverySnapshot['pending']>,
    key: string,
    work: (check: () => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (flight) {
      if (!flight.abort.signal.aborted && flight.key === key) return flight.promise as Promise<T>
      return Promise.reject(new RecoveryError('Finish the current recovery action before continuing.'))
    }
    const epoch = generation
    const abort = new AbortController()
    const current = { key, abort, promise: Promise.resolve() as Promise<unknown> }
    flight = current
    const check = () => {
      abort.signal.throwIfAborted()
      if (epoch !== generation || identity !== sessionIdentity())
        throw new DOMException('Recovery session ended', 'AbortError')
    }
    publish({ pending: kind })
    current.promise = (async () => {
      check()
      const result = await work(check, abort.signal)
      // Accepted persistence drains, but a canceled or replaced caller cannot
      // publish completion: one fence for every command at the common boundary.
      check()
      return result
    })().finally(() => {
      if (flight === current) {
        flight = undefined
        publish({ pending: null })
        refreshKit()
      }
    })
    return current.promise as Promise<T>
  }
  const owner = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    retain() {
      consumers++
      if (consumers === 1) {
        unsubscribe = session.subscribe(bind)
        bind()
      }
      let released = false
      return () => {
        if (released) return
        released = true
        if (--consumers) return
        unsubscribe?.()
        unsubscribe = undefined
        void owner.suspend()
      }
    },
    backupRecoveryArchive(): Promise<void> {
      return run('backup', 'backup-archive', async (check, signal) => {
        const { status, enrollment } = unlocked()
        const fence = currentFence()
        const kit = kitFromFacts({ status, enrollment })
        if (!kit) throw new RecoveryError('Recovery descriptor is unavailable')
        const header = buildRecoveryHeader(kit, status, enrollment)
        if (!cloud || cloud.identity !== fence.identity || Date.parse(cloud.session.expiresAt) <= Date.now()) {
          const epoch = generation
          const opened = await openRecoveryCloudBackup(header)
          check()
          if (epoch !== generation) throw new RecoveryError('Unlock this vault again to enable backup')
          cloud = { session: opened, identity: fence.identity }
        }
        await captureArchive(true, signal, fence)
      })
    },
    downloadRecoveryArchive(format: 'encrypted' | 'portable' = 'encrypted'): Promise<string> {
      return run('archive', `download:${format}`, async (check, signal) => {
        const { status, enrollment } = unlocked()
        const fence = currentFence()
        const { file } = await captureFor(fence, signal)
        check()
        const encode = async (key: CryptoKey) =>
          JSON.stringify(
            format === 'portable'
              ? await createPortableRecoveryPackage(file, key)
              : await encryptRecoveryBackup(file, key),
            null,
            2,
          )
        const admitted = cloud && cloud.identity === fence.identity ? cloud.session : null
        if (admitted?.header.binding.vaultId === status.vaultId) return encode(admitted.key)
        const phone = await unlockPhoneBip340(enrollment, status, signal)
        try {
          return await encode(await recoveryBackupKey(phone, file.header))
        } finally {
          zeroBytes(phone)
        }
      })
    },
    downloadRecoveryKit(): string {
      const kit = resolveKit()
      if (!kit) throw new RecoveryError('No Recovery Kit yet. Add recovery, or get the map with Face ID.')
      return JSON.stringify(kit, null, 2)
    },
    backupRecoveryKit(): Promise<boolean> {
      return run('kit', 'backup-kit', async (check, signal) => {
        const { enrollment, status } = access()
        if (enrollment && status.enrolled) zeroBytes(await unlockPhoneBip340(enrollment, status, signal))
        check()
        const kit = resolveKit()
        if (!kit) throw new RecoveryError('This vault has no recovery map. Add recovery on a new vault.')
        saveLocalKit(kit)
        refreshKit()
        const id = kit.descriptor.vaultId
        return id ? pushMapBackup(id, kit) : false
      })
    },
    restoreRecoveryKit(): Promise<void> {
      return run('kit', 'restore-kit', async (check, signal) => {
        const { status, enrollment, setup } = access()
        if (enrollment && status.enrolled) zeroBytes(await unlockPhoneBip340(enrollment, status, signal))
        check()
        const id = status.vaultId || enrollment?.vaultId || ''
        const pulled = id ? await pullMapBackup(id) : null
        check()
        const kit =
          pulled?.kit ||
          kitFromFacts({
            enrollment,
            status,
            hardwarePub: setup.hardwarePub,
            recoveryPub: setup.recoveryPub || status.recoveryPub,
          })
        if (!kit) throw new RecoveryError('Could not rebuild the map. Save it while this app is open.')
        if (id && kit.descriptor.vaultId !== id) throw new RecoveryError('Recovery Kit does not match this vault')
        if (status.enrolled && status.templateVersion && kit.descriptor.templateVersion !== status.templateVersion) {
          throw new RecoveryError('Recovery Kit does not match this vault')
        }
        saveLocalKit(kit)
        refreshKit()
      })
    },
    recoverMatureBoarding(): Promise<string> {
      return run('boarding', 'mature-boarding', async (check, signal) => {
        const { status, enrollment } = unlocked()
        const txid = await recoverMatureBoardingInputs(enrollment, status, { check, signal })
        check()
        await Promise.resolve(vaultAccountRuntime(status).balances?.refreshBalance(status.vaultId)).catch(
          () => undefined,
        )
        return txid
      })
    },
    async suspend() {
      cancel()
      identity = ''
      publish({ archiveStatus: '', archiveError: '', pending: null, hasKit: false })
      await Promise.allSettled([flight?.promise, captureTail, cloudChain])
    },
  }
  return owner
}
export type RecoveryCommands = ReturnType<typeof createRecoveryCommands>
