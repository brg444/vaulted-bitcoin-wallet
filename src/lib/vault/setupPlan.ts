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
import { validateLedgerSetup, ledgerSpendingPublicKey, type VaultSetupLedger } from './ledgerSetup'

export const SETUP_STORE_KEY = 'arkade-vault-v2:setup'

// Scalars 1 and 2 are public knowledge and must never be accepted as user keys.
export const FORBIDDEN_PUBLIC_KEY_G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
export const FORBIDDEN_PUBLIC_KEY_2G = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'

export interface VaultSetupPlan {
  ledger?: VaultSetupLedger
  protectionTier: ProtectionTier
  hardwarePub: string
  recoveryPub: string
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
  if (!plan.acceptedDesign || Object.hasOwn(plan, 'connector')) return false
  if (plan.protectionTier === 'light') {
    if (plan.hardwarePub || plan.recoveryPub || plan.ledger) return false
  } else if (!plan.hardwarePub || !plan.ledger) return false
  if (plan.recoveryPub && sameRole(plan.hardwarePub, plan.recoveryPub)) return false
  try {
    if (plan.ledger) {
      const network = requireReleaseNetwork(plan.ledger.hardware.path[1] === 0x80000000 ? 'mainnet' : 'mutinynet')
      const ledger = validateLedgerSetup(plan.ledger, network)
      if (
        ledgerSpendingPublicKey(ledger.hardware, network) !== plan.hardwarePub ||
        (ledger.recovery ? ledgerSpendingPublicKey(ledger.recovery, network) : '') !== plan.recoveryPub
      )
        return false
    }
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.hasOwn(parsed, 'connector')) return null
  if (
    (parsed.protectionTier !== 'light' &&
      parsed.protectionTier !== 'standard' &&
      parsed.protectionTier !== 'advanced') ||
    !Number.isSafeInteger(parsed.txCapSats) ||
    !Number.isSafeInteger(parsed.dailyLimitSats) ||
    !Number.isSafeInteger(parsed.absoluteFeeCapSats) ||
    !Number.isSafeInteger(parsed.feerateCapSatPerV)
  ) {
    return null
  }
  if (parsed.protectionTier === 'light' && (parsed.hardwarePub || parsed.recoveryPub || parsed.ledger)) return null
  if (parsed.hardwarePub && !parsed.ledger) return null
  let ledger: VaultSetupLedger | undefined
  if (parsed.ledger) {
    try {
      const network = requireReleaseNetwork(parsed.ledger.hardware.path[1] === 0x80000000 ? 'mainnet' : 'mutinynet')
      ledger = validateLedgerSetup(parsed.ledger, network)
      if (
        ledgerSpendingPublicKey(ledger.hardware, network) !== parsed.hardwarePub ||
        (ledger.recovery ? ledgerSpendingPublicKey(ledger.recovery, network) : '') !== parsed.recoveryPub
      )
        return null
    } catch {
      return null
    }
  }
  return {
    protectionTier: requireProtectionTier(parsed.protectionTier),
    hardwarePub: String(parsed.hardwarePub || ''),
    recoveryPub: String(parsed.recoveryPub || ''),
    ...(ledger ? { ledger } : {}),
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
