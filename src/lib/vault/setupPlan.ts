import { importConnectorOrigin } from './program/connectorOrigin'
import { requireReleaseNetwork } from './releaseNetwork'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  ABSOLUTE_FEE_CEILING_SATS,
  FEERATE_CEILING_SAT_PER_V,
  PERIOD_ALLOWANCE_SATS,
  TX_RECIPIENT_CAP_SATS,
} from './constants'
import { fingerprint, hexToBytes } from './hex'
import { requireProtectionTier, requireProtectionTierMatchesRecovery, type ProtectionTier } from './protectionTier'
import { spendingPolicyFromLimits, validateSpendingPolicy, type SpendingPolicy } from './spendingPolicy'

export const SETUP_STORE_KEY = 'arkade-vault-v2:setup'

// Scalars 1 and 2 are public knowledge and must never be accepted as user keys.
export const FORBIDDEN_PUBLIC_KEY_G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
export const FORBIDDEN_PUBLIC_KEY_2G = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'

export interface VaultSetupConnector {
  descriptor: string
  address: string
  selectedPath: string
  connectorPub: string
  connectorType: 'p2wpkh' | 'p2tr'
  connectorFingerprint: number
  connectorPath: number[]
}

export interface VaultSetupPlan {
  protectionTier: ProtectionTier
  hardwarePub: string
  recoveryPub: string
  connector?: VaultSetupConnector
  txCapSats: number
  dailyLimitSats: number
  absoluteFeeCapSats: number
  feerateCapSatPerV: number
  acceptedDesign: boolean
  complete: boolean
}

export function emptySetupPlan(): VaultSetupPlan {
  return {
    protectionTier: 'standard',
    hardwarePub: '',
    recoveryPub: '',
    txCapSats: TX_RECIPIENT_CAP_SATS,
    dailyLimitSats: PERIOD_ALLOWANCE_SATS,
    absoluteFeeCapSats: ABSOLUTE_FEE_CEILING_SATS,
    feerateCapSatPerV: FEERATE_CEILING_SAT_PER_V,
    acceptedDesign: false,
    complete: false,
  }
}

export function parseCompressedPub(raw: string, name = 'key'): string {
  const hex = raw.trim().toLowerCase().replace(/^0x/, '')
  if (!/^(02|03)[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`${name} must be a 33-byte compressed public key`)
  }
  if (!secp256k1.utils.isValidPublicKey(hexToBytes(hex), true)) {
    throw new Error(`${name} is not a valid secp256k1 public key`)
  }
  return hex
}

export function xOnly(pub: string): string {
  return parseCompressedPub(pub).slice(2)
}

function validSetupConnector(value: unknown): VaultSetupConnector | null {
  if (!value || typeof value !== 'object') return null
  const c = value as {
    descriptor?: unknown
    address?: unknown
    selectedPath?: unknown
    connectorPub?: unknown
    connectorType?: unknown
    connectorFingerprint?: unknown
    connectorPath?: unknown
  }
  const { descriptor, address, selectedPath, connectorPub, connectorType, connectorFingerprint, connectorPath } = c
  if (
    typeof descriptor !== 'string' ||
    typeof address !== 'string' ||
    typeof selectedPath !== 'string' ||
    typeof connectorPub !== 'string' ||
    (connectorType !== 'p2wpkh' && connectorType !== 'p2tr') ||
    typeof connectorFingerprint !== 'number' ||
    !Number.isInteger(connectorFingerprint) ||
    !Array.isArray(connectorPath)
  )
    return null
  try {
    const network = requireReleaseNetwork(address.startsWith('bc1') ? 'mainnet' : 'mutinynet')
    const imported = importConnectorOrigin(descriptor, network)
    if (
      connectorPub !== imported.publicKey ||
      connectorType !== imported.type ||
      connectorFingerprint !== imported.fingerprint ||
      connectorPath.length !== imported.path.length ||
      connectorPath.some((step, i) => step !== imported.path[i]) ||
      address !== imported.address ||
      selectedPath !== imported.selectedPath
    )
      return null
    return {
      descriptor,
      address: imported.address,
      selectedPath: imported.selectedPath,
      connectorPub: imported.publicKey,
      connectorType: imported.type,
      connectorFingerprint: imported.fingerprint,
      connectorPath: [...imported.path],
    }
  } catch {
    return null
  }
}

export function sameBip340Key(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  try {
    return xOnly(a) === xOnly(b)
  } catch {
    return false
  }
}

export function sameRole(a: string, b: string): boolean {
  return sameBip340Key(a, b)
}

export function planReady(plan: VaultSetupPlan): boolean {
  if (!plan.acceptedDesign) return false
  if (!plan.hardwarePub) return false
  if (plan.recoveryPub && sameRole(plan.hardwarePub, plan.recoveryPub)) return false
  try {
    requireProtectionTierMatchesRecovery(plan.protectionTier, plan.recoveryPub)
    validateSpendingPolicy(setupSpendingPolicy(plan))
  } catch {
    return false
  }
  return true
}

export function setupSpendingPolicy(plan: VaultSetupPlan): SpendingPolicy {
  return spendingPolicyFromLimits({
    txRecipientCapSats: plan.txCapSats,
    periodAllowanceSats: plan.dailyLimitSats,
    absoluteFeeCapSats: plan.absoluteFeeCapSats,
    feerateCapSatPerV: plan.feerateCapSatPerV,
  })
}

export function loadSetupPlan(storage: Storage = localStorage): VaultSetupPlan | null {
  const raw = storage.getItem(SETUP_STORE_KEY)
  if (!raw) return null
  let parsed: Partial<VaultSetupPlan>
  try {
    parsed = JSON.parse(raw) as Partial<VaultSetupPlan>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (
    (parsed.protectionTier !== 'standard' && parsed.protectionTier !== 'advanced') ||
    !Number.isSafeInteger(parsed.txCapSats) ||
    !Number.isSafeInteger(parsed.dailyLimitSats) ||
    !Number.isSafeInteger(parsed.absoluteFeeCapSats) ||
    !Number.isSafeInteger(parsed.feerateCapSatPerV)
  ) {
    return null
  }
  const connector = validSetupConnector(parsed.connector)
  if (Object.hasOwn(parsed, 'connector') && (!connector || parsed.hardwarePub !== connector.connectorPub)) return null
  return {
    protectionTier: requireProtectionTier(parsed.protectionTier),
    hardwarePub: String(parsed.hardwarePub || ''),
    recoveryPub: String(parsed.recoveryPub || ''),
    ...(connector ? { connector } : {}),
    txCapSats: Number(parsed.txCapSats),
    dailyLimitSats: Number(parsed.dailyLimitSats),
    absoluteFeeCapSats: Number(parsed.absoluteFeeCapSats),
    feerateCapSatPerV: Number(parsed.feerateCapSatPerV),
    acceptedDesign: parsed.acceptedDesign === true,
    complete: parsed.complete === true,
  }
}

export function saveSetupPlan(plan: VaultSetupPlan, storage: Storage = localStorage): VaultSetupPlan {
  storage.setItem(SETUP_STORE_KEY, JSON.stringify(plan))
  return plan
}

export function clearSetupPlan(storage: Storage = localStorage) {
  storage.removeItem(SETUP_STORE_KEY)
}

export function shortKey(pub: string): string {
  return pub ? fingerprint(pub, 4) : 'Not set'
}
