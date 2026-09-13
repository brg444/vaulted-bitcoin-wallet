import { clearSpendingRenewalReads } from './vtxo/guardianRenewal'
import { renewFromLocalUnlock, setupSpendingRenewals } from './vtxo/renewalCeremony'
import { shutdownVaultWalletWorker } from './vtxo/walletWorker'
import { deleteBoardingKey, suspendBoardingKey } from './vtxo/board'
import { disableBackgroundPush } from './pushSubscription'
import { openRecoveryCloudBackup } from './recovery/cloudBackup'
import { openLocalRecoveryBackup } from './recovery/backupCodec'
import { restoreVaultRecoveryFile } from './recovery/restore'
import { fetchPublicStatus, fetchVaultStatus, type PublicAuthorizerStatus } from './status'
import {
  findStoredEnrollment,
  loadEnrollment,
  loadSelectedVaultId,
  loadSessionLocked,
  loadStagedEnrollment,
  saveEnrollment,
  saveSelectedVaultId,
  setSessionLocked,
} from './enrollmentStore'
import { humanizeVaultError } from './humanize'
import { loadAddressPin, pinFromEnrolledStatus, requireStatusMatchesPin, saveAddressPin, type AddressPin } from './pin'
import { discoverVaultIdFromPasskey, enablePasskeyLogin, signInWithPasskey, unlockLocalEnrollment } from './signIn'
import {
  clearSetupPlan,
  emptySetupPlan,
  loadSetupPlan,
  planReady,
  sameRole,
  saveSetupPlan,
  setupSpendingPolicy,
  type VaultSetupPlan,
} from './setupPlan'
import {
  beginTenantEnrollment,
  completeLedgerTenantEnrollment,
  finishTenantEnrollment,
  reconcileStagedEnrollment,
  type EnrollmentSecrets,
} from './tenantEnrollment'
import { approveLedgerRegistration, type LedgerApprovalPhase } from './ledgerApproval'
import { ledgerSpendingPublicKey, parseLedgerAccountOrigin } from './ledgerSetup'
import { LEDGER_NATIVE_TEMPLATE } from './program/ledgerNativeKeys'
import { canonicalLedgerValue } from './program/ledgerEnrollment'
import { kitFromFacts, pullMapBackup, pushMapBackup } from './program/kitBackup'
import { saveLocalKit } from './program/kitStore'
import { loadVaultPrivacyLock, saveVaultPrivacyLock } from './prefs'
import { requireProtectionTier, type ProtectionTier } from './protectionTier'
import { validateSpendingPolicy, type SpendingPolicy } from './spendingPolicy'
import type { VaultStatus } from './types'

type SessionCommand = 'boot' | 'sign-in' | 'enroll' | 'register-ledger' | 'enable-passkey' | 'restore' | 'ledger-key'
export type SessionOutcome =
  | 'authenticated'
  | 'unlock-required'
  | 'signin-required'
  | 'signed-out'
  | 'hardware-required'
  | 'recovery-required'
  | 'conditions-required'
  | 'passkey-required'
  | 'registration-required'
  | 'enrolling'
  | 'created'
  | 'setup-failed'

export interface VaultSessionSnapshot {
  readonly setup: VaultSetupPlan
  readonly enrollment: EnrollmentSecrets | null
  readonly stagedEnrollment: ReturnType<typeof loadStagedEnrollment>
  readonly privacyLock: boolean
  readonly ledgerApprovalPhase: LedgerApprovalPhase
  readonly status: VaultStatus | null
  readonly addressPin: AddressPin | null
  readonly deployment: PublicAuthorizerStatus | null
  readonly locked: boolean
  readonly loaded: boolean
  readonly initialStatusChecked: boolean
  readonly pending: SessionCommand | null
  readonly error: string
  readonly transition: { readonly id: number; readonly outcome: SessionOutcome } | null
}

