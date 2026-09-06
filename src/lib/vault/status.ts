import { LIGHT_PROFILE } from './light/contract'
import { requireLightStatus } from './light/status'
import { readBounded } from './bounded'
import { POLICY_VERSION } from './constants'
import { requireReleaseNetwork } from './releaseNetwork'
import { authorizerWalletHref, requireMainnetWalletOrigin, requireMainnetWalletRpId } from './productionDomains'
import { SAVINGS_TEMPLATE } from './program/constants'
import { bindStatusToLocalPin } from './pin'
import type { VaultStatus, VaultStatusWire } from './types'
import {
  requireCurrentSpendingPolicyCapabilities,
  spendingPolicyDigest,
  validateSpendingPolicy,
  type SpendingPolicyCapabilities,
} from './spendingPolicy'
import { requireProtectionTierMatchesRecovery } from './protectionTier'

export function authorizerBase(): string {
  // Production talks same-origin only. A VITE_ value is compiled into the
  // public bundle and is not a secret; CSP also blocks cross-origin connect.
  if (import.meta.env.PROD) return ''
  const configured = (import.meta.env.VITE_VAULT_API as string | undefined) || ''
  return configured.replace(/\/$/, '')
}

export type PublicAuthorizerStatus = {
  supportedSetups?: ('light' | 'standard' | 'advanced')[]
  network: string
  clientOrigin: string
  rpId: string
  templateVersion: string
  policyVersion: string
  enrollmentMode: string
  enrollmentExpiresAt?: string
  vtxoBoardingProgram?: string
  spendingPolicyCapabilities: SpendingPolicyCapabilities
}

export type VaultReadyStatus = {
  ok: boolean
  schema: number
  network: string
  enrollTemplate: string
  arkadeOrigin: string
  arkadeVersion: string
  error?: string
}

export type VaultServiceReadiness =
  | { state: 'ready'; status: VaultReadyStatus }
  | { state: 'unavailable'; status: VaultReadyStatus }

export class VaultReadinessResponseError extends Error {
  constructor(message = 'invalid readiness response') {
    super(message)
    this.name = 'VaultReadinessResponseError'
  }
}

function requestedVaultId(expectedVaultId: string): string {
  const id = String(expectedVaultId || '').trim()
  if (!id) throw new Error('vault id required')
  return id
}

export function vaultStatusPath(expectedVaultId: string): string {
  const id = requestedVaultId(expectedVaultId)
  return `/v1/status?vault=${encodeURIComponent(id)}`
}

function parseJsonObject<T>(raw: string, label: string): T {
  let body: T
  try {
    body = JSON.parse(raw) as T
  } catch {
    throw new Error(`${label} is not JSON`)
  }
  if (!body || typeof body !== 'object') throw new Error(`${label} is not an object`)
  return body
}

