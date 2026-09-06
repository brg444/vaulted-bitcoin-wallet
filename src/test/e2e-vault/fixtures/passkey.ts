import { expect, test as base, type BrowserContext, type CDPSession, type Page, type Route } from '@playwright/test'
import { ArkAddress, createBoardingProgramScript, getNetwork } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { buildVaultProgramDescriptor } from '../../../lib/vault/program/descriptor'
import { hashBoardingEnrollmentDescriptor } from '../../../lib/vault/program/enroll'
import { PROGRAM_FIXTURE } from '../../../lib/vault/program/fixtures'
import { recoveryBindingDigest } from '../../../lib/vault/passkeyBinding'
import { bytesToHex } from '../../../lib/vault/hex'
import { POLICY_VERSION } from '../../../lib/vault/constants'
import {
  CURRENT_SPENDING_POLICY_CAPABILITIES,
  defaultSpendingPolicy,
  spendingPolicyDigest,
  type SpendingPolicy,
  validateSpendingPolicy,
} from '../../../lib/vault/spendingPolicy'
import { SAVINGS_TEMPLATE } from '../../../lib/vault/program/constants'
import type {
  VaultEnrollStartResponse,
  VaultMutationSuccess,
  VaultPasskeyChallengeResponse,
} from '../../../lib/vault/cosignerClient'
import type { BoardingDescriptor, VaultStatus } from '../../../lib/vault/types'
import {
  VAULT_POLICY_V1_EXIT_DELAY,
  VAULT_POLICY_V1_EXIT_DELAY_UNIT,
  VAULT_POLICY_V1_PINNED_DELEGATE,
  VaultPolicyV1Script,
} from '../../../lib/vault/vtxo/script'
import {
  BOARDING_EXIT_DELAY,
  BOARDING_EXIT_DELAY_UNIT,
  BOARDING_PROGRAM,
  BOARDING_SCHEMA,
  BOARDING_TEMPLATE,
  MUTINYNET_OPERATOR_SIGNER_PUB,
} from '../../../lib/vault/vtxo/board'

const APP_PORT = process.env.VAULT_E2E_PORT || '3003'
const OPERATOR_PORT = process.env.VAULT_E2E_OPERATOR_PORT || '18888'
const ORIGIN = `${process.env.HTTPS === 'true' ? 'https' : 'http'}://localhost:${APP_PORT}`
const RP_ID = 'localhost'
const INVITE = 'e2e-passkey-invite-0000000000000000'
const VAULT_ID = PROGRAM_FIXTURE.vaultId
const AUTHORIZER_CONTROL = `http://127.0.0.1:${OPERATOR_PORT}/__vault_e2e_authorizer`

type CDPCredential = {
  credentialId: string
  isResidentCredential: boolean
  rpId?: string
  privateKey: string
  signCount: number
  userHandle?: string
}

type AuthenticatorOptions = {
  protocol: 'ctap2'
  ctap2Version: 'ctap2_1'
  transport: 'internal'
  hasResidentKey: true
  hasUserVerification: true
  hasPrf: true
  isUserVerified: true
  automaticPresenceSimulation: boolean
}

export type VirtualPasskey = {
  abortNextRequest(): Promise<void>
  credentials(): Promise<CDPCredential[]>
  setPresence(enabled: boolean): Promise<void>
}

type PasskeyInstall = {
  binding: string
  bindingDigest: string
  envelopeNonce: string
  envelopeCiphertext: string
  bindingDirectSig: string
  bindingPhoneSig: string
}

export type FakePasskeyAuthorizer = {
  setInviteOnly(enabled: boolean): void
  readonly invite: string
  readonly vaultId: string
  broadcastedTransaction(): string
  clearRecoverGate(): void
  fundSavings(value: number): void
  rejectNextRecoveryAsWrongCredential(): void
  releaseRecover(): void
  selectedSpendingPolicy(): SpendingPolicy | undefined
  waitForRecover(): Promise<void>
}

type SecretAuditSnapshot = {
  generated32: string[]
  hkdfInputs: string[]
  hkdfOutputs: string[]
  serviceWorkerMessages: unknown[]
}

