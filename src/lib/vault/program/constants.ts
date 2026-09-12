export const PROGRAM_CSV = {
  hardware: 6,
  phone: 144,
  recovery: 288,
} as const

/** RBF-enabled input sequence for Ledger recovery transitions. */
export const TRANSITION_SEQUENCE = 0xfffffffd

export const CLAIMANTS = ['phone', 'hardware', 'recovery'] as const
export type Claimant = (typeof CLAIMANTS)[number]

export const FAMILY_KEYS = ['savings-phone', 'savings-hardware', 'savings-recovery'] as const
export type FamilyKey = (typeof FAMILY_KEYS)[number]

export function familyClaimants(hasRecovery: boolean): Claimant[] {
  return hasRecovery ? ['phone', 'hardware', 'recovery'] : ['phone', 'hardware']
}

export function familyKeysFor(hasRecovery: boolean): FamilyKey[] {
  return familyClaimants(hasRecovery).map((claimant) => `savings-${claimant}` as FamilyKey)
}