export async function fetchPublicStatus(signal?: AbortSignal): Promise<PublicAuthorizerStatus> {
  const base = authorizerBase()
  const res = await fetch(`${base}/v1/status`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  const text = await readBounded(res)
  if (!res.ok) {
    throw new Error(`authorizer status ${res.status}`)
  }
  const body = parseJsonObject<PublicAuthorizerStatus>(text, 'status')
  if ('vaultId' in body && body.vaultId) throw new Error('public status must not name a vault')
  const network = requireReleaseNetwork(body.network)
  if (network === 'mainnet' && import.meta.env.PROD) {
    requireMainnetWalletOrigin(body.clientOrigin)
    requireMainnetWalletRpId(body.rpId)
    if (typeof location !== 'undefined' && location.origin) {
      requireMainnetWalletOrigin(location.origin)
      const signingHref = authorizerWalletHref(body.clientOrigin, location.href)
      if (signingHref) {
        location.replace(signingHref)
        throw new Error('Open this vault from its signing address.')
      }
    }
  }
  if (body.templateVersion !== SAVINGS_TEMPLATE) throw new Error('template version is not this release')
  if (body.policyVersion !== POLICY_VERSION) throw new Error('policy version is not this release')
  body.spendingPolicyCapabilities = requireCurrentSpendingPolicyCapabilities(body.spendingPolicyCapabilities)
  return body
}

export async function pingVaultService(signal?: AbortSignal): Promise<boolean> {
  try {
    await fetchPublicStatus(signal)
    return true
  } catch {
    return false
  }
}

function requireReadyStatus(value: unknown): VaultReadyStatus {
  if (!value || typeof value !== 'object') throw new VaultReadinessResponseError()
  const status = value as Partial<VaultReadyStatus>
  if (
    typeof status.ok !== 'boolean' ||
    !Number.isInteger(status.schema) ||
    Number(status.schema) < 0 ||
    typeof status.network !== 'string' ||
    typeof status.enrollTemplate !== 'string' ||
    typeof status.arkadeOrigin !== 'string' ||
    typeof status.arkadeVersion !== 'string' ||
    (status.error !== undefined && typeof status.error !== 'string')
  ) {
    throw new VaultReadinessResponseError()
  }
  if (status.ok) {
    try {
      requireReleaseNetwork(status.network)
    } catch {
      throw new VaultReadinessResponseError('unsupported readiness network')
    }
    if (status.enrollTemplate !== SAVINGS_TEMPLATE) {
      throw new VaultReadinessResponseError('readiness template is not this release')
    }
    if (!status.arkadeOrigin || !status.arkadeVersion) {
      throw new VaultReadinessResponseError('readiness is missing its Arkade release pin')
    }
  }
  return status as VaultReadyStatus
}

export async function fetchVaultReadiness(signal?: AbortSignal, timeoutMs = 5_000): Promise<VaultServiceReadiness> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException('Readiness timed out', 'TimeoutError')),
    timeoutMs,
  )
  try {
    const response = await fetch(`${authorizerBase()}/ready`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    const raw = await readBounded(response)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new VaultReadinessResponseError()
    }
    const status = requireReadyStatus(parsed)
    return response.ok && status.ok ? { state: 'ready', status } : { state: 'unavailable', status }
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export async function fetchVaultStatus(signal: AbortSignal | undefined, expectedVaultId: string): Promise<VaultStatus> {
  return bindStatusToLocalPin(await fetchVaultStatusUnpinned(signal, expectedVaultId))
}

/** Worker-safe status read. Browser pinning remains a page/session concern. */
export async function fetchVaultStatusUnpinned(
  signal: AbortSignal | undefined,
  expectedVaultId: string,
): Promise<VaultStatus> {
  const base = authorizerBase()
  const id = requestedVaultId(expectedVaultId)
  const res = await fetch(`${base}${vaultStatusPath(id)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  const text = await readBounded(res)
  if (!res.ok) {
    throw new Error(`authorizer status ${res.status}`)
  }
  const body = requireStatusIdentity(parseJsonObject<VaultStatusWire & { recoveryPub?: string }>(text, 'status'), id)
  return body
}

export function parseStatusJson(raw: string, expectedVaultId: string): VaultStatus {
  const body = JSON.parse(raw) as VaultStatusWire & { recoveryPub?: string }
  return requireStatusIdentity(body, requestedVaultId(expectedVaultId))
}

// Bind the exact wire status to the selected vault and add the wallet-only
// recoveryPub compatibility alias without adding it to VaultStatusWire.
export function requireStatusIdentity(
  status: VaultStatusWire & { recoveryPub?: string },
  expectedVaultId: string,
): VaultStatus {
  const expected = requestedVaultId(expectedVaultId)
  if (!status || typeof status !== 'object') throw new Error('status is not an object')
  if (!status.vaultId || String(status.vaultId).trim() === '') throw new Error('vault id required')
  if (status.vaultId !== expected) throw new Error('status vault id does not match')
  requireReleaseNetwork(status.network)
  if (status.templateVersion === LIGHT_PROFILE) return requireLightStatus(status)
  if (status.templateVersion !== SAVINGS_TEMPLATE) throw new Error('template version is not this release')
  if (status.policyVersion !== POLICY_VERSION) throw new Error('policy version is not this release')
  const selected = validateSpendingPolicy(status.spendingPolicy)
  if (spendingPolicyDigest(selected) !== status.spendingPolicyDigest) {
    throw new Error('status spending policy digest does not match')
  }
  if (
    selected.txRecipientCapSats !== status.txCap ||
    selected.periodAllowanceSats !== status.periodAllowance ||
    selected.absoluteFeeCapSats !== status.absoluteFeeCap ||
    selected.feerateCapSatPerV !== status.feerateCapSatVb
  ) {
    throw new Error('status spending policy does not match limit fields')
  }
  if (status.enrolled && (!String(status.savingsAddress || '').trim() || !String(status.savingsScript || '').trim())) {
    throw new Error('enrolled status is missing the Savings descriptor')
  }
  const recoveryPub = String(status.recoveryPub || '').trim()
  const recoveryKeyPub = String(status.recoveryKeyPub || '').trim()
  if (recoveryPub && recoveryKeyPub && recoveryPub !== recoveryKeyPub) {
    throw new Error('status recovery key fields do not match')
  }
  const recovery = recoveryKeyPub || recoveryPub
  requireProtectionTierMatchesRecovery(status.protectionTier, recovery)
  return (recovery ? { ...status, recoveryPub: recovery, recoveryKeyPub: recovery } : status) as VaultStatus
}
