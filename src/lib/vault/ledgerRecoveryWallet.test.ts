// @vitest-environment node
import { Buffer } from 'buffer'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { base64, hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { Transaction } from '@scure/btc-signer'
import { ledgerRecoveryFixture, ledgerFixturePRF } from './recovery/testdata/ledger'
import { deriveDirectP256 } from './ceremony/directauth'
import {
  approveLedgerRecovery,
  discardUnsignedLedgerRecoveryRecord,
  exportLedgerRecoveryJournal,
  restoreLedgerRecoveryJournal,
  saveLedgerRecoveryRecord,
  validateLedgerRecoveryRecord,
  type LedgerRecoveryRecord,
} from './ledgerRecoveryWallet'
import { buildLedgerRecoveryPsbt, inspectLedgerRecoveryTransition, type LedgerRecoveryAction } from './ledgerRecovery'
import {
  ledgerBip32Versions,
  ledgerGuardianClawbackChild,
  ledgerGuardianInitiateChild,
  ledgerSavingsGuardianParent,
} from './program/ledgerNativeKeys'
import { scalarSecret } from './program/fixtures'

beforeEach(() => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  })
  vi.stubGlobal('navigator', { locks: { request: async (_: string, fn: () => Promise<unknown>) => fn() } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function fixture(action: LedgerRecoveryAction, advanced = true) {
  const f = await ledgerRecoveryFixture(advanced)
  const source =
    action.kind === 'initiate'
      ? action.change
        ? f.family.change
        : f.family.receive
      : f.family.recovery[action.claimant]!.pending
  const coin = f.archive.onchain.find((c) => c.script === hex.encode(source.script))!
  const record: LedgerRecoveryRecord = {
    version: 1,
    transition: {
      contract: f.composite.savings,
      action,
      coin: { txid: coin.txid, vout: coin.vout, value: coin.value, parentTxHex: coin.parentHex },
      feeSats: 500,
    },
  }
  const context = f.composite.savings.context,
    view = inspectLedgerRecoveryTransition(record.transition)
  const begin = vi.fn(async () => {
    const d = await deriveDirectP256(ledgerFixturePRF)
    return {
      prf: ledgerFixturePRF.slice(),
      scalar: d.scalar,
      derivedDirectPub: d.pub,
      credentialId: new Uint8Array(32),
      assertion: {
        challengeId: 'fresh',
        credentialId: f.enrollment.credId,
        clientDataJSON: '',
        authenticatorData: '',
        signature: '',
        directProof: '',
      },
    }
  })
  const post = vi.fn(async (_path: string, body: unknown) => {
    const b = body as { psbt: string; phoneAuthorization?: unknown; challengeId?: string }
    expect(b.psbt).toMatch(/^cHNidP/)
    expect(Boolean(b.phoneAuthorization)).toBe(view.user === 'phone')
    expect(Boolean(b.challengeId)).toBe(view.user === 'phone')
    const tx = Transaction.fromPSBT(base64.decode(b.psbt))
    const parent = new HDKey({
      privateKey: scalarSecret(14),
      chainCode: ledgerSavingsGuardianParent(context).chainCode!,
      versions: ledgerBip32Versions(context.network),
    })
    const child =
      action.kind === 'initiate'
        ? ledgerGuardianInitiateChild(context, parent, action.claimant, action.change)
        : ledgerGuardianClawbackChild(context, parent, action.claimant, action.remainingUser)
    try {
      tx.signIdx(child.privateKey!, 0)
      return { signedPsbt: base64.encode(tx.toPSBT()), replay: false }
    } finally {
      parent.wipePrivateData()
      child.wipePrivateData()
    }
  })
  const connect = vi.fn(async () => {
    const root = HDKey.fromMasterSeed(
      new Uint8Array(32).fill(view.user === 'hardware' ? 0x42 : 0x44),
      ledgerBip32Versions(context.network),
    )
    const origin = context[view.user]!,
      account = root.derive(`m/86'/1'/0'`)
    const nodes = [root, account]
    return {
      app: {
        getMasterFingerprint: async () => origin.fingerprint,
        getExtendedPubkey: async () => account.publicExtendedKey,
        registerWallet: async (policy: { getId(): Buffer }) => [policy.getId(), Buffer.alloc(32, 1)],
        getWalletAddress: async () => view.sourceAddress,
        signPsbt: async (psbt: Buffer) => {
          const tx = Transaction.fromPSBT(psbt),
            path = tx.getInput(0).tapBip32Derivation!.find(([, d]) => d.der.path.length === 5)![1].der.path
          let key = root
          for (const index of path) {
            key = key.deriveChild(index)
            nodes.push(key)
          }
          tx.signIdx(key.privateKey!, 0)
          return tx.getInput(0).tapScriptSig!.map(([key, signature]) => [
            0,
            {
              pubkey: Buffer.from(key.pubKey),
              tapleafHash: Buffer.from(key.leafHash),
              signature: Buffer.from(signature),
            },
          ])
        },
      },
      close: async () => nodes.forEach((n) => n.wipePrivateData()),
    }
  })
  return {
    ...f,
    record,
    begin,
    post,
    connect,
    deps: { begin, post, connect } as unknown as NonNullable<Parameters<typeof approveLedgerRecovery>[3]>,
  }
}

describe('native Ledger recovery lifecycle', () => {
  it.each([
    { kind: 'initiate', claimant: 'phone', change: 0 },
    { kind: 'initiate', claimant: 'hardware', change: 1 },
    { kind: 'initiate', claimant: 'recovery', change: 0 },
    { kind: 'clawback', claimant: 'hardware', remainingUser: 'phone', change: 0 },
    { kind: 'clawback', claimant: 'phone', remainingUser: 'hardware', change: 0 },
  ] as const)(
    'persists exact $kind $claimant approval and completed bytes',
    async (action) => {
      const f = await fixture(action)
      const result = await approveLedgerRecovery(f.record, f.status, f.enrollment, f.deps)
      expect(validateLedgerRecoveryRecord(result)).toEqual(result)
      expect(result.txHex).toMatch(/^[0-9a-f]+$/)
      expect(f.begin).toHaveBeenCalledTimes(
        inspectLedgerRecoveryTransition(f.record.transition).user === 'phone' ? 1 : 0,
      )
      const again = await approveLedgerRecovery(f.record, f.status, f.enrollment, f.deps)
      expect(again).toEqual(result)
      expect(f.post).toHaveBeenCalledTimes(1)
      const exported = exportLedgerRecoveryJournal(f.composite.savings)
      await restoreLedgerRecoveryJournal(f.composite.savings, { version: 1, records: [f.record] })
      expect(exportLedgerRecoveryJournal(f.composite.savings)).toEqual(exported)
    },
    30000,
  )
  it('retains phone approval after a lost response, requests a fresh session, and rejects candidate replacement', async () => {
    const f = await fixture({ kind: 'initiate', claimant: 'phone', change: 0 })
    f.post.mockRejectedValueOnce(new Error('lost response'))
    await expect(approveLedgerRecovery(f.record, f.status, f.enrollment, f.deps)).rejects.toThrow('lost response')
    const retained = exportLedgerRecoveryJournal(f.composite.savings).records[0]
    expect(retained.userPsbt).toBeDefined()
    expect(retained.phoneAuthorization).toBeDefined()
    await expect(
      saveLedgerRecoveryRecord({ version: 1, transition: { ...f.record.transition, feeSats: 501 } }),
    ).rejects.toThrow('still pending')
    const result = await approveLedgerRecovery(retained, f.status, f.enrollment, f.deps)
    expect(result.userPsbt).toBe(retained.userPsbt)
    expect(result.phoneAuthorization).toEqual(retained.phoneAuthorization)
    expect(f.begin).toHaveBeenCalledTimes(2)
  }, 30000)
  it('does not retain substituted service signatures or changed output metadata', async () => {
    const f = await fixture({ kind: 'initiate', claimant: 'hardware', change: 0 })
    f.post.mockResolvedValueOnce({
      signedPsbt: base64.encode(hex.decode(buildLedgerRecoveryPsbt(f.record.transition))),
      replay: false,
    })
    await expect(approveLedgerRecovery(f.record, f.status, f.enrollment, f.deps)).rejects.toThrow()
    expect(exportLedgerRecoveryJournal(f.composite.savings).records[0].guardianPsbt).toBeUndefined()
    const altered = structuredClone(f.record)
    altered.transition.contract.context.hardware.fingerprint = '00000000'
    await expect(approveLedgerRecovery(altered, f.status, f.enrollment, f.deps)).rejects.toThrow()
    expect(f.post).toHaveBeenCalledTimes(1)
  }, 30000)
})

it('discards only an unsigned recovery draft and preserves an approved pending action', async () => {
  const f = await fixture({ kind: 'initiate', claimant: 'phone', change: 0 })
  await saveLedgerRecoveryRecord(f.record)
  await discardUnsignedLedgerRecoveryRecord(f.record)
  expect(exportLedgerRecoveryJournal(f.composite.savings).records).toEqual([])
  f.post.mockRejectedValueOnce(new Error('lost response'))
  await expect(approveLedgerRecovery(f.record, f.status, f.enrollment, f.deps)).rejects.toThrow('lost response')
  await expect(discardUnsignedLedgerRecoveryRecord(f.record)).rejects.toThrow()
  expect(exportLedgerRecoveryJournal(f.composite.savings).records[0].userPsbt).toBeDefined()
}, 30000)

it('aborts after a passkey response without signing or dispatch and wipes session secrets', async () => {
  const f = await fixture({ kind: 'initiate', claimant: 'phone', change: 0 })
  const controller = new AbortController()
  const begin = f.deps.begin
  let session: Awaited<ReturnType<typeof begin>> | undefined
  f.deps.begin = async (...args) => {
    session = await begin(...args)
    controller.abort(new Error('screen closed'))
    return session
  }
  await expect(approveLedgerRecovery(f.record, f.status, f.enrollment, f.deps, controller.signal)).rejects.toThrow(
    'screen closed',
  )
  expect(f.post).not.toHaveBeenCalled()
  expect(exportLedgerRecoveryJournal(f.composite.savings).records[0].userPsbt).toBeUndefined()
  expect(session!.prf.every((v) => v === 0)).toBe(true)
  expect(session!.scalar.every((v) => v === 0)).toBe(true)
}, 30000)
