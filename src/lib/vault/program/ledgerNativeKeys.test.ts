import { describe, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import vectors from './ledger-key-vectors.json'
import {
  ledgerAccountKey,
  ledgerBip32Versions,
  ledgerSavingsGuardianParent,
  ledgerGuardianInitiateBranch,
  ledgerGuardianClawbackBranch,
  ledgerGuardianInitiateChild,
  ledgerGuardianClawbackChild,
  LEDGER_NATIVE_TEMPLATE,
  ledgerSavingsChild,
  ledgerSavingsContextDigest,
  ledgerSavingsInternalParent,
  type LedgerSavingsKeyContext,
} from './ledgerNativeKeys'
import { compressedFromScalar, scalarSecret } from './fixtures'
import type { Claimant } from './constants'
import { buildLedgerNativeSavings } from './ledgerNativePolicy'

describe('Ledger native Savings derivation contract', () => {
  for (const vector of vectors)
    it(`matches shared ${vector.input.network} ${vector.input.recovery ? 'advanced' : 'standard'} vectors`, () => {
      const input = vector.input as LedgerSavingsKeyContext
      const normal = buildLedgerNativeSavings(input)
      expect(normal.walletPolicy).toEqual(vector.normal.walletPolicy)
      expect(normal.receive.address).toBe(vector.normal.receive.address)
      expect(hex.encode(normal.receive.script)).toBe(vector.normal.receive.script)
      expect(normal.change.address).toBe(vector.normal.change.address)
      expect(hex.encode(normal.change.script)).toBe(vector.normal.change.script)
      expect(hex.encode(ledgerSavingsContextDigest(input))).toBe(vector.contextDigest)
      const internal = ledgerSavingsInternalParent(input)
      expect(internal.publicExtendedKey).toBe(vector.internal.xpub)
      for (const branch of [0, 1])
        expect(hex.encode(ledgerSavingsChild(internal, branch).publicKey!)).toBe(vector.internal.children[branch])
      for (const role of ['phone', 'hardware', ...(input.recovery ? ['recovery'] : [])] as const) {
        const expected = vector.accounts[role as keyof typeof vector.accounts]!
        const account = ledgerAccountKey(input[role as 'phone' | 'hardware' | 'recovery']!, input.network)
        for (const branch of [0, 1, 2, 3])
          expect(hex.encode(ledgerSavingsChild(account, branch).publicKey!)).toBe(expected[branch])
      }
      const parent = ledgerSavingsGuardianParent(input)
      expect(parent.publicExtendedKey).toBe(vector.guardian.xpub)
      expect(hex.encode(parent.publicKey!)).toBe(input.vaultCosignerBase)
      expect(parent.depth).toBe(0)
      expect(parent.index).toBe(0)
      expect(parent.parentFingerprint).toBe(0)
      const privateParent = new HDKey({
        privateKey: scalarSecret(14),
        chainCode: parent.chainCode!,
        versions: ledgerBip32Versions(input.network),
      })
      for (const expected of vector.guardian.children) {
        const claimant = expected.claimant as Claimant
        const branch =
          expected.kind === 'initiate'
            ? ledgerGuardianInitiateBranch(input, claimant, expected.change as 0 | 1)
            : ledgerGuardianClawbackBranch(input, claimant, expected.guardian as Claimant)
        const child = (key: HDKey) =>
          expected.kind === 'initiate'
            ? ledgerGuardianInitiateChild(input, key, claimant, expected.change as 0 | 1)
            : ledgerGuardianClawbackChild(input, key, claimant, expected.guardian as Claimant)
        expect(branch).toBe(expected.branch)
        expect(hex.encode(child(parent).publicKey!)).toBe(expected.pubkey)
        expect(child(privateParent).publicKey).toEqual(child(parent).publicKey)
      }
    })

  const source = vectors[0].input as LedgerSavingsKeyContext
  it('separates vault, policy, origin and authentication bindings', () => {
    const original = hex.encode(ledgerSavingsContextDigest(source))
    const changes = [
      { ...source, vaultId: '11'.repeat(16) },
      { ...source, policyDigest: '22'.repeat(32) },
      { ...source, hardware: { ...source.hardware, fingerprint: '00000001' } },
      { ...source, vaultCosignerBase: compressedFromScalar(15) },
      { ...source, phoneDirectP256: `03${source.phoneDirectP256.slice(2)}` },
      { ...source, phone: source.hardware, hardware: source.phone },
    ]
    const guardian = ledgerSavingsGuardianParent(source).publicExtendedKey
    for (const input of changes) {
      expect(hex.encode(ledgerSavingsContextDigest(input))).not.toBe(original)
      expect(ledgerSavingsGuardianParent(input).publicExtendedKey).not.toBe(guardian)
    }
    expect(LEDGER_NATIVE_TEMPLATE).toBe('phone-ledger-guardian-savings-v1')
    expect(source).not.toHaveProperty('arkadeCosignerBase')
  })

  it('rejects unsupported coordinates and substituted account metadata', () => {
    const account = ledgerAccountKey(source.hardware, source.network)
    for (const [branch, index] of [
      [4, 0],
      [-1, 0],
      [0.5, 0],
      [0, 1],
      [0, 0x80000000],
    ]) {
      expect(() => ledgerSavingsChild(account, branch, index)).toThrow()
    }
    const invalid = [
      { ...source.hardware, fingerprint: source.hardware.fingerprint.toUpperCase() },
      { ...source.hardware, path: [0x80000054, ...source.hardware.path.slice(1)] },
      { ...source.hardware, path: [...source.hardware.path.slice(0, 2), 0x80000001] },
      { ...source.hardware, xpub: account.deriveChild(0).publicExtendedKey },
    ]
    for (const origin of invalid) expect(() => ledgerAccountKey(origin, source.network)).toThrow()
    expect(() => ledgerAccountKey(source.hardware, 'mainnet')).toThrow()
    const privateAccount = HDKey.fromMasterSeed(
      new Uint8Array(32).fill(0x42),
      ledgerBip32Versions(source.network),
    ).derive("m/86'/1'/0'")
    expect(() =>
      ledgerAccountKey({ ...source.hardware, xpub: privateAccount.privateExtendedKey }, source.network),
    ).toThrow()
  })

  it('rejects collapsed authorities, malformed context and unauthorized claimants', () => {
    expect(() => ledgerSavingsContextDigest({ ...source, phone: source.hardware })).toThrow()
    expect(() =>
      ledgerSavingsContextDigest({
        ...source,
        vaultCosignerBase: hex.encode(ledgerAccountKey(source.phone, source.network).publicKey!),
      }),
    ).toThrow()
    expect(() => ledgerSavingsContextDigest({ ...source, policyDigest: '' })).toThrow()
    expect(() => ledgerSavingsContextDigest({ ...source, vaultId: source.vaultId.toUpperCase() })).toThrow()
    expect(() => ledgerSavingsContextDigest({ ...source, phoneDirectP256: '00'.repeat(33) })).toThrow()
    expect(() => ledgerGuardianInitiateBranch(source, 'recovery', 0)).toThrow()
    expect(() => ledgerGuardianClawbackBranch(source, 'phone', 'recovery')).toThrow()
    expect(() => ledgerGuardianClawbackBranch(source, 'phone', 'phone')).toThrow()
    expect(() =>
      ledgerSavingsContextDigest({
        ...source,
        templateVersion: 'phone-ledger-recovery-savings-v1' as typeof LEDGER_NATIVE_TEMPLATE,
      }),
    ).toThrow()
  })

  it('wipes intermediate and rejected private children while retaining the caller parent', () => {
    for (const outcome of ['success', 'wrong-index', 'error'] as const) {
      const parent = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x42))
      const step = parent.deriveChild(0)
      const child = step.deriveChild(0)
      const parentSecret = parent.privateKey!.slice()
      const stepSecret = step.privateKey!
      const childSecret = child.privateKey!
      const parentDerive = vi.spyOn(parent, 'deriveChild').mockReturnValue(step)
      const stepDerive = vi.spyOn(step, 'deriveChild')
      if (outcome === 'error')
        stepDerive.mockImplementation(() => {
          throw new Error('derivation failure')
        })
      else stepDerive.mockReturnValue(child)
      if (outcome === 'wrong-index') Object.defineProperty(child, 'index', { value: 1 })
      try {
        if (outcome === 'success') {
          expect(ledgerSavingsChild(parent, 0)).toBe(child)
          expect(child.privateKey).not.toBeNull()
          expect(childSecret.some((value) => value !== 0)).toBe(true)
        } else {
          expect(() => ledgerSavingsChild(parent, 0)).toThrow()
          if (outcome === 'wrong-index') expect(childSecret.every((value) => value === 0)).toBe(true)
        }
        expect(step.privateKey).toBeNull()
        expect(stepSecret.every((value) => value === 0)).toBe(true)
        expect(parent.privateKey).toEqual(parentSecret)
      } finally {
        parentDerive.mockRestore()
        stepDerive.mockRestore()
        child.wipePrivateData()
        parent.wipePrivateData()
      }
    }
  })

  it('assigns disjoint Guardian branches and rejects substituted parents and coordinates', () => {
    const input = vectors[1].input as LedgerSavingsKeyContext
    const parent = ledgerSavingsGuardianParent(input)
    const expected = [
      ['phone', 'hardware', 6],
      ['phone', 'recovery', 8],
      ['hardware', 'phone', 10],
      ['hardware', 'recovery', 12],
      ['recovery', 'phone', 14],
      ['recovery', 'hardware', 16],
    ] as const
    for (const [claimant, guardian, branch] of expected)
      expect(ledgerGuardianClawbackBranch(input, claimant, guardian)).toBe(branch)
    for (const [claimant, branch] of [
      ['phone', 0],
      ['hardware', 2],
      ['recovery', 4],
    ] as const) {
      expect(ledgerGuardianInitiateBranch(input, claimant, 0)).toBe(branch)
      expect(ledgerGuardianInitiateBranch(input, claimant, 1)).toBe(branch + 1)
    }
    expect(() => ledgerGuardianInitiateBranch(input, 'phone', 2 as 0)).toThrow()
    expect(() => ledgerGuardianInitiateBranch(input, 'other' as Claimant, 0)).toThrow()
    const substituted = new HDKey({
      publicKey: parent.publicKey!,
      chainCode: new Uint8Array(32),
      versions: ledgerBip32Versions(input.network),
    })
    expect(() => ledgerGuardianInitiateChild(input, substituted, 'phone', 0)).toThrow()
    expect(() => ledgerGuardianClawbackChild(input, substituted, 'phone', 'hardware')).toThrow()
    expect(() => ledgerGuardianInitiateChild({ ...input, vaultId: '11'.repeat(16) }, parent, 'phone', 0)).toThrow()
  })
})
