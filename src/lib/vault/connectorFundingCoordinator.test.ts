import { beforeEach, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import { Transaction, p2wpkh } from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { createFunding, loadFunding, submitFunding, finishFunding, abandonFunding } from './connectorFunding'
import { buildConnectorFamily } from './program/connector'
import { defaultSpendingPolicy } from './spendingPolicy'
import type { VaultStatus } from './types'
import vectors from './program/connector-vectors.json'

const mocks = vi.hoisted(() => ({
  contract: vi.fn(),
  coins: vi.fn(),
  fees: vi.fn(),
  parent: vi.fn(),
  broadcast: vi.fn(),
}))
vi.mock('./connectorWithdrawal', () => ({
  connectorContract: mocks.contract,
  connectorIdentity: () => ({ enrollmentDigest: 'pinned' }),
}))
vi.mock('./esplora', () => ({
  fetchAddressUtxos: mocks.coins,
  fetchFeeEstimates: mocks.fees,
  fetchTxHex: mocks.parent,
  broadcastTx: mocks.broadcast,
}))
const status = { network: 'mainnet', vaultId: 'funding-test' } as VaultStatus
const key = new Uint8Array(32).fill(3)
let source: string
let reserveCoin: { txid: string; vout: number; value: number; status: { confirmed: boolean } }
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  const v = vectors[0]
  const spendingPolicy = defaultSpendingPolicy('mainnet')
  const contract = {
    vaultId: 'funding-test',
    network: 'mainnet' as const,
    connectorType: 'p2wpkh' as const,
    phonePub: v.phone,
    hardwarePub: v.hardware,
    phoneDirectP256: v.phoneDirect,
    vaultCosignerBase: v.guardian,
    arkadeCosignerBase: v.emulator,
    protectionTier: 'standard' as const,
    spendingPolicy,
    absoluteFeeCapSats: spendingPolicy.absoluteFeeCapSats,
    feerateCapSatPerV: spendingPolicy.feerateCapSatPerV,
  }
  mocks.contract.mockReturnValue(contract)
  const family = buildConnectorFamily(contract)
  const payment = p2wpkh(secp256k1.getPublicKey(key))
  const parent = new Transaction()
  parent.addInput({ txid: '11'.repeat(32), index: 0 })
  parent.addOutput({ amount: 100000n, script: payment.script })
  const tx = new Transaction()
  tx.addInput({ txid: parent.id, index: 0, witnessUtxo: { amount: 100000n, script: payment.script }, sighashType: 1 })
  tx.addOutput({ amount: 99800n, script: family.savings.script })
  source = hex.encode(tx.toPSBT())
  mocks.parent.mockResolvedValue(hex.encode(parent.toBytes(true, true)))
  mocks.coins.mockResolvedValue([])
  mocks.fees.mockResolvedValue({ '3': 2 })
  reserveCoin = { txid: '44'.repeat(32), vout: 1, value: 1000, status: { confirmed: true } }
  let queue = Promise.resolve<unknown>(undefined)
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, _options: unknown, run: () => unknown) => {
        const next = queue.then(run)
        queue = next.catch(() => undefined)
        return next
      },
    },
  })
})
it('persists before export and broadcasts identical bytes after response loss and reload', async () => {
  const saved = await createFunding(status, source)
  expect(loadFunding(status)?.prepared.psbt).toBe(saved.prepared.psbt)
  const tx = Transaction.fromPSBT(hex.decode(saved.prepared.psbt))
  tx.sign(key)
  mocks.broadcast.mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(saved.prepared.txid)
  await expect(submitFunding(status, hex.encode(tx.toPSBT()))).rejects.toThrow('response lost')
  const retained = loadFunding(status)!
  expect(retained.draft.signed).toBeTruthy()
  expect(retained.draft.submitted).not.toBe(true)
  await expect(submitFunding(status, '')).resolves.toBe(saved.prepared.txid)
  expect(mocks.broadcast.mock.calls[0]).toEqual(mocks.broadcast.mock.calls[1])
  expect(loadFunding(status)?.draft.submitted).toBe(true)
})
it('serializes simultaneous preparations and keeps the original deposit', async () => {
  const results = await Promise.allSettled([createFunding(status, source), createFunding(status, source)])
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
})
it('uses an existing confirmed reserve and waits for a pending one', async () => {
  mocks.coins.mockResolvedValue([{ ...reserveCoin, status: { confirmed: false } }])
  await expect(createFunding(status, source)).rejects.toThrow(/pending/)
  expect(loadFunding(status)).toBeNull()
  mocks.coins.mockResolvedValue([reserveCoin])
  expect((await createFunding(status, source)).prepared.reserve).toBe(0)
})
it('retains the deposit until its exact transaction confirms', async () => {
  const saved = await createFunding(status, source)
  const fetcher = vi.spyOn(globalThis, 'fetch')
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ confirmed: false })))
  await expect(finishFunding(status)).rejects.toThrow(/confirmation/)
  expect(loadFunding(status)).not.toBeNull()
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ confirmed: true })))
  expect(await finishFunding(status)).toBe(saved.prepared.txid)
  expect(loadFunding(status)).toBeNull()
  expect(fetcher).toHaveBeenLastCalledWith(`/esplora/tx/${saved.prepared.txid}/status`, { cache: 'no-store' })
  fetcher.mockRestore()
})

it('archives an abandoned transaction without pretending to cancel it', async () => {
  const saved = await createFunding(status, source)
  await abandonFunding(status)
  expect(loadFunding(status)).toBeNull()
  const archiveKey = Object.keys(localStorage).find((key) => key.includes(':abandoned:'))!
  expect(JSON.parse(localStorage.getItem(archiveKey)!).request).toEqual(saved.draft.request)
  expect(mocks.broadcast).not.toHaveBeenCalled()
  expect((await createFunding(status, source)).prepared.txid).toBe(saved.prepared.txid)
})
