import { describe, expect, it } from 'vitest'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { p256 } from '@noble/curves/nist.js'
import { Transaction } from '@scure/btc-signer'
import {
  acceptLedgerRecoveryGuardianSignatures,
  attachLedgerRecoveryPhoneProof,
  buildLedgerRecoveryPsbt,
  inspectLedgerRecoveryTransition,
  ledgerRecoveryPhoneAuthorizationDigest,
  requireLedgerRecoveryUserApproval,
  signLedgerRecoveryWithPhone,
  type LedgerRecoveryAction,
  type LedgerRecoveryTransition,
} from './ledgerRecovery'
import { signDirectP256 } from './ceremony/directauth'
import { defaultSpendingPolicy } from './spendingPolicy'
import { buildLedgerNativeFamily } from './program/ledgerNativeFamily'
import {
  ledgerBip32Versions,
  ledgerGuardianClawbackChild,
  ledgerGuardianInitiateChild,
  ledgerRecoveryChild,
  ledgerSavingsChild,
  ledgerSavingsGuardianParent,
  type LedgerSavingsKeyContext,
} from './program/ledgerNativeKeys'
import { familyClaimants, type Claimant } from './program/constants'
import { scalarSecret } from './program/fixtures'
import vectors from './program/ledger-key-vectors.json'
import recoveryVectors from './program/ledger-recovery-vectors.json'

const opts = { version: 2, lockTime: 0, allowUnknownInputs: true, allowUnknownOutputs: true } as const
const phoneDirectSecret = scalarSecret(19)

function fixture(
  vector = vectors[0],
  action: LedgerRecoveryAction = { kind: 'initiate', claimant: 'phone', change: 0 },
) {
  const context = {
    ...structuredClone(vector.input),
    phoneDirectP256: hex.encode(p256.getPublicKey(phoneDirectSecret, true)),
  } as LedgerSavingsKeyContext
  const contract = { context, spendingPolicy: defaultSpendingPolicy(context.network) }
  const family = buildLedgerNativeFamily(context, contract.spendingPolicy)
  const source =
    action.kind === 'initiate'
      ? action.change === 0
        ? family.receive
        : family.change
      : family.recovery[action.claimant]!.pending
  const destination =
    action.kind === 'initiate'
      ? family.recovery[action.claimant]!.pending
      : family.recovery[action.claimant]!.quarantine
  const parent = new Transaction(opts)
  parent.addInput({ txid: '00'.repeat(32), index: 99 })
  parent.addOutput({ script: source.script, amount: 100000n })
  const transition: LedgerRecoveryTransition = {
    contract,
    action,
    coin: { txid: parent.id, vout: 0, value: 100000, parentTxHex: hex.encode(parent.toBytes(true, true)) },
    feeSats: 1000,
  }
  const versions = ledgerBip32Versions(context.network)
  const account = (role: Claimant) =>
    HDKey.fromMasterSeed(
      new Uint8Array(32).fill({ phone: 0x43, hardware: 0x42, recovery: 0x44 }[role]),
      versions,
    ).derive(`m/86'/${context.network === 'mainnet' ? 0 : 1}'/0'`)
  const user = action.kind === 'initiate' ? action.claimant : action.remainingUser
  const userChild =
    action.kind === 'initiate'
      ? ledgerSavingsChild(account(user), user === 'recovery' ? action.change : action.change + 2)
      : ledgerRecoveryChild(account(user), 'clawback')
  const guardianParent = new HDKey({
    privateKey: scalarSecret(14),
    chainCode: ledgerSavingsGuardianParent(context).chainCode!,
    versions,
  })
  const guardianChild =
    action.kind === 'initiate'
      ? ledgerGuardianInitiateChild(context, guardianParent, action.claimant, action.change)
      : ledgerGuardianClawbackChild(context, guardianParent, action.claimant, action.remainingUser)
  const sign = (psbt: string, secret: Uint8Array) => {
    const tx = Transaction.fromPSBT(hex.decode(psbt), opts)
    tx.signIdx(secret, 0)
    return hex.encode(tx.toPSBT())
  }
  return { transition, family, source, destination, account, user, userChild, guardianChild, sign }
}

