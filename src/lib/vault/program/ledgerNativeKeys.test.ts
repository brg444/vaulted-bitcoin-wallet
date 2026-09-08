import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import vectors from './ledger-key-vectors.json'
import {
  ledgerAccountKey,
  ledgerBip32Versions,
  ledgerRecoveryProgramParent,
  ledgerSavingsChild,
  ledgerSavingsContextDigest,
  ledgerSavingsInternalParent,
  type LedgerSavingsKeyContext,
} from './ledgerNativeKeys'
import { scalarSecret } from './fixtures'
import { tweakPrivateKey } from './tweak'
import type { Claimant } from './constants'
import { buildLedgerNativeSavings } from './ledgerNativePolicy'

describe('Ledger native Savings derivation contract', () => {
  for (const vector of vectors)
    it(`matches shared ${vector.input.network} ${vector.input.recovery ? 'advanced' : 'standard'} vectors`, () => {
      const input = vector.input as LedgerSavingsKeyContext
      const programs = Object.fromEntries(vector.programParents.map((p) => [p.claimant, p.program]))
      const normal = buildLedgerNativeSavings(input, programs)
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
      for (const expected of vector.programParents) {
        const script = hex.decode(expected.program)
        const parent = ledgerRecoveryProgramParent(
          input,
          expected.claimant as Claimant,
          expected.cosigner as 'vault' | 'arkade',
          script,
        )
        expect(parent.publicExtendedKey).toBe(expected.xpub)
        const privateParent = new HDKey({
          privateKey: tweakPrivateKey(scalarSecret(expected.cosigner === 'vault' ? 14 : 15), script),
          chainCode: parent.chainCode!,
          versions: ledgerBip32Versions(input.network),
        })
        for (const branch of [0, 1]) {
          const pub = ledgerSavingsChild(parent, branch).publicKey
          expect(hex.encode(pub!)).toBe(expected.children[branch])
          expect(ledgerSavingsChild(privateParent, branch).publicKey).toEqual(pub)
        }
      }
    })

  const source = vectors[0].input as LedgerSavingsKeyContext
  it('separates vault, policy, origin and authentication bindings', () => {
    const original = hex.encode(ledgerSavingsContextDigest(source))
    const changes = [
      { ...source, vaultId: '11'.repeat(16) },
      { ...source, policyDigest: '22'.repeat(32) },
      { ...source, hardware: { ...source.hardware, fingerprint: '00000001' } },
      { ...source, vaultCosignerBase: source.arkadeCosignerBase, arkadeCosignerBase: source.vaultCosignerBase },
    ]
    for (const input of changes) expect(hex.encode(ledgerSavingsContextDigest(input))).not.toBe(original)
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
    expect(() => ledgerSavingsContextDigest({ ...source, arkadeCosignerBase: source.vaultCosignerBase })).toThrow()
    expect(() => ledgerSavingsContextDigest({ ...source, policyDigest: '' })).toThrow()
    expect(() => ledgerSavingsContextDigest({ ...source, vaultId: source.vaultId.toUpperCase() })).toThrow()
    expect(() => ledgerSavingsContextDigest({ ...source, phoneDirectP256: '00'.repeat(33) })).toThrow()
    expect(() => ledgerRecoveryProgramParent(source, 'recovery', 'vault', new Uint8Array([0x51]))).toThrow()
    expect(() => ledgerRecoveryProgramParent(source, 'phone', 'vault', new Uint8Array())).toThrow()
  })

  it('binds the exact program and role before derivation', () => {
    const expected = vectors[0].programParents[0]
    const script = hex.decode(expected.program)
    const first = ledgerRecoveryProgramParent(source, 'phone', 'vault', script).publicExtendedKey
    const changed = script.slice()
    changed[changed.length - 1] ^= 1
    expect(ledgerRecoveryProgramParent(source, 'phone', 'vault', changed).publicExtendedKey).not.toBe(first)
    expect(ledgerRecoveryProgramParent(source, 'hardware', 'vault', script).publicExtendedKey).not.toBe(first)
    expect(ledgerRecoveryProgramParent(source, 'phone', 'arkade', script).publicExtendedKey).not.toBe(first)
  })
})