export type SecretAudit = {
  assertNoSecretsPersisted(page: Page): Promise<void>
  snapshot(page: Page): Promise<SecretAuditSnapshot>
}

type Fixtures = {
  authorizer: FakePasskeyAuthorizer
  passkey: VirtualPasskey
  secretAudit: SecretAudit
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function publicStatus() {
  return {
    network: 'mutinynet',
    clientOrigin: ORIGIN,
    rpId: RP_ID,
    templateVersion: SAVINGS_TEMPLATE,
    policyVersion: POLICY_VERSION,
    enrollmentMode: 'token',
    spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
    vtxoBoardingProgram: BOARDING_PROGRAM,
  }
}

function xonly(compressed: string): Uint8Array {
  return hex.decode(compressed).subarray(1)
}

class FakeAuthorizer implements FakePasskeyAuthorizer {
  readonly invite = INVITE
  readonly vaultId = VAULT_ID

  private inviteOnly = true
  setInviteOnly(enabled: boolean) {
    this.inviteOnly = enabled
  }

  private enrolled = false
  private passkeyLoginAvailable = false
  private proposed?: Record<string, any>
  private pendingPolicy?: SpendingPolicy
  private pendingProtectionTier?: 'standard' | 'advanced'
  private descriptor?: ReturnType<typeof buildVaultProgramDescriptor>
  private boardingDescriptor?: BoardingDescriptor
  private boardingDescriptorHash?: string
  private install?: PasskeyInstall
  private challengeCounter = 0
  private recoverGate?: { promise: Promise<void>; release: () => void }
  private recoverSeen?: { promise: Promise<void>; resolve: () => void }
  private wrongRecovery = false
  private savingsUtxos: Record<string, unknown>[] = []
  private broadcastHex = ''

  constructor(private readonly page: Page) {}

  async installRoutes() {
    await this.page.route('**/v1/**', async (route) => this.handle(route))
    await this.page.route('**/esplora/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.endsWith('/blocks/tip/height')) return route.fulfill({ status: 200, body: '1' })
      if (url.pathname.endsWith('/tx') && request.method() === 'POST') {
        this.broadcastHex = request.postData() || ''
        return route.fulfill({ status: 200, body: Transaction.fromRaw(hex.decode(this.broadcastHex)).id })
      }
      const addressUtxos = url.pathname.match(/\/address\/([^/]+)\/utxo$/)
      if (addressUtxos) {
        const address = decodeURIComponent(addressUtxos[1])
        return json(route, address === this.status().savingsAddress ? this.savingsUtxos : [])
      }
      if (/\/address\/[^/]+\/txs(?:\/chain\/[^/]+)?$/.test(url.pathname)) return json(route, [])
      if (/\/tx\/[0-9a-f]+\/status$/.test(url.pathname)) return json(route, { confirmed: false })
      if (/\/tx\/[0-9a-f]+\/outspends$/.test(url.pathname)) return json(route, [])
      return json(route, { error: 'not found' }, 404)
    })
  }

  broadcastedTransaction() {
    return this.broadcastHex
  }

  clearRecoverGate() {
    let release: () => void = () => undefined
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    this.recoverGate = { promise, release }
    let seen: () => void = () => undefined
    const seenPromise = new Promise<void>((resolve) => {
      seen = resolve
    })
    this.recoverSeen = { promise: seenPromise, resolve: seen }
  }

  fundSavings(value: number) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Savings fixture value must be positive sats')
    this.savingsUtxos = [
      {
        txid: '77'.repeat(32),
        vout: 0,
        value,
        status: { confirmed: true, block_height: 1 },
      },
    ]
  }

  releaseRecover() {
    this.recoverGate?.release()
    this.recoverGate = undefined
  }

  rejectNextRecoveryAsWrongCredential() {
    this.wrongRecovery = true
  }

  async waitForRecover() {
    if (!this.recoverSeen) throw new Error('recover gate was not installed')
    await this.recoverSeen.promise
  }

  selectedSpendingPolicy() {
    return this.proposed?.spendingPolicy ? validateSpendingPolicy(this.proposed.spendingPolicy) : undefined
  }

  private status(vaultId = VAULT_ID): VaultStatus {
    const proposed = this.proposed
    const descriptor = this.descriptor
    const spendingPolicy = proposed?.spendingPolicy
      ? validateSpendingPolicy(proposed.spendingPolicy)
      : defaultSpendingPolicy()
    const spending = descriptor
      ? new VaultPolicyV1Script({
          userPub: xonly(descriptor.keys.phoneBip340),
          vtxoVaultCosignerPub: xonly(descriptor.keys.vaultCosignerBase),
          arkdServerPub: xonly(MUTINYNET_OPERATOR_SIGNER_PUB),
          delegatePub: xonly(VAULT_POLICY_V1_PINNED_DELEGATE),
          exitDelay: VAULT_POLICY_V1_EXIT_DELAY,
          exitDelayUnit: VAULT_POLICY_V1_EXIT_DELAY_UNIT,
          exitDevicePub: xonly(descriptor.keys.phoneBip340),
          exitHardwarePub: xonly(descriptor.keys.hardware),
          ...(descriptor.keys.recovery ? { exitRecoveryPub: xonly(descriptor.keys.recovery) } : {}),
        })
      : undefined
    return {
      enrolled: this.enrolled,
      network: 'mutinynet',
      clientOrigin: ORIGIN,
      rpId: RP_ID,
      vaultId,
      templateVersion: SAVINGS_TEMPLATE,
      policyVersion: POLICY_VERSION,
      protectionTier: (proposed?.protectionTier as 'standard' | 'advanced') || 'standard',
      externalOwnerWalletPub: descriptor?.keys.hardware || PROGRAM_FIXTURE.hardwarePub,
      vaultCosignerBasePub: PROGRAM_FIXTURE.vaultCosignerBase,
      arkadeCosignerBasePub: PROGRAM_FIXTURE.arkadeCosignerBase,
      arkadeCosignerOrigin: PROGRAM_FIXTURE.arkadeCosigner.origin,
      arkadeCosignerVersion: PROGRAM_FIXTURE.arkadeCosigner.version,
      savingsAddress: descriptor?.savings.address || 'tb1psavings',
      savingsScript: descriptor?.savings.script || `5120${'11'.repeat(32)}`,
      periodAllowance: spendingPolicy.periodAllowanceSats,
      periodSpent: 0,
      periodRemaining: spendingPolicy.periodAllowanceSats,
      txCap: spendingPolicy.txRecipientCapSats,
      absoluteFeeCap: spendingPolicy.absoluteFeeCapSats,
      feerateCapSatVb: spendingPolicy.feerateCapSatPerV,
      spendingPolicy,
      spendingPolicyDigest: spendingPolicyDigest(spendingPolicy),
      phoneBip340Pub: proposed?.phoneBip340Pub,
      phoneDirectP256: proposed?.phoneDirectP256,
      ...(descriptor?.keys.recovery
        ? { recoveryPub: descriptor.keys.recovery, recoveryKeyPub: descriptor.keys.recovery }
        : {}),
      passkeyLoginAvailable: this.passkeyLoginAvailable,
      enrollmentMode: this.enrolled ? 'closed' : 'token',
      vtxoVaultCosignerPub: PROGRAM_FIXTURE.vaultCosignerBase,
      vtxoExitDelay: Number(VAULT_POLICY_V1_EXIT_DELAY),
      vtxoExitDelayUnit: VAULT_POLICY_V1_EXIT_DELAY_UNIT,
      spendingArkAddress: spending
        ? new ArkAddress(xonly(MUTINYNET_OPERATOR_SIGNER_PUB), spending.tweakedPublicKey, 'tark').encode()
        : '',
      spendingArkScript: spending ? hex.encode(spending.pkScript) : '',
      vtxoDelegatePub: VAULT_POLICY_V1_PINNED_DELEGATE,
      vtxoBoardingActive: Boolean(this.enrolled && this.boardingDescriptor),
      vtxoBoardingProgram: BOARDING_PROGRAM,
      vtxoBoardingAddress: this.boardingDescriptor?.address || '',
      vtxoBoardingScript: this.boardingDescriptor?.script || '',
      vtxoBoardingExitDelay: 604_672,
      vtxoBoardingExitDelayUnit: 'seconds',
      vtxoBoardingDescriptor: this.boardingDescriptor,
      vtxoBoardingDescriptorHash: this.boardingDescriptorHash,
    }
  }

  private recoveryBinding(body: { envelopeNonce: string; envelopeCiphertext: string }) {
    if (!this.proposed) throw new Error('passkey was not proposed')
    const status = this.status()
    return JSON.stringify({
      version: 4,
      credentialId: this.proposed.credentialId,
      webauthnP256: this.proposed.webauthnP256,
      phoneDirectP256: status.phoneDirectP256,
      phoneBip340Pub: status.phoneBip340Pub,
      externalOwnerWalletPub: status.externalOwnerWalletPub,
      vaultCosignerBasePub: status.vaultCosignerBasePub,
      arkadeCosignerBasePub: status.arkadeCosignerBasePub,
      arkadeCosignerOrigin: status.arkadeCosignerOrigin,
      arkadeCosignerVersion: status.arkadeCosignerVersion,
      clientOrigin: status.clientOrigin,
      rpId: status.rpId,
      network: status.network,
      vaultId: status.vaultId,
      templateVersion: status.templateVersion,
      policyVersion: status.policyVersion,
      protectionTier: status.protectionTier,
      savingsAddress: status.savingsAddress,
      savingsScript: status.savingsScript,
      vtxoVaultCosignerPub: status.vtxoVaultCosignerPub,
      vtxoExitDelay: status.vtxoExitDelay,
      vtxoExitDelayUnit: status.vtxoExitDelayUnit,
      spendingArkAddress: status.spendingArkAddress,
      spendingArkScript: status.spendingArkScript,
      vtxoDelegatePub: status.vtxoDelegatePub,
      vtxoBoardingActive: status.vtxoBoardingActive,
      vtxoBoardingProgram: status.vtxoBoardingProgram,
      vtxoBoardingAddress: status.vtxoBoardingAddress,
      vtxoBoardingScript: status.vtxoBoardingScript,
      vtxoBoardingExitDelay: status.vtxoBoardingExitDelay,
      vtxoBoardingExitDelayUnit: status.vtxoBoardingExitDelayUnit,
      recipientDustSats: 330,
      txRecipientCapSats: status.txCap,
      periodAllowanceSats: status.periodAllowance,
      absoluteFeeCapSats: status.absoluteFeeCap,
      feerateCapSatVb: status.feerateCapSatVb,
      envelopeNonce: body.envelopeNonce,
      envelopeCiphertext: body.envelopeCiphertext,
    })
  }

  private async handle(route: Route) {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const body = request.method() === 'POST' ? ((await request.postDataJSON()) as Record<string, any>) : undefined

    if (path === '/v1/status' && request.method() === 'GET') {
      const requestedVault = url.searchParams.get('vault')
      return json(
        route,
        requestedVault
          ? this.status(requestedVault)
          : { ...publicStatus(), enrollmentMode: this.inviteOnly ? 'token' : 'open' },
      )
    }
    if (path === '/v1/enroll/session') {
      if (this.inviteOnly) return json(route, { error: 'invite required' }, 400)
      return json(route, { token: 'A'.repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString() })
    }
    if (path === '/v1/enroll/start') {
      const spendingPolicy = validateSpendingPolicy(body?.spendingPolicy)
      const selectedDigest = spendingPolicyDigest(spendingPolicy)
      if (body?.spendingPolicyDigest !== selectedDigest) {
        return json(route, { code: 'REJECTED', error: 'spending policy digest mismatch' }, 400)
      }
      this.pendingPolicy = spendingPolicy
      if (body?.protectionTier !== 'standard' && body?.protectionTier !== 'advanced') {
        return json(route, { code: 'REJECTED', error: 'protection tier required' }, 400)
      }
      this.pendingProtectionTier = body.protectionTier
      const response: VaultEnrollStartResponse = {
        handle: 'e2e-enrollment-handle',
        vaultId: VAULT_ID,
        challenge: '01'.repeat(32),
        rpId: RP_ID,
        rpName: 'Vaulted',
        userId: bytesToHex(new TextEncoder().encode(VAULT_ID)),
        userName: 'vault',
        timeoutMs: 300_000,
        protectionTier: body.protectionTier,
        spendingPolicy,
        spendingPolicyDigest: selectedDigest,
      }
      return json(route, response)
    }
    if (path === '/v1/enroll/propose' && body) {
      const proposedPolicy = validateSpendingPolicy(body.spendingPolicy)
      if (
        !this.pendingPolicy ||
        body.protectionTier !== this.pendingProtectionTier ||
        spendingPolicyDigest(proposedPolicy) !== spendingPolicyDigest(this.pendingPolicy) ||
        body.spendingPolicyDigest !== spendingPolicyDigest(this.pendingPolicy)
      ) {
        return json(route, { code: 'REJECTED', error: 'spending policy changed after enrollment start' }, 400)
      }
      if (!/^[0-9a-f]{64}$/.test(body.vaultBoardingBip340Pub)) {
        return json(route, { code: 'REJECTED', error: 'boarding key must be BIP340 x-only' }, 400)
      }
      this.proposed = body
      this.descriptor = buildVaultProgramDescriptor({
        vaultId: VAULT_ID,
        network: 'mutinynet',
        protectionTier: body.protectionTier,
        phonePub: body.phoneBip340Pub,
        hardwarePub: PROGRAM_FIXTURE.hardwarePub,
        ...(body.recoveryXOnly ? { recoveryPub: `02${body.recoveryXOnly}` } : {}),
        phoneDirectP256: body.phoneDirectP256,
        vaultCosignerBase: PROGRAM_FIXTURE.vaultCosignerBase,
        arkadeCosignerBase: PROGRAM_FIXTURE.arkadeCosignerBase,
        arkadeCosigner: PROGRAM_FIXTURE.arkadeCosigner,
        spendingPolicy: body.spendingPolicy as SpendingPolicy,
      })
      const boarding = createBoardingProgramScript(
        {
          name: BOARDING_PROGRAM,
          boardingPubKey: hex.decode(body.vaultBoardingBip340Pub),
          cosignerPubKey: hex.decode(PROGRAM_FIXTURE.vaultCosignerBase).slice(1),
          recoveryPubKey: hex.decode(body.phoneBip340Pub).slice(1),
        },
        hex.decode(MUTINYNET_OPERATOR_SIGNER_PUB).slice(1),
        { type: BOARDING_EXIT_DELAY_UNIT, value: BigInt(BOARDING_EXIT_DELAY) },
      )
      this.boardingDescriptor = {
        schema: BOARDING_SCHEMA,
        program: BOARDING_PROGRAM,
        template: BOARDING_TEMPLATE,
        network: 'mutinynet',
        boardingPub: `02${body.vaultBoardingBip340Pub}`,
        recoveryPhonePub: body.phoneBip340Pub,
        vaultBoardCosignerPub: PROGRAM_FIXTURE.vaultCosignerBase,
        operatorPub: MUTINYNET_OPERATOR_SIGNER_PUB,
        exitDelay: BOARDING_EXIT_DELAY,
        exitDelayUnit: BOARDING_EXIT_DELAY_UNIT,
        script: hex.encode(boarding.pkScript),
        address: boarding.onchainAddress(getNetwork('mutinynet')),
      }
      const composite = {
        schema: 'arkade-vault/enrollment-with-board-v1' as const,
        vaultId: VAULT_ID,
        savings: this.descriptor,
        boarding: this.boardingDescriptor,
      }
      this.boardingDescriptorHash = hashBoardingEnrollmentDescriptor(composite)
      return json(route, {
        vaultId: VAULT_ID,
        descriptorHash: this.boardingDescriptorHash,
        descriptor: composite,
      })
    }
    if (path === '/v1/enroll/finish') {
      this.enrolled = true
      const status = this.status()
      const response = await fetch(AUTHORIZER_CONTROL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(status),
      })
      if (!response.ok) throw new Error(`Authorizer fixture reset failed: ${response.status}`)
      return json(route, status)
    }
    if (path === '/v1/passkey/challenge') {
      this.challengeCounter += 1
      const response: VaultPasskeyChallengeResponse = {
        challengeId: `challenge-${this.challengeCounter}`,
        challenge: this.challengeCounter.toString(16).padStart(2, '0').repeat(32),
        allowCredentialId: body?.vaultId === VAULT_ID ? this.proposed?.credentialId || '' : '',
        expiresInSeconds: 120,
      }
      return json(route, response)
    }
    if (path === '/v1/passkey/binding' && body) {
      const binding = this.recoveryBinding({
        envelopeNonce: body.envelopeNonce,
        envelopeCiphertext: body.envelopeCiphertext,
      })
      return json(route, { binding, bindingDigest: bytesToHex(recoveryBindingDigest(binding)) })
    }
    if (path === '/v1/passkey/install' && body) {
      const binding = body.binding
      this.install = {
        binding,
        bindingDigest: bytesToHex(recoveryBindingDigest(binding)),
        envelopeNonce: body.envelopeNonce,
        envelopeCiphertext: body.envelopeCiphertext,
        bindingDirectSig: body.bindingDirectSig,
        bindingPhoneSig: body.bindingPhoneSig,
      }
      this.passkeyLoginAvailable = true
      const response: VaultMutationSuccess = { ok: true }
      return json(route, response)
    }
    if (path === '/v1/passkey/recover') {
      this.recoverSeen?.resolve()
      if (this.recoverGate) await this.recoverGate.promise
      if (!this.install) return json(route, { error: 'passkey sign-in has not been enabled' }, 409)
      if (this.wrongRecovery) {
        this.wrongRecovery = false
        const binding = JSON.stringify({ ...JSON.parse(this.install.binding), credentialId: 'ff'.repeat(32) })
        return json(route, {
          ...this.install,
          binding,
          bindingDigest: bytesToHex(recoveryBindingDigest(binding)),
        })
      }
      return json(route, this.install)
    }
    if (path === '/v1/map') return json(route, { error: 'not found' }, 404)
    return json(route, { error: 'not found' }, 404)
  }
}

