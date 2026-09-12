import { describe, expect, it } from 'vitest'
import {
  accessMode,
  assertRecoveryBindingMatchesStatus,
  parseRecoveryBinding,
  recordFromRecoveryBinding,
  recoveryBindingDigest,
} from './passkeyBinding'
import { sharedSpendingStatus, sharedSpendingEnrollment } from './vtxo/testdata/sharedSpending'

const STATUS = sharedSpendingStatus()
const enrollment = sharedSpendingEnrollment()
const SPENDING_BINDING = {
  version: 4,
  credentialId: enrollment.credId,
  webauthnP256: enrollment.webauthnP256,
  phoneDirectP256: STATUS.phoneDirectP256 ?? '',
  phoneBip340Pub: STATUS.phoneBip340Pub ?? '',
  externalOwnerWalletPub: STATUS.externalOwnerWalletPub ?? '',
  vaultCosignerBasePub: STATUS.vaultCosignerBasePub ?? '',
  arkadeCosignerBasePub: STATUS.arkadeCosignerBasePub ?? '',
  arkadeCosignerOrigin: STATUS.arkadeCosignerOrigin ?? '',
  arkadeCosignerVersion: STATUS.arkadeCosignerVersion ?? '',
  clientOrigin: STATUS.clientOrigin ?? '',
  rpId: STATUS.rpId ?? '',
  network: STATUS.network ?? '',
  vaultId: STATUS.vaultId ?? '',
  templateVersion: STATUS.templateVersion ?? '',
  policyVersion: STATUS.policyVersion ?? '',
  protectionTier: STATUS.protectionTier ?? '',
  savingsAddress: STATUS.savingsAddress ?? '',
  savingsScript: STATUS.savingsScript ?? '',
  vtxoVaultCosignerPub: STATUS.vtxoVaultCosignerPub ?? '',
  vtxoExitDelay: STATUS.vtxoExitDelay ?? '',
  vtxoExitDelayUnit: STATUS.vtxoExitDelayUnit ?? '',
  spendingArkAddress: STATUS.spendingArkAddress ?? '',
  spendingArkScript: STATUS.spendingArkScript ?? '',
  vtxoDelegatePub: STATUS.vtxoDelegatePub ?? '',
  vtxoBoardingActive: STATUS.vtxoBoardingActive ?? '',
  vtxoBoardingProgram: STATUS.vtxoBoardingProgram ?? '',
  vtxoBoardingAddress: STATUS.vtxoBoardingAddress ?? '',
  vtxoBoardingScript: STATUS.vtxoBoardingScript ?? '',
  vtxoBoardingExitDelay: STATUS.vtxoBoardingExitDelay ?? '',
  vtxoBoardingExitDelayUnit: STATUS.vtxoBoardingExitDelayUnit ?? '',
  recipientDustSats: 330,
  txRecipientCapSats: STATUS.txCap,
  periodAllowanceSats: STATUS.periodAllowance,
  absoluteFeeCapSats: STATUS.absoluteFeeCap,
  feerateCapSatVb: STATUS.feerateCapSatVb,
  envelopeNonce: 'cc'.repeat(12),
  envelopeCiphertext: 'dd'.repeat(48),
}

describe('vault access mode', () => {
  it('sends an enrolled visitor without local secrets to sign-in', () => {
    expect(accessMode({ enrolled: true, passkeyLoginAvailable: true }, { hasLocal: false })).toBe('signin')
  })

  it('asks the original device to enable recovery before other devices can sign in', () => {
    expect(accessMode({ enrolled: true, passkeyLoginAvailable: false }, { hasLocal: true })).toBe('enable')
  })

  it('keeps setup for an unenrolled deployment', () => {
    expect(accessMode({ enrolled: false, enrollmentMode: 'token' })).toBe('setup')
  })
})

describe('shared Spending recovery binding', () => {
  it.each([
    [4, 'vaulted-light-v1'],
    [4, 'phone-hww-recovery-savings-v1'],
    [5, 'phone-connector-recovery-savings-v1'],
    [5, 'phone-connector-recovery-savings-v2'],
    [4, 'phone-ledger-guardian-savings-v1'],
    [6, 'vaulted-spending-v1'],
  ])('rejects retired or mismatched binding %s/%s', (version, templateVersion) => {
    const binding = { ...SPENDING_BINDING, version, templateVersion }
    expect(() => parseRecoveryBinding(JSON.stringify(binding))).toThrow(/binding (version|program)/)
    expect(() => assertRecoveryBindingMatchesStatus(binding, STATUS)).toThrow(/binding (version|program)/)
    expect(() => recordFromRecoveryBinding(binding)).toThrow(/binding (version|program)/)
  })

  it('has no connector binding digest domain', () => {
    expect(() => recoveryBindingDigest(JSON.stringify({ version: 5 }))).toThrow('recovery binding version')
  })

  it('accepts the canonical v4 fields and exact tier, Spending, and boarding status', () => {
    expect(parseRecoveryBinding(JSON.stringify(SPENDING_BINDING))).toEqual(SPENDING_BINDING)
    expect(assertRecoveryBindingMatchesStatus(JSON.stringify(SPENDING_BINDING), STATUS)).toEqual(SPENDING_BINDING)
  })

  it('rejects retired fields and pre-v4 bindings', () => {
    expect(() =>
      parseRecoveryBinding(JSON.stringify({ ...SPENDING_BINDING, operationalAddress: 'tb1pretired' })),
    ).toThrow(/fields or order/)
    expect(() => parseRecoveryBinding(JSON.stringify({ ...SPENDING_BINDING, version: 3 }))).toThrow(/version/)
  })

  it.each([
    'vtxoVaultCosignerPub',
    'vtxoExitDelay',
    'vtxoExitDelayUnit',
    'spendingArkAddress',
    'spendingArkScript',
    'vtxoDelegatePub',
    'vtxoBoardingActive',
    'vtxoBoardingProgram',
    'vtxoBoardingAddress',
    'vtxoBoardingScript',
    'vtxoBoardingExitDelay',
    'vtxoBoardingExitDelayUnit',
    'protectionTier',
  ] as const)('rejects a recovery binding whose %s differs from status', (field) => {
    expect(() =>
      assertRecoveryBindingMatchesStatus(JSON.stringify(SPENDING_BINDING), { ...STATUS, [field]: 'mutated' }),
    ).toThrow(new RegExp(`recovery binding ${field} does not match vault status`))
  })
})