function actions(advanced: boolean): LedgerRecoveryAction[] {
  const roles = familyClaimants(advanced)
  return roles.flatMap((claimant) => [
    ...([0, 1] as const).map((change) => ({ kind: 'initiate', claimant, change }) as const),
    ...roles
      .filter((role) => role !== claimant)
      .map((remainingUser) => ({ kind: 'clawback', claimant, remainingUser, change: 0 }) as const),
  ])
}

function mutatePsbt(psbt: string, mutate: (tx: Transaction) => void) {
  const tx = Transaction.fromPSBT(hex.decode(psbt), opts)
  mutate(tx)
  return hex.encode(tx.toPSBT())
}

describe('Guardian-only Ledger recovery coordinator primitive', () => {
  for (const vector of vectors) {
    for (const action of actions(Boolean(vector.input.recovery))) {
      it(`verifies ${vector.input.network} ${vector.input.recovery ? 'advanced' : 'standard'} ${action.kind} ${action.claimant} ${action.remainingUser || action.change}`, () => {
        const f = fixture(vector, action)
        const unsigned = buildLedgerRecoveryPsbt(f.transition)
        const tx = Transaction.fromPSBT(hex.decode(unsigned), opts)
        const review = inspectLedgerRecoveryTransition(f.transition)
        expect(tx.version).toBe(2)
        expect(tx.lockTime).toBe(0)
        expect(tx.inputsLength).toBe(1)
        expect(tx.outputsLength).toBe(1)
        expect(tx.getInput(0).sequence).toBe(0xfffffffd)
        expect(tx.getInput(0).tapLeafScript).toHaveLength(1)
        expect(tx.getInput(0).tapBip32Derivation).toHaveLength(2)
        expect(tx.getOutput(0)).toMatchObject({ script: f.destination.script, amount: 99000n })
        expect(review.destinationAddress).toBe(f.destination.address)
        const userPsbt =
          f.user === 'phone'
            ? signLedgerRecoveryWithPhone(f.transition, f.account('phone'))
            : f.sign(unsigned, f.userChild.privateKey!)
        const signed = f.sign(userPsbt, f.guardianChild.privateKey!)
        const accepted = acceptLedgerRecoveryGuardianSignatures(f.transition, userPsbt, signed)
        const final = Transaction.fromPSBT(hex.decode(accepted), opts)
        final.finalize()
        expect(final.vsize).toBe(review.vsize)
        expect(final.getInput(0).finalScriptWitness).toHaveLength(4)
        expect(final.extract().length).toBeGreaterThan(0)
      }, 10000)
    }
  }

  for (const vector of recoveryVectors) {
    it(`matches runtime wire ${vector.contract.context.network} ${vector.contract.context.recovery ? 'advanced' : 'standard'} ${vector.action.kind} ${vector.action.claimant} ${vector.action.change}`, () => {
      const transition = vector as LedgerRecoveryTransition
      expect(buildLedgerRecoveryPsbt(transition)).toBe(vector.unsignedPsbt)
      expect(hex.encode(ledgerRecoveryPhoneAuthorizationDigest(transition))).toBe(vector.phoneDigest)
      expect(
        attachLedgerRecoveryPhoneProof(transition, vector.userPsbt, vector.phoneSignature).phoneAuthorization,
      ).toEqual({ digest: vector.phoneDigest, signature: vector.phoneSignature })
      expect(inspectLedgerRecoveryTransition(transition).vsize).toBe(vector.vsize)
    })
  }

  it('validates the complete parent, selected source, role and enrollment before signing', () => {
    const { transition } = fixture()
    for (const patch of [
      { txid: 'aa'.repeat(32) },
      { txid: transition.coin.txid.toUpperCase() },
      { vout: 1 },
      { vout: -1 },
      { vout: 2 ** 32 },
      { value: 100001 },
      { value: NaN },
      { value: Number.MAX_SAFE_INTEGER },
      { parentTxHex: '00' },
      { parentTxHex: transition.coin.parentTxHex + '00' },
    ])
      expect(() => buildLedgerRecoveryPsbt({ ...transition, coin: { ...transition.coin, ...patch } })).toThrow()
    for (const action of [
      { kind: 'initiate', claimant: 'phone', change: 1 },
      { kind: 'initiate', claimant: 'phone', change: 2 },
      { kind: 'initiate', claimant: 'recovery', change: 0 },
      { kind: 'initiate', claimant: 'phone', change: 0, remainingUser: 'hardware' },
      { kind: 'clawback', claimant: 'phone', remainingUser: 'phone', change: 0 },
      { kind: 'clawback', claimant: 'phone', remainingUser: 'hardware', change: 1 },
      { kind: 'unknown', claimant: 'phone', change: 0 },
    ])
      expect(() => buildLedgerRecoveryPsbt({ ...transition, action } as LedgerRecoveryTransition)).toThrow()
    expect(() =>
      buildLedgerRecoveryPsbt({
        ...transition,
        contract: { ...transition.contract, context: { ...transition.contract.context, vaultId: '11'.repeat(16) } },
      }),
    ).toThrow()
    expect(() =>
      buildLedgerRecoveryPsbt({
        ...transition,
        contract: { ...transition.contract, spendingPolicy: defaultSpendingPolicy('mainnet') },
      }),
    ).toThrow()
  })

  for (const action of actions(true)) {
    it(`caps canonical witness fees for ${action.kind} ${action.claimant} ${action.remainingUser || action.change}`, () => {
      const { transition } = fixture(vectors[1], action)
      const review = inspectLedgerRecoveryTransition(transition)
      const max = review.vsize * transition.contract.spendingPolicy.feerateCapSatPerV
      expect(() => buildLedgerRecoveryPsbt({ ...transition, feeSats: max })).not.toThrow()
      expect(() => buildLedgerRecoveryPsbt({ ...transition, feeSats: max + 1 })).toThrow('feerate')
    })
  }

  it('rejects zero fees, dust and invalid fee values', () => {
    const { transition } = fixture()
    for (const feeSats of [
      0,
      -1,
      NaN,
      1.1,
      Number.MAX_SAFE_INTEGER,
      transition.contract.spendingPolicy.absoluteFeeCapSats + 1,
    ])
      expect(() => buildLedgerRecoveryPsbt({ ...transition, feeSats })).toThrow()
    expect(() =>
      buildLedgerRecoveryPsbt({ ...transition, coin: { ...transition.coin, value: transition.feeSats + 329 } }),
    ).toThrow('dust')
  })

  it('rejects transaction, fee, signature, leaf, origin and proprietary metadata substitutions', () => {
    const f = fixture()
    const approved = signLedgerRecoveryWithPhone(f.transition, f.account('phone'))
    const signed = f.sign(approved, f.guardianChild.privateKey!)
    const bad = (mutate: (tx: Transaction) => void) => mutatePsbt(signed, mutate)
    for (const mutate of [
      (tx: Transaction) => tx.updateOutput(0, { script: f.source.script }, true),
      (tx: Transaction) => tx.updateOutput(0, { amount: 98000n }, true),
      (tx: Transaction) => tx.addOutput({ script: f.destination.script, amount: 0n }, true),
      (tx: Transaction) => tx.updateInput(0, { sequence: 0xffffffff }, true),
      (tx: Transaction) => tx.updateInput(0, { sighashType: 0x83 }, true),
      (tx: Transaction) => tx.updateInput(0, { tapKeySig: new Uint8Array(64) }, true),
      (tx: Transaction) => tx.updateInput(0, { finalScriptWitness: [new Uint8Array(64)] }, true),
      (tx: Transaction) => tx.updateInput(0, { proprietary: [[new Uint8Array([1]), new Uint8Array([2])]] }, true),
      (tx: Transaction) => tx.updateOutput(0, { proprietary: [[new Uint8Array([1]), new Uint8Array([2])]] }, true),
    ])
      expect(() => acceptLedgerRecoveryGuardianSignatures(f.transition, approved, bad(mutate))).toThrow()
    const malformed = (mutate: (input: ReturnType<Transaction['getInput']>) => void) => {
      const raw = Transaction.fromPSBT(hex.decode(signed), opts)
      const input = raw.getInput(0)
      mutate(input)
      const altered = new Transaction(opts)
      altered.addInput(input, true)
      altered.addOutput(raw.getOutput(0), true)
      return hex.encode(altered.toPSBT())
    }
    for (const mutate of [
      (input: ReturnType<Transaction['getInput']>) => {
        input.tapBip32Derivation![0][1].der.path[3] += 2
      },
      (input: ReturnType<Transaction['getInput']>) => {
        input.tapBip32Derivation![1][1].der.fingerprint ^= 1
      },
      (input: ReturnType<Transaction['getInput']>) => {
        input.tapLeafScript![0][0].merklePath[0][0] ^= 1
      },
      (input: ReturnType<Transaction['getInput']>) => {
        input.tapScriptSig![0][1][0] ^= 1
      },
      (input: ReturnType<Transaction['getInput']>) => {
        input.tapScriptSig![0][1] = new Uint8Array([...input.tapScriptSig![0][1], 0])
      },
      (input: ReturnType<Transaction['getInput']>) => {
        input.tapScriptSig![0][0].leafHash[0] ^= 1
      },
      (input: ReturnType<Transaction['getInput']>) => {
        input.tapScriptSig!.pop()
      },
      (input: ReturnType<Transaction['getInput']>) => {
        input.tapScriptSig![0][0].pubKey = f.account('hardware').publicKey!.slice(1)
      },
      (input: ReturnType<Transaction['getInput']>) => {
        input.witnessUtxo!.amount += 1n
      },
    ])
      expect(() => acceptLedgerRecoveryGuardianSignatures(f.transition, approved, malformed(mutate))).toThrow()
    expect(() => acceptLedgerRecoveryGuardianSignatures({ ...f.transition, feeSats: 999 }, approved, signed)).toThrow()
    expect(() => acceptLedgerRecoveryGuardianSignatures(f.transition, signed, signed)).toThrow()
    expect(() => signLedgerRecoveryWithPhone(f.transition, f.account('hardware'))).toThrow()
    expect(() =>
      signLedgerRecoveryWithPhone(
        f.transition,
        HDKey.fromExtendedKey(
          f.transition.contract.context.phone.xpub,
          ledgerBip32Versions(f.transition.contract.context.network),
        ),
      ),
    ).toThrow()
  })

  it('requires user approval and forbids phone proofs or local signing on another user path', () => {
    for (const action of [
      { kind: 'initiate', claimant: 'hardware', change: 0 },
      { kind: 'clawback', claimant: 'phone', remainingUser: 'hardware', change: 0 },
    ] as const) {
      const f = fixture(vectors[0], action)
      const unsigned = buildLedgerRecoveryPsbt(f.transition)
      expect(() => requireLedgerRecoveryUserApproval(f.transition, unsigned)).toThrow()
      const userPsbt = f.sign(unsigned, f.userChild.privateKey!)
      expect(() => signLedgerRecoveryWithPhone(f.transition, f.account('phone'))).toThrow()
      expect(() => ledgerRecoveryPhoneAuthorizationDigest(f.transition)).toThrow()
      expect(() => attachLedgerRecoveryPhoneProof(f.transition, userPsbt, '00'.repeat(64))).toThrow()
    }
  })

  it('binds detached phone proof to the retained transaction, action and account context', () => {
    const f = fixture()
    const approved = signLedgerRecoveryWithPhone(f.transition, f.account('phone'))
    const digest = ledgerRecoveryPhoneAuthorizationDigest(f.transition)
    const signature = hex.encode(signDirectP256(phoneDirectSecret, digest))
    expect(() => attachLedgerRecoveryPhoneProof(f.transition, approved, signature)).not.toThrow()
    expect(() => attachLedgerRecoveryPhoneProof(f.transition, approved, signature.slice(2))).toThrow()
    expect(() => attachLedgerRecoveryPhoneProof(f.transition, approved, '00'.repeat(64))).toThrow()
    const changed = { ...f.transition, feeSats: f.transition.feeSats + 1 }
    expect(ledgerRecoveryPhoneAuthorizationDigest(changed)).not.toEqual(digest)
    expect(() =>
      attachLedgerRecoveryPhoneProof(changed, signLedgerRecoveryWithPhone(changed, f.account('phone')), signature),
    ).toThrow()
    const clawback = fixture(vectors[0], { kind: 'clawback', claimant: 'hardware', remainingUser: 'phone', change: 0 })
    expect(ledgerRecoveryPhoneAuthorizationDigest(clawback.transition)).not.toEqual(digest)
  })
})