async function addAuthenticator(cdp: CDPSession, presence: boolean): Promise<string> {
  const options: AuthenticatorOptions = {
    protocol: 'ctap2',
    ctap2Version: 'ctap2_1',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    hasPrf: true,
    isUserVerified: true,
    automaticPresenceSimulation: presence,
  }
  const result = await cdp.send('WebAuthn.addVirtualAuthenticator', { options })
  return result.authenticatorId
}

async function installSecretAudit(context: BrowserContext) {
  await context.addInitScript(() => {
    type Audit = SecretAuditSnapshot
    const audit: Audit = {
      generated32: [],
      hkdfInputs: [],
      hkdfOutputs: [],
      serviceWorkerMessages: [],
    }
    Object.defineProperty(globalThis, '__vaultSecretAudit', { value: audit, configurable: false })
    const toHex = (value: BufferSource) => {
      const bytes = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value)
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    }
    const random = crypto.getRandomValues.bind(crypto)
    crypto.getRandomValues = ((array: ArrayBufferView) => {
      const result = random(array)
      if (result?.byteLength === 32) audit.generated32.push(toHex(result as ArrayBufferView<ArrayBuffer>))
      return result
    }) as Crypto['getRandomValues']
    const importKey = crypto.subtle.importKey.bind(crypto.subtle)
    crypto.subtle.importKey = (async (...args: Parameters<SubtleCrypto['importKey']>) => {
      const algorithm = args[2]
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name
      if (name === 'HKDF' && !(args[1] instanceof CryptoKey)) audit.hkdfInputs.push(toHex(args[1] as BufferSource))
      return importKey(...args)
    }) as SubtleCrypto['importKey']
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle)
    crypto.subtle.deriveBits = (async (...args: Parameters<SubtleCrypto['deriveBits']>) => {
      const result = await deriveBits(...args)
      const algorithm = args[0]
      if ((typeof algorithm === 'string' ? algorithm : algorithm.name) === 'HKDF') {
        audit.hkdfOutputs.push(toHex(result))
      }
      return result
    }) as SubtleCrypto['deriveBits']
    const originalPostMessage = ServiceWorker.prototype.postMessage
    ServiceWorker.prototype.postMessage = function (
      message: unknown,
      options?: StructuredSerializeOptions | Transferable[],
    ) {
      try {
        audit.serviceWorkerMessages.push(structuredClone(message))
      } catch {
        audit.serviceWorkerMessages.push(String(message))
      }
      return originalPostMessage.call(this, message, options as never)
    }
  })
}

