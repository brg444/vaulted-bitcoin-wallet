import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { Transaction, RestArkProvider, RestIndexerProvider, type VirtualCoin } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import native from './testdata/nativeDelegationRecovery.json'
import { delegationFixture } from './testdata/delegation'
import { lightDescriptorDigest, type LightDescriptor } from './contract'
import { importGuardianReplacement } from './delegationRecovery'
import { lightExitRepository } from './exitRepository'
import { captureLightRecoveryArchive, validateLightRecoveryArchive } from './recoveryArchive'
import type { GuardianDelegationStatus } from './delegationStore'

function fixture() {
  const d = native.descriptor as LightDescriptor
  const info = { ...delegationFixture(d).info, vtxoTreeExpiry: BigInt(native.recovery.batchExpiry) }
  const commitment = Transaction.fromPSBT(base64.decode(native.recovery.commitmentPsbt))
  const leaf = Transaction.fromPSBT(base64.decode(native.recovery.vtxoTree[0].tx))
  const vout = Array.from({ length: leaf.outputsLength }, (_, i) => i).find(
    (i) => hex.encode(leaf.getOutput(i).script!) === d.scriptPubKey,
  )!
  const coin = {
    txid: leaf.id,
    vout,
    value: native.plan.renewal.receiverSats,
    script: d.scriptPubKey,
    createdAt: new Date(native.plan.validAt * 1000),
    expiresAt: new Date(native.plan.inputExpiresAt * 1000),
    commitmentTxIds: [commitment.id],
    isSpent: false,
    isSwept: false,
    isUnrolled: false,
    isPreconfirmed: false,
  } as VirtualCoin
  const status: GuardianDelegationStatus = {
    version: 1,
    operationId: native.plan.request.operationId,
    descriptorHash: lightDescriptorDigest(d),
    state: 'confirmed',
    validAt: native.plan.validAt,
    expiresAt: native.plan.request.expiresAt,
    txid: native.plan.renewal.txid,
    vout: native.plan.renewal.vout,
    inputValueSats: native.plan.renewal.valueSats,
    receiverSats: coin.value,
    commitmentTxid: commitment.id,
    receiverTxid: coin.txid,
    receiverVout: coin.vout,
    receiverExpiresAt: Math.floor(coin.expiresAt!.getTime() / 1000),
    recovery: structuredClone(native.recovery),
  }
  return { d, info, coin, status, commitment, leaf }
}
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('actual native Guardian MuSig recovery graph through the pinned SDK', () => {
  it('imports verified signed transactions into the SDK repository and captures the ordinary full archive', async () => {
    const f = fixture()
    await importGuardianReplacement(f.d, f.status, f.info, f.coin)
    const repo = lightExitRepository(f.d)
    const first = await repo.getVirtualTx(f.coin.txid)
    expect(Transaction.fromPSBT(base64.decode(first!.psbt!)).getInput(0).tapKeySig).toHaveLength(64)
    await repo[Symbol.asyncDispose]()
    await importGuardianReplacement(f.d, f.status, f.info, f.coin)
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(f.info)
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [f.coin] })
    const chain = vi
      .spyOn(RestIndexerProvider.prototype, 'getVtxoChain')
      .mockRejectedValue(new Error('No public graph lookup needed'))
    const txs = vi
      .spyOn(RestIndexerProvider.prototype, 'getVirtualTxs')
      .mockRejectedValue(new Error('No public PSBT lookup needed'))
    const archive = await captureLightRecoveryArchive(f.d, [f.coin])
    expect(validateLightRecoveryArchive(archive, f.d).coins).toEqual([f.coin])
    expect(archive.transactions[f.coin.txid]).toBeTruthy()
    expect(chain).not.toHaveBeenCalled()
    expect(txs).not.toHaveBeenCalled()
  })
  it('rejects invalid signatures before any canonical repository write', async () => {
    const f = fixture()
    f.leaf.updateInput(0, { tapKeySig: new Uint8Array(64).fill(1) }, true)
    f.status.recovery!.vtxoTree[0].tx = base64.encode(f.leaf.toPSBT())
    await expect(importGuardianReplacement(f.d, f.status, f.info, f.coin)).rejects.toThrow(
      'signature or recovery delay',
    )
    const repo = lightExitRepository(f.d)
    expect(await repo.getVirtualTx(f.coin.txid)).toBeNull()
    await repo[Symbol.asyncDispose]()
  })
  it('rejects changed commitment, tree root key, receiver, delay and independent indexer facts', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.status.commitmentTxid = 'ff'.repeat(32)
      },
      (f: ReturnType<typeof fixture>) => {
        f.status.receiverSats--
      },
      (f: ReturnType<typeof fixture>) => {
        f.status.recovery!.batchExpiry += 512
      },
      (f: ReturnType<typeof fixture>) => {
        f.coin.commitmentTxIds = []
      },
      (f: ReturnType<typeof fixture>) => {
        f.coin.expiresAt = new Date(0)
      },
      (f: ReturnType<typeof fixture>) => {
        f.coin.isSpent = true
      },
      (f: ReturnType<typeof fixture>) => {
        f.status.recovery!.vtxoTree.push(f.status.recovery!.vtxoTree[0])
      },
      (f: ReturnType<typeof fixture>) => {
        f.commitment.updateOutput(0, { script: hex.decode(f.d.scriptPubKey) }, true)
        f.status.recovery!.commitmentPsbt = base64.encode(f.commitment.toPSBT())
        f.status.commitmentTxid = f.commitment.id
        f.coin.commitmentTxIds = [f.commitment.id]
        f.leaf.updateInput(0, { txid: f.commitment.id }, true)
        f.status.receiverTxid = f.leaf.id
        f.coin.txid = f.leaf.id
        f.status.recovery!.vtxoTree[0] = { txid: f.leaf.id, tx: base64.encode(f.leaf.toPSBT()), children: {} }
        f.status.recovery!.connectors = []
      },
    ]) {
      const f = fixture()
      mutate(f)
      await expect(importGuardianReplacement(f.d, f.status, f.info, f.coin)).rejects.toThrow()
      const repo = lightExitRepository(f.d)
      expect(await repo.getVirtualTx(f.coin.txid)).toBeNull()
      await repo[Symbol.asyncDispose]()
    }
  })
})
