import { requireSavingsRecoveryKit } from '../program/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnchainWallet, ReadonlySingleKey, Transaction, type Identity } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { p2tr } from '@scure/btc-signer'
import { networkPins } from '../networkPins'
import { inspectLedgerRecoveryFee, ledgerRecoveryFeeWallet, signLedgerRecoveryFeeWithSeed } from './ledgerRecoveryFee'

import { fixture, seed, otherSeed, chain } from './ledgerRecoveryFee.fixture'
function mutate(raw: string, change: (tx: Transaction) => void | Transaction) {
  const tx = Transaction.fromPSBT(hex.decode(raw), { allowLegacyWitnessUtxo: true })
  const updated = change(tx)
  return hex.encode((updated || tx).toPSBT())
}
afterEach(() => vi.restoreAllMocks())

describe('offline Ledger /0/0 recovery fee signer', () => {
  it.each([
    ['mainnet', false],
    ['mainnet', true],
    ['mutinynet', false],
    ['mutinynet', true],
  ] as const)(
    'signs the actual SDK anchor child for %s advanced=%s',
    async (network, advanced) => {
      const originalSeed = Uint8Array.from(seed)
      const request = await fixture(advanced, network),
        plan = inspectLedgerRecoveryFee(request)
      const readonly = ReadonlySingleKey.fromPublicKey(hex.decode(plan.publicKey))
      const denied = (): never => {
        throw new Error('no other signing operation allowed')
      }
      const sign = vi.fn(async (tx: Transaction) => {
        expect(hex.encode(tx.toPSBT())).toBe(plan.unsignedPsbt)
        return Transaction.fromPSBT(hex.decode(signLedgerRecoveryFeeWithSeed(request, seed, hex.encode(tx.toPSBT()))))
      })
      const identity: Identity = {
        compressedPublicKey: () => readonly.compressedPublicKey(),
        xOnlyPublicKey: () => readonly.xOnlyPublicKey(),
        signMessage: denied,
        signerSession: denied,
        sign,
      }
      const wallet = await OnchainWallet.create(identity, networkPins(network).sdkNetwork, {
        ...chain(),
        getCoins: async () =>
          request.fundingCoins.map((coin) => ({
            ...coin,
            status: { confirmed: true, block_time: 1, block_height: 1 },
          })),
      })
      const parent = request.file.exitPackage.steps.find((step) => step.kind === 'bump')!
      if (parent.kind !== 'bump') throw new Error('missing bump')
      const [parentHex, childHex] = await wallet.bumpAnchor(parent.parentHex, request.feeRate)
      expect(parentHex).toBe(parent.parentHex)
      const signed = Transaction.fromRaw(hex.decode(childHex))
      expect(signed.inputsLength).toBe(2)
      expect(signed.getInput(1).finalScriptWitness?.[0].length).toBe(64)
      expect(hex.encode(signed.getOutput(0).script!)).toBe(hex.encode(p2tr(hex.decode(plan.publicKey).slice(1)).script))
      expect(Number(signed.getOutput(0).amount)).toBe(plan.changeSats)
      expect(sign).toHaveBeenCalledTimes(1)
      expect(seed).toEqual(originalSeed)
    },
    30_000,
  )
  it.each(['mainnet', 'mutinynet'] as const)('permits the enrolled Advanced R fee account on %s', async (network) => {
    const request = await fixture(true, network)
    request.role = 'recovery'
    const wallet = ledgerRecoveryFeeWallet(
      request.file.archive.kit.descriptor as Parameters<typeof ledgerRecoveryFeeWallet>[0],
      'recovery',
    )
    request.feeAddress = wallet.feeAddress
    const funding = new Transaction({ version: 2 })
    funding.addInput({ txid: '32'.repeat(32), index: 0 })
    funding.addOutput({ amount: 20_000n, script: p2tr(hex.decode(wallet.publicKey).slice(1)).script })
    request.fundingCoins = [
      { txid: funding.id, vout: 0, value: 20_000, parentTxHex: hex.encode(funding.toBytes(true, true)) },
    ]
    const plan = inspectLedgerRecoveryFee(request)
    expect(() => signLedgerRecoveryFeeWithSeed(request, seed, plan.unsignedPsbt)).toThrow('seed')
    const signed = Transaction.fromPSBT(
      hex.decode(signLedgerRecoveryFeeWithSeed(request, otherSeed, plan.unsignedPsbt)),
    )
    expect(signed.getInput(1).tapKeySig?.length).toBe(64)
  })
  it('refuses an unenrolled Standard recovery fee account', async () => {
    const request = await fixture()
    request.role = 'recovery'
    expect(() => inspectLedgerRecoveryFee(request)).toThrow('not enrolled')
  })
  it('signs multiple verified fee inputs while retaining the anchor', async () => {
    const request = await fixture(),
      coin = request.fundingCoins[0]
    const parent = Transaction.fromRaw(hex.decode(coin.parentTxHex))
    parent.addOutput({ amount: 5000n, script: parent.getOutput(0).script })
    const parentTxHex = hex.encode(parent.toBytes(true, true))
    request.fundingCoins = [0, 1].map((vout) => ({
      txid: parent.id,
      vout,
      value: Number(parent.getOutput(vout).amount),
      parentTxHex,
    }))
    const plan = inspectLedgerRecoveryFee(request)
    const signed = Transaction.fromPSBT(hex.decode(signLedgerRecoveryFeeWithSeed(request, seed, plan.unsignedPsbt)))
    expect(signed.inputsLength).toBe(3)
    expect(signed.getInput(0).tapKeySig).toBeUndefined()
    expect(signed.getInput(1).tapKeySig?.length).toBe(64)
    expect(signed.getInput(2).tapKeySig?.length).toBe(64)
  })
  it.each([
    'destination',
    'rate',
    'missing graph',
    'graph parent',
    'funding parent',
    'funding value',
    'duplicate',
    'origin',
  ])('rejects %s before deriving private keys', async (kind) => {
    const request = await fixture()
    const psbt = inspectLedgerRecoveryFee(request).unsignedPsbt
    if (kind === 'destination') request.feeAddress = request.file.exitPackage.sweepAddress
    if (kind === 'rate') request.feeRate++
    if (kind === 'missing graph') request.file.exitPackage.steps.shift()
    if (kind === 'graph parent') request.parentTxid = 'ff'.repeat(32)
    if (kind === 'funding parent') request.fundingCoins[0].parentTxHex = request.fundingCoins[0].parentTxHex.slice(2)
    if (kind === 'funding value') request.fundingCoins[0].value++
    if (kind === 'duplicate') request.fundingCoins.push(request.fundingCoins[0])
    if (kind === 'origin')
      requireSavingsRecoveryKit(request.file.archive.kit).descriptor.keys.hardware = '02' + '11'.repeat(32)
    const derive = vi.spyOn(HDKey, 'fromMasterSeed')
    expect(() => signLedgerRecoveryFeeWithSeed(request, seed, psbt)).toThrow()
    expect(derive).not.toHaveBeenCalled()
  })
  it.each(['amount', 'output', 'sequence', 'sighash', 'metadata', 'version'])(
    'refuses changed child %s before deriving private keys',
    async (kind) => {
      const request = await fixture(),
        plan = inspectLedgerRecoveryFee(request)
      const changed = mutate(plan.unsignedPsbt, (tx) => {
        if (kind === 'amount') tx.updateOutput(0, { amount: tx.getOutput(0).amount! - 1n })
        if (kind === 'output') tx.updateOutput(0, { script: p2tr(new Uint8Array(32).fill(1)).script })
        if (kind === 'sequence') tx.updateInput(1, { sequence: 0xfffffffd })
        if (kind === 'sighash') tx.updateInput(1, { sighashType: 1 })
        if (kind === 'metadata') tx.updateInput(1, { tapMerkleRoot: new Uint8Array(32).fill(1) })
        if (kind === 'version') {
          const changed = new Transaction({ version: 2, allowLegacyWitnessUtxo: true })
          for (let i = 0; i < tx.inputsLength; i++) changed.addInput(tx.getInput(i))
          for (let i = 0; i < tx.outputsLength; i++) changed.addOutput(tx.getOutput(i))
          return changed
        }
      })
      const derive = vi.spyOn(HDKey, 'fromMasterSeed')
      expect(() => signLedgerRecoveryFeeWithSeed(request, seed, changed)).toThrow()
      expect(derive).not.toHaveBeenCalled()
    },
  )
  it('rejects another seed and wipes all owned private nodes on success and error', async () => {
    const request = await fixture(),
      plan = inspectLedgerRecoveryFee(request)
    const nodes: HDKey[] = [],
      derive = HDKey.prototype.deriveChild
    vi.spyOn(HDKey.prototype, 'deriveChild').mockImplementation(function (this: HDKey, index: number) {
      const child = derive.call(this, index)
      if (child.privateKey) nodes.push(child)
      return child
    })
    signLedgerRecoveryFeeWithSeed(request, seed, plan.unsignedPsbt)
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.every((node) => node.privateKey === null)).toBe(true)
    expect(() => signLedgerRecoveryFeeWithSeed(request, otherSeed, plan.unsignedPsbt)).toThrow('seed')
  })
})