async function persistentBrowserState(page: Page) {
  return page.evaluate(async () => {
    const bytesToHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    const serializable = (value: unknown, seen = new WeakSet<object>()): unknown => {
      if (value instanceof ArrayBuffer) return bytesToHex(new Uint8Array(value))
      if (ArrayBuffer.isView(value)) {
        return bytesToHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      }
      if (Array.isArray(value)) return value.map((item) => serializable(item, seen))
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[circular]'
        seen.add(value)
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item, seen)]))
      }
      return value
    }
    const databases: Record<string, unknown> = {}
    if (indexedDB.databases) {
      for (const database of await indexedDB.databases()) {
        if (!database.name) continue
        const name = database.name
        databases[name] = await new Promise<Record<string, unknown[]>>((resolve) => {
          const request = indexedDB.open(name)
          request.onerror = () => resolve({})
          request.onsuccess = () => {
            const db = request.result
            const stores: Record<string, unknown[]> = {}
            const names = Array.from(db.objectStoreNames)
            if (!names.length) {
              db.close()
              resolve(stores)
              return
            }
            const transaction = db.transaction(names, 'readonly')
            for (const storeName of names) {
              const getAll = transaction.objectStore(storeName).getAll()
              getAll.onsuccess = () => {
                stores[storeName] = getAll.result.map((value) => serializable(value))
              }
            }
            transaction.oncomplete = () => {
              db.close()
              resolve(stores)
            }
            transaction.onerror = () => {
              db.close()
              resolve(stores)
            }
          }
        })
      }
    }
    const cacheState: Record<string, unknown[]> = {}
    for (const name of await window.caches.keys()) {
      const cache = await window.caches.open(name)
      cacheState[name] = await Promise.all(
        (await cache.keys()).map(async (request) => {
          const response = await cache.match(request)
          return {
            url: request.url,
            body: response ? bytesToHex(new Uint8Array(await response.arrayBuffer())) : '',
          }
        }),
      )
    }
    return {
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      databases,
      caches: cacheState,
    }
  })
}