function browserWrite(write: () => void) {
  try {
    write()
  } catch {
    /* Verified in-memory access survives denied browser persistence. */
  }
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}

/** Owns account admission and every session mutation; React only observes and issues commands. */
export function createVaultSession() {
  let snapshot: VaultSessionSnapshot = {
    setup: emptySetupPlan(),
    enrollment: null,
    stagedEnrollment: null,
    privacyLock: false,
    ledgerApprovalPhase: 'idle',
    status: null,
    addressPin: null,
    deployment: null,
    locked: true,
    loaded: false,
    initialStatusChecked: false,
    pending: null,
    error: '',
    transition: null,
  }
  const listeners = new Set<() => void>()
  const targets = new Set<string>()
  const admitted = new Set<string>()
  let consumers = 0
  let generation = 0
  let transitionId = 0
  let admissionGeneration = 0
  let booted = false
  let flight: { kind: SessionCommand; key: string; abort: AbortController; promise: Promise<void> } | undefined
  let draining: Promise<void> = Promise.resolve()
  let deploymentDemand = false
  let deploymentTimer: ReturnType<typeof setInterval> | undefined
  let deploymentRead: { abort: AbortController; promise: Promise<void> } | undefined

  const publish = (change: Partial<VaultSessionSnapshot>) => {
    if (Object.entries(change).every(([key, value]) => Object.is(snapshot[key as keyof VaultSessionSnapshot], value)))
      return
    snapshot = immutable({ ...snapshot, ...change })
    for (const listener of listeners) listener()
  }
  const transition = (outcome: SessionOutcome) => publish({ transition: { id: ++transitionId, outcome } })
  const remember = (id: string) => {
    if (id) targets.add(id)
  }
  const selectedId = () => snapshot.enrollment?.vaultId || snapshot.addressPin?.vaultId || loadSelectedVaultId()
  const persistPlan = (plan: VaultSetupPlan) => {
    const setup = structuredClone(plan)
    saveSetupPlan(setup)
    publish({ setup })
  }
  const projectSetup = (live: VaultStatus) => ({
    ...snapshot.setup,
    protectionTier: live.protectionTier,
    recoveryPub: live.recoveryPub || live.recoveryKeyPub || '',
    txCapSats: live.txCap || snapshot.setup.txCapSats,
    dailyLimitSats: live.periodAllowance || snapshot.setup.dailyLimitSats,
    absoluteFeeCapSats: live.absoluteFeeCap ?? snapshot.setup.absoluteFeeCapSats,
    feerateCapSatPerV: live.feerateCapSatVb || snapshot.setup.feerateCapSatPerV,
  })
  const acceptStatus = (live: VaultStatus) => {
    const id = selectedId()
    if (id && live.vaultId !== id) throw new Error('Session status does not match the selected account')
    if (snapshot.addressPin) requireStatusMatchesPin(live, snapshot.addressPin)
    const setup = projectSetup(live)
    if (JSON.stringify(setup) !== JSON.stringify(snapshot.setup)) browserWrite(() => saveSetupPlan(setup))
    remember(live.vaultId)
    publish({ status: structuredClone(live), setup })
  }
  const accept = (result: { enrollment: EnrollmentSecrets; status: VaultStatus }, outcome: SessionOutcome) => {
    const { enrollment, status } = structuredClone(result)
    if (enrollment.vaultId !== status.vaultId) throw new Error('Session enrollment identity changed')
    const addressPin = pinFromEnrolledStatus(status)
    const existingPin =
      snapshot.addressPin?.vaultId === status.vaultId
        ? snapshot.addressPin
        : loadAddressPin(localStorage, status.vaultId)
    if (existingPin) requireStatusMatchesPin(status, existingPin)
    const setup = projectSetup(status)
    remember(status.vaultId)
    admitted.add(status.vaultId)
    admissionGeneration++
    browserWrite(() => saveAddressPin(addressPin))
    browserWrite(() => saveEnrollment(enrollment))
    browserWrite(() => saveSelectedVaultId(enrollment.vaultId))
    browserWrite(() => saveSetupPlan(setup))
    browserWrite(() => setSessionLocked(false))
    publish({
      enrollment,
      status,
      setup,
      addressPin,
      locked: false,
      initialStatusChecked: true,
      transition: { id: ++transitionId, outcome },
    })
  }
  const cancel = () => {
    generation++
    admissionGeneration++
    flight?.abort.abort(new DOMException('Session operation ended', 'AbortError'))
    for (const id of targets) clearSpendingRenewalReads(id)
  }
  const teardown = (signOut: boolean, replace = false) => {
    const interrupted = flight?.kind && flight.kind !== 'boot'
    cancel()
    const pending = flight?.promise
    const previousDrain = draining
    const cleanupTargets = new Set(targets)
    const preserve = signOut || replace || interrupted ? new Set<string>() : new Set(admitted)
    if (signOut || replace || interrupted) browserWrite(() => setSessionLocked(true))
    publish({ locked: true, pending: null, error: '' })
    if (signOut) transition('signed-out')
    const status = snapshot.status
    if (signOut && status) void disableBackgroundPush(status).catch(() => undefined)
    draining = previousDrain
      .catch(() => undefined)
      .then(async () => {
        await pending?.catch(() => undefined)
        // A proposal may finish and register its target after cancellation.
        for (const id of targets) cleanupTargets.add(id)
        const staged = loadStagedEnrollment()
        for (const id of cleanupTargets) {
          clearSpendingRenewalReads(id)
          await shutdownVaultWalletWorker(id)
          if (!preserve.has(id)) {
            if (staged?.vaultId === id) await suspendBoardingKey(id)
            else await deleteBoardingKey(id)
          }
          targets.delete(id)
          admitted.delete(id)
        }
      })
    return draining
  }
  const run = (
    kind: SessionCommand,
    work: (signal: AbortSignal) => Promise<void>,
    key: string = kind,
    rethrow = false,
  ): Promise<void> => {
    if (flight && !flight.abort.signal.aborted) {
      if (flight.kind === kind && flight.key === key) return flight.promise
      if (flight.kind !== 'boot') {
        const error = new Error('Finish the current session approval first.')
        publish({ error: error.message })
        return rethrow ? Promise.reject(error) : Promise.resolve()
      }
      cancel()
    }
    const previous = flight?.promise
    const barrier = draining
    const epoch = generation
    const abort = new AbortController()
    const current = { kind, key, abort, promise: Promise.resolve() }
    const promise = (async () => {
      await previous?.catch(() => undefined)
      await barrier
      if (epoch !== generation) abort.abort(new DOMException('Session operation ended', 'AbortError'))
      abort.signal.throwIfAborted()
      publish({ pending: kind, error: '' })
      await work(abort.signal)
    })()
      .catch((error) => {
        if (abort.signal.aborted || epoch !== generation) return
        if (!snapshot.error) publish({ error: humanizeVaultError(error) })
        if (kind === 'enroll') transition('setup-failed')
        if (rethrow) throw error
      })
      .finally(() => {
        if (flight !== current) return
        flight = undefined
        let stagedEnrollment = snapshot.stagedEnrollment
        try {
          stagedEnrollment = loadStagedEnrollment()
        } catch {
          /* Browser persistence may be unavailable after a completed approval. */
        }
        publish({ pending: null, stagedEnrollment })
      })
    current.promise = promise
    flight = current
    return promise
  }
  const restoreMap = async (
    enrollment: EnrollmentSecrets,
    status: VaultStatus,
    setup: VaultSetupPlan,
    signal: AbortSignal,
  ) => {
    const admission = admissionGeneration
    try {
      const pulled = await pullMapBackup(status.vaultId)
      signal.throwIfAborted()
      if (admission !== admissionGeneration || snapshot.locked) return
      const kit =
        pulled?.kit ||
        kitFromFacts({
          enrollment,
          status,
          hardwarePub: setup.hardwarePub,
          recoveryPub: setup.recoveryPub || status.recoveryPub,
        })
      if (kit) saveLocalKit(kit)
    } catch {
      /* Map backup is independent of authenticated access. */
    }
  }
  const acceptEnrollment = async (
    result: { enrollment: EnrollmentSecrets; status: VaultStatus },
    setup: VaultSetupPlan,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted()
    accept(result, 'enrolling')
    persistPlan({ ...setup, complete: true })
    try {
      const kit = kitFromFacts({
        enrollment: result.enrollment,
        status: result.status,
        hardwarePub: setup.hardwarePub,
        recoveryPub: setup.recoveryPub || result.status.recoveryPub,
      })
      if (kit) {
        saveLocalKit(kit)
        await pushMapBackup(kit.descriptor.vaultId, kit)
      }
    } catch {
      /* Enrollment already persisted the committed local kit. */
    }
    signal.throwIfAborted()
    let installed = false
    for (let attempt = 0; attempt < 2 && !installed; attempt++) {
      try {
        const live = await enablePasskeyLogin(result.enrollment, signal)
        signal.throwIfAborted()
        acceptStatus(live)
        installed = true
      } catch {
        signal.throwIfAborted()
      }
    }
    if (!installed)
      publish({
        error:
          'This device has the vault, but sign-in after a restart is not on yet. Open Settings, tap Allow other devices, and approve Face ID. Do not clear this browser until that succeeds.',
      })
    signal.throwIfAborted()
    await setupSpendingRenewals(result.status, result.enrollment, signal)
    signal.throwIfAborted()
    transition('created')
  }
  const boot = () =>
    run('boot', async (signal) => {
      let existing: EnrollmentSecrets | null = null
      let selected: string | null = null
      try {
        const setup = loadSetupPlan() || emptySetupPlan()
        selected = loadSelectedVaultId()
        existing = selected ? loadEnrollment(localStorage, selected) : findStoredEnrollment()
        selected = existing?.vaultId || selected
        if (existing) browserWrite(() => saveSelectedVaultId(existing!.vaultId))
        const addressPin = selected ? loadAddressPin(localStorage, selected) : null
        const privacyLock = loadVaultPrivacyLock()
        const stagedEnrollment = loadStagedEnrollment()
        const requiresUnlock = loadSessionLocked() || Boolean(existing && privacyLock)
        const locked = requiresUnlock || Boolean(existing && !addressPin)
        if (selected) remember(selected)
        if (existing && addressPin && !locked) admitted.add(existing.vaultId)
        publish({ setup, enrollment: existing, stagedEnrollment, privacyLock, addressPin, locked, loaded: true })
        if (existing)
          transition(locked ? (requiresUnlock || addressPin ? 'unlock-required' : 'signin-required') : 'authenticated')
        else if (setup.complete) transition('passkey-required')
      } catch {
        browserWrite(clearSetupPlan)
        publish({ loaded: true })
      }
      try {
        const staged = loadStagedEnrollment()
        if (staged) remember(staged.vaultId)
        const recovered = !snapshot.locked ? await reconcileStagedEnrollment(localStorage, signal) : null
        signal.throwIfAborted()
        if (recovered && !loadSessionLocked()) {
          accept(recovered, 'authenticated')
          return
        }
        if (selected) {
          const live = await fetchVaultStatus(signal, selected)
          signal.throwIfAborted()
          acceptStatus(live)
        }
      } catch (error) {
        if (!signal.aborted && error instanceof Error && /local pin|not pinned locally/.test(error.message))
          publish({ error: humanizeVaultError(error) })
      } finally {
        if (!signal.aborted) publish({ initialStatusChecked: true })
      }
    })
  const persistPrivacyLock = () => {
    if (loadVaultPrivacyLock() && snapshot.enrollment) browserWrite(() => setSessionLocked(true))
  }
  const visibility = () => {
    if (document.visibilityState === 'hidden') persistPrivacyLock()
  }
  const refreshDeployment = () => {
    if (!deploymentDemand || !consumers || deploymentRead) return
    const abort = new AbortController()
    const request = { abort, promise: Promise.resolve() }
    request.promise = fetchPublicStatus(abort.signal)
      .then((deployment) => {
        if (!abort.signal.aborted) publish({ deployment })
      })
      .catch(() => {
        if (!abort.signal.aborted) publish({ deployment: null })
      })
      .finally(() => {
        if (deploymentRead === request) deploymentRead = undefined
      })
    deploymentRead = request
  }
  const stopDeployment = () => {
    if (deploymentTimer) clearInterval(deploymentTimer)
    deploymentTimer = undefined
    deploymentRead?.abort.abort()
    deploymentRead = undefined
    window.removeEventListener('focus', refreshDeployment)
  }
  const observeDeployment = (enabled: boolean) => {
    if (deploymentDemand === enabled && (!enabled || deploymentTimer)) return
    deploymentDemand = enabled
    stopDeployment()
    if (!enabled || !consumers) return
    refreshDeployment()
    window.addEventListener('focus', refreshDeployment)
    deploymentTimer = setInterval(refreshDeployment, 30_000)
  }
  const changePlan = (update: (current: VaultSetupPlan) => VaultSetupPlan) => {
    if (flight && flight.kind !== 'boot')
      void teardown(false).catch((error) => publish({ error: humanizeVaultError(error) }))
    publish({ error: '' })
    persistPlan(update(snapshot.setup))
  }

  return {
    getSnapshot: () => immutable(snapshot),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    retain() {
      consumers++
      if (consumers === 1) {
        window.addEventListener('pagehide', persistPrivacyLock)
        document.addEventListener('visibilitychange', visibility)
        observeDeployment(deploymentDemand)
        if (!booted) {
          booted = true
          void boot()
        }
      }
      let released = false
      return () => {
        if (released) return
        released = true
        consumers--
        queueMicrotask(() => {
          if (consumers) return
          stopDeployment()
          window.removeEventListener('pagehide', persistPrivacyLock)
          document.removeEventListener('visibilitychange', visibility)
          booted = false
          void teardown(false).catch(() => undefined)
        })
      }
    },
    observeDeployment,
    setPrivacyLock(enabled: boolean) {
      browserWrite(() => saveVaultPrivacyLock(enabled))
      browserWrite(() => setSessionLocked(enabled))
      publish({ privacyLock: enabled })
    },
    acceptStatus(live: VaultStatus) {
      if (selectedId() && live.vaultId !== selectedId())
        throw new Error('Session status does not match the selected account')
      if (!snapshot.locked) acceptStatus(live)
    },
    clearError: () => publish({ error: '' }),
    signOut: () =>
      teardown(true).catch((error) => {
        publish({ error: humanizeVaultError(error) })
        throw error
      }),
    cancelLedgerConnection() {
      if (flight?.kind === 'ledger-key') cancel()
    },
    acceptDesign(tier?: ProtectionTier) {
      if (import.meta.env.VITE_VAULT_LIGHT_ONLY_ENROLLMENT === 'true' && tier !== 'light') return
      if (snapshot.enrollment && !snapshot.locked)
        void teardown(true).catch((error) => publish({ error: humanizeVaultError(error) }))
      const draft = snapshot.setup.complete ? emptySetupPlan() : snapshot.setup
      const protectionTier = tier || draft.protectionTier
      changePlan(() => ({
        ...draft,
        acceptedDesign: true,
        protectionTier,
        ...(protectionTier === 'light' ? { hardwarePub: '', recoveryPub: '', ledger: undefined } : {}),
        ...(protectionTier === 'standard'
          ? { recoveryPub: '', ...(draft.ledger ? { ledger: { hardware: draft.ledger.hardware } } : {}) }
          : {}),
      }))
      transition(protectionTier === 'light' ? 'conditions-required' : 'hardware-required')
    },
    setProtectionTier(tier: ProtectionTier) {
      const selected = requireProtectionTier(tier)
      changePlan((current) => ({
        ...current,
        protectionTier: selected,
        ...(selected === 'standard'
          ? { recoveryPub: '', ...(current.ledger ? { ledger: { hardware: current.ledger.hardware } } : {}) }
          : {}),
      }))
    },
    skipRecovery() {
      changePlan((current) => ({
        ...current,
        protectionTier: 'standard',
        recoveryPub: '',
        ...(current.ledger ? { ledger: { hardware: current.ledger.hardware } } : {}),
      }))
      transition('conditions-required')
    },
    setSpendingPolicy(selected: SpendingPolicy) {
      try {
        const policy = validateSpendingPolicy(selected)
        changePlan((current) => ({
          ...current,
          txCapSats: policy.txRecipientCapSats,
          dailyLimitSats: policy.periodAllowanceSats,
          absoluteFeeCapSats: policy.absoluteFeeCapSats,
          feerateCapSatPerV: policy.feerateCapSatPerV,
        }))
      } catch (error) {
        publish({ error: humanizeVaultError(error) })
      }
    },
    finishPlan() {
      publish({ error: '' })
      if (!planReady(snapshot.setup)) {
        publish({ error: 'Finish setup first.' })
        return
      }
      transition('passkey-required')
    },
    applyLedgerRecovery(raw: string) {
      try {
        const { setup } = snapshot
        const network = snapshot.status?.network || snapshot.deployment?.network
        if (!setup.ledger || (network !== 'mainnet' && network !== 'mutinynet'))
          throw new Error('Connect your Savings Ledger first')
        const recovery = parseLedgerAccountOrigin(raw, network)
        const recoveryPub = ledgerSpendingPublicKey(recovery, network)
        if (sameRole(recoveryPub, setup.hardwarePub)) throw new Error('Recovery must use a different wallet')
        changePlan(() => ({
          ...setup,
          recoveryPub,
          protectionTier: 'advanced',
          ledger: { ...setup.ledger!, recovery },
        }))
        transition('conditions-required')
      } catch (error) {
        publish({ error: humanizeVaultError(error) })
      }
    },
    connectLedgerKey(role: 'hardware' | 'recovery') {
      const setup = structuredClone(snapshot.setup)
      const network = snapshot.status?.network || snapshot.deployment?.network
      return run(
        'ledger-key',
        async (signal) => {
          if (network !== 'mainnet' && network !== 'mutinynet') throw new Error('Vault network is not ready yet')
          if (
            snapshot.deployment?.ledgerSavingsCapability?.templateVersion !== LEDGER_NATIVE_TEMPLATE ||
            snapshot.deployment.ledgerSavingsCapability.version !== 1
          )
            throw new Error('Ledger Savings setup is not available on this deployment yet')
          const client = await import('./ledgerClient')
          signal.throwIfAborted()
          const session = await client.connectLedgerSavings()
          try {
            signal.throwIfAborted()
            const origin = await client.readLedgerSavingsAccount(session.app, network)
            signal.throwIfAborted()
            const key = ledgerSpendingPublicKey(origin, network)
            if (role === 'recovery') {
              if (!setup.ledger) throw new Error('Connect your Savings Ledger first')
              if (sameRole(key, setup.hardwarePub)) throw new Error('Recovery must use a different wallet')
              persistPlan({
                ...setup,
                recoveryPub: key,
                protectionTier: 'advanced',
                ledger: { ...setup.ledger, recovery: origin },
              })
              transition('conditions-required')
            } else {
              persistPlan({ ...setup, hardwarePub: key, recoveryPub: '', ledger: { hardware: origin } })
              transition(setup.protectionTier === 'advanced' ? 'recovery-required' : 'conditions-required')
            }
          } finally {
            await session.close().catch(() => undefined)
          }
        },
        JSON.stringify([role, setup, network]),
      )
    },
    enroll(token = '') {
      const setup = structuredClone(snapshot.setup)
      if (setup.protectionTier !== 'light' && !setup.ledger) {
        publish({ error: 'Connect a Ledger before creating protected Savings.' })
        transition('hardware-required')
        return Promise.resolve()
      }
      if (!planReady(setup)) {
        publish({ error: 'Finish setup first.' })
        return Promise.resolve()
      }
      return run(
        'enroll',
        async (signal) => {
          transition('enrolling')
          const roles = {
            protectionTier: setup.protectionTier,
            hardwarePub: setup.hardwarePub,
            ...(setup.recoveryPub ? { recoveryPub: setup.recoveryPub } : {}),
            ...(setup.ledger ? { ledger: setup.ledger } : {}),
            spendingPolicy: setupSpendingPolicy(setup),
          }
          if (setup.ledger) {
            const staged = loadStagedEnrollment()
            if (staged?.ledgerSavingsDraft) {
              remember(staged.vaultId)
              const context = staged.ledgerSavingsDraft.contract.context
              if (
                canonicalLedgerValue(context.hardware) !== canonicalLedgerValue(setup.ledger.hardware) ||
                canonicalLedgerValue(context.recovery) !== canonicalLedgerValue(setup.ledger.recovery) ||
                canonicalLedgerValue(staged.spendingPolicy) !== canonicalLedgerValue(roles.spendingPolicy)
              )
                throw new Error('Finish or cancel the Ledger setup already in progress.')
              if (staged.ledgerSavings && staged.inviteToken) {
                await acceptEnrollment(
                  await finishTenantEnrollment(staged.inviteToken, localStorage, signal),
                  setup,
                  signal,
                )
                return
              }
            } else {
              const result = await beginTenantEnrollment(token, roles, signal)
              remember(result.enrollment.vaultId)
            }
            signal.throwIfAborted()
            transition('registration-required')
            return
          }
          const staged = loadStagedEnrollment()
          if (
            staged &&
            (staged.protectionTier !== 'light' ||
              canonicalLedgerValue(staged.spendingPolicy) !== canonicalLedgerValue(roles.spendingPolicy))
          )
            throw new Error('Finish or cancel the setup already in progress.')
          const started = staged || (await beginTenantEnrollment(token, roles, signal)).enrollment
          remember(started.vaultId)
          signal.throwIfAborted()
          const saved = loadStagedEnrollment()
          await acceptEnrollment(
            await finishTenantEnrollment(saved?.inviteToken || token, localStorage, signal),
            setup,
            signal,
          )
        },
        JSON.stringify([token, setup]),
      )
    },
    cancelLedgerRegistration() {
      if (flight?.kind === 'register-ledger' && ['connecting', 'approving'].includes(snapshot.ledgerApprovalPhase))
        cancel()
    },
    approveLedgerEnrollment() {
      const setup = structuredClone(snapshot.setup)
      return run(
        'register-ledger',
        async (signal) => {
          const staged = loadStagedEnrollment()
          if (!staged?.ledgerSavingsDraft || staged.ledgerSavings)
            throw new Error('Reopen the saved Ledger setup before requesting approval.')
          remember(staged.vaultId)
          publish({ ledgerApprovalPhase: 'connecting' })
          let saving = false
          try {
            await approveLedgerRegistration(
              staged.ledgerSavingsDraft.contract,
              signal,
              () => publish({ ledgerApprovalPhase: 'approving' }),
              async (registration) => {
                signal.throwIfAborted()
                saving = true
                publish({ ledgerApprovalPhase: 'saving' })
                await acceptEnrollment(
                  await completeLedgerTenantEnrollment(registration, localStorage, signal),
                  setup,
                  signal,
                )
                signal.throwIfAborted()
                publish({ ledgerApprovalPhase: 'complete' })
              },
            )
          } catch (error) {
            if (!signal.aborted) publish({ ledgerApprovalPhase: saving ? 'check' : 'idle' })
            throw error
          }
        },
        'register-ledger',
        true,
      )
    },
    enableOtherDevices() {
      const enrollment = snapshot.enrollment
      if (!enrollment) {
        publish({ error: 'Finish setup first.' })
        return Promise.resolve()
      }
      return run('enable-passkey', async (signal) => {
        remember(enrollment.vaultId)
        const live = await enablePasskeyLogin(enrollment, signal)
        signal.throwIfAborted()
        acceptStatus(live)
      })
    },
    signIn() {
      return run('sign-in', async (signal) => {
        const setup = snapshot.setup
        const local = snapshot.enrollment || findStoredEnrollment()
        const localPin = local ? loadAddressPin(localStorage, local.vaultId) : null
        const renew: Parameters<typeof unlockLocalEnrollment>[1] = async (live, auth, canAuthorizeNew, record) => {
          signal.throwIfAborted()
          remember(live.vaultId)
          await renewFromLocalUnlock(live, record, auth, canAuthorizeNew, signal)
          signal.throwIfAborted()
        }
        let result: { enrollment: EnrollmentSecrets; status: VaultStatus }
        if (local) {
          remember(local.vaultId)
          result = localPin
            ? await unlockLocalEnrollment(local, renew, signal)
            : { enrollment: local, status: await enablePasskeyLogin(local, signal) }
        } else {
          const id = loadSelectedVaultId() || (await discoverVaultIdFromPasskey(signal))
          signal.throwIfAborted()
          remember(id)
          result = await signInWithPasskey(id, renew, signal)
        }
        signal.throwIfAborted()
        accept(result, 'authenticated')
        if (!localPin || result.status.templateVersion === LEDGER_NATIVE_TEMPLATE)
          await setupSpendingRenewals(result.status, result.enrollment, signal)
        signal.throwIfAborted()
        void restoreMap(result.enrollment, result.status, setup, signal)
      })
    },
    restoreRecoveryArchive(raw?: unknown) {
      raw = raw === undefined ? undefined : structuredClone(raw)
      if (snapshot.enrollment && !snapshot.locked)
        void teardown(false, true).catch((error) => publish({ error: humanizeVaultError(error) }))
      return run(
        'restore',
        async (signal) => {
          let imported = false
          try {
            const restore: typeof restoreVaultRecoveryFile = async (file, phone, seed) => {
              signal.throwIfAborted()
              remember(file.header.binding.vaultId)
              return restoreVaultRecoveryFile(file, phone, seed, signal)
            }
            const file =
              raw === undefined
                ? (await openRecoveryCloudBackup(undefined, restore)).file
                : await openLocalRecoveryBackup(raw, restore)
            if (!file) throw new Error('No complete encrypted recovery archive was found')
            imported = true
            signal.throwIfAborted()
            const live = await fetchVaultStatus(signal, file.header.binding.vaultId)
            signal.throwIfAborted()
            accept({ enrollment: file.header.enrollment, status: live }, 'authenticated')
            await setupSpendingRenewals(live, file.header.enrollment, signal)
            signal.throwIfAborted()
          } catch (error) {
            if (imported && !signal.aborted)
              publish({ error: 'Recovery data is saved on this device. Live balances could not be loaded.' })
            throw error
          }
        },
        raw === undefined ? 'cloud' : JSON.stringify(raw),
        true,
      )
    },
  }
}

export type VaultSession = ReturnType<typeof createVaultSession>