export const test = base.extend<Fixtures>({
  secretAudit: async ({ context }, use) => {
    await installSecretAudit(context)
    await use({
      snapshot: (page) =>
        page.evaluate(
          () => (globalThis as typeof globalThis & { __vaultSecretAudit: SecretAuditSnapshot }).__vaultSecretAudit,
        ),
      assertNoSecretsPersisted: async (page) => {
        const audit = await page.evaluate(
          () => (globalThis as typeof globalThis & { __vaultSecretAudit: SecretAuditSnapshot }).__vaultSecretAudit,
        )
        const state = await persistentBrowserState(page)
        const allowedBoardingSecrets = new Set<string>()
        for (const [name, stores] of Object.entries(state.databases)) {
          if (!name.startsWith('arkade-vault-board-v1-key:')) continue
          const rows = (stores as Record<string, unknown[]>).key || []
          for (const row of rows) {
            const record = row as { secret?: unknown; state?: unknown }
            if (
              (record.state === 'staged' || record.state === 'active') &&
              typeof record.secret === 'string' &&
              /^[0-9a-f]{64}$/i.test(record.secret)
            ) {
              allowedBoardingSecrets.add(record.secret.toLowerCase())
            }
          }
        }
        expect(allowedBoardingSecrets.size).toBeLessThanOrEqual(1)
        const curveOrder = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
        const hkdfCandidates = audit.hkdfOutputs.map((value) => value.toLowerCase())
        for (const secret of allowedBoardingSecrets) {
          expect(
            hkdfCandidates.some((candidate) => {
              if (candidate === secret) return true
              const scalar = BigInt(`0x${candidate}`)
              return scalar > 0n && scalar < curveOrder
                ? (curveOrder - scalar).toString(16).padStart(64, '0') === secret
                : false
            }),
          ).toBe(true)
          expect(audit.hkdfInputs.map((value) => value.toLowerCase())).not.toContain(secret)
          expect(audit.generated32.map((value) => value.toLowerCase())).not.toContain(secret)
        }
        const persistent = JSON.stringify(state).toLowerCase()
        const messages = JSON.stringify(audit.serviceWorkerMessages).toLowerCase()
        const secrets = [...audit.generated32, ...audit.hkdfInputs, ...audit.hkdfOutputs].filter(
          (secret) => secret.length === 64 && !/^0+$/.test(secret),
        )
        expect(secrets.length).toBeGreaterThan(0)
        for (const secret of new Set(secrets)) {
          if (!allowedBoardingSecrets.has(secret.toLowerCase())) {
            expect(persistent).not.toContain(secret.toLowerCase())
          }
          expect(messages).not.toContain(secret.toLowerCase())
        }
        expect(messages).not.toMatch(/phone.?secret|phone.?scalar|private.?key|prf.?secret|session.?scalar/)
      },
    })
  },
  passkey: async ({ context, page }, use) => {
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    const authenticatorId = await addAuthenticator(cdp, true)
    const api: VirtualPasskey = {
      abortNextRequest: () =>
        page.evaluate(() => {
          const container = navigator.credentials
          const original = container.get.bind(container)
          Object.defineProperty(container, 'get', {
            configurable: true,
            value: async (...args: Parameters<CredentialsContainer['get']>) => {
              Object.defineProperty(container, 'get', { configurable: true, value: original })
              void args
              throw new DOMException('The operation was aborted.', 'AbortError')
            },
          })
        }),
      credentials: async () => {
        const result = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
        return result.credentials as CDPCredential[]
      },
      setPresence: async (enabled) => {
        await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
          authenticatorId,
          enabled,
        })
      },
    }
    await use(api)
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined)
    await cdp.detach()
  },
  authorizer: async ({ page }, use) => {
    const service = new FakeAuthorizer(page)
    await service.installRoutes()
    await use(service)
  },
})

export async function reachPasskeySetup(page: Page, inviteOnly = true) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Everyday spending/ })).toBeVisible()
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByTestId('hardware-pub').fill(PROGRAM_FIXTURE.hardwarePub)
  await page.getByRole('button', { name: 'Use this hardware key' }).click()
  await page.getByRole('button', { name: 'Continue with Standard' }).click()
  await page.getByRole('button', { name: 'Review setup' }).click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  if (inviteOnly) await expect(page.getByTestId('enrollment-token')).toBeVisible()
  else await expect(page.getByRole('button', { name: 'Create Vault' })).toBeEnabled()
}

export async function enrollVaultWithPasskey(page: Page, authorizer: FakePasskeyAuthorizer, inviteOnly = true) {
  await reachPasskeySetup(page, inviteOnly)
  if (inviteOnly) await page.getByTestId('enrollment-token').fill(authorizer.invite)
  await page.getByRole('button', { name: 'Create Vault' }).click()
  await expect(page.getByRole('heading', { name: 'Your Vault was created', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save Recovery Kit' }).click()
  await page.getByRole('button', { name: 'I’ll save a separate copy later' }).click()
  await page.getByRole('button', { name: 'Open your Vault' }).click()
  await expect(page.getByTestId('account-switcher')).toBeVisible()
}

export { expect }
