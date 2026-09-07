import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hex, base64 } from '@scure/base'
import { Address, OutScript, Transaction } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { vaultAddressNetwork } from './addressNetwork'
import { defaultSpendingPolicy } from './spendingPolicy'
import { buildConnectorFamily, CONNECTOR_TEMPLATE } from './program/connector'
import {
  preparePendingConnectorOperation,
  loadPendingConnectorOperation,
  connectorStoreKey,
  loadConnectorHistory,
} from './program/connectorStore'
import {
  approveConnectorWithdrawal,
  completeConnectorWithdrawal,
  connectorHandoff,
  reconcileConnectorWithdrawal,
} from './connectorWithdrawal'
import type { VaultStatus } from './types'
import type { EnrollmentSecrets } from './tenantEnrollment'
import vectors from './program/connector-vectors.json'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  begin: vi.fn(),
  decrypt: vi.fn(),
  broadcast: vi.fn(),
  pin: vi.fn(),
}))
vi.mock('./api', () => ({ vaultGet: mocks.get, vaultPost: mocks.post }))
vi.mock('./signIn', () => ({ beginPasskeySession: mocks.begin, decryptPhoneSecret: mocks.decrypt }))
vi.mock('./esplora', () => ({
  broadcastTx: mocks.broadcast,
  fetchAddressUtxos: vi.fn(),
  fetchTxHex: vi.fn(),
  fetchFeeEstimates: vi.fn(),
}))
vi.mock('./program/connectorEnroll', () => ({ loadConnectorEnrollmentPin: mocks.pin, verifyConnectorStatus: vi.fn() }))
const v = vectors[0]
const p = v.payments[0]
const expected = { vaultId: 'connector-family-fixture', enrollmentDigest: v.enrollmentDigest }
const status = { vaultId: expected.vaultId, templateVersion: CONNECTOR_TEMPLATE } as VaultStatus
const enrollment = {
  vaultId: expected.vaultId,
  credId: 'ab',
  nonce: 'fixture',
  ciphertext: 'fixture',
} as EnrollmentSecrets
const operationId = '12'.repeat(16)
const OPTIONS = { allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true }

async function prepare() {
  const network = v.network === 'mainnet' ? 'mainnet' : 'mutinynet'
  const spendingPolicy = defaultSpendingPolicy(network)
  return preparePendingConnectorOperation(
    {
      contract: {
        vaultId: expected.vaultId,
        network,
        connectorType: v.connectorType === 'p2tr' ? 'p2tr' : 'p2wpkh',
        phonePub: v.phone,
        hardwarePub: v.hardware,
        phoneDirectP256: v.phoneDirect,
        vaultCosignerBase: v.guardian,
        arkadeCosignerBase: v.emulator,
        protectionTier: 'standard',
        spendingPolicy,
        absoluteFeeCapSats: spendingPolicy.absoluteFeeCapSats,
        feerateCapSatPerV: spendingPolicy.feerateCapSatPerV,
      },
      origin: { publicKey: v.hardware, fingerprint: v.originFingerprint, path: v.originPath },
      savings: { parentHex: p.parent, txid: p.parentTxid, vout: 0 },
      reserve: { parentHex: p.parent, txid: p.parentTxid, vout: 1 },
      recipient: Address(vaultAddressNetwork(network)).encode(OutScript.decode(hex.decode(p.recipientScript))),
      amountSats: p.amount,
      feeSats: p.fee,
    },
    expected,
    localStorage,
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  // These tests issue operations sequentially. Cross-tab exclusion is tested
  // by the real shared fake lock in connectorStore.test.ts.
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (name: string, _options: unknown, callback: (lock: { name: string }) => unknown) =>
        callback({ name }),
    },
  })
  mocks.pin.mockReturnValue(expected)
  mocks.begin.mockImplementation(async () => ({
    prf: new Uint8Array(32),
    scalar: new Uint8Array(32),
    assertion: { challengeId: 'fixture' },
  }))
  mocks.decrypt.mockImplementation(async () => {
    const key = new Uint8Array(32)
    key[31] = 3
    return key
  })
  mocks.post.mockImplementation(async (_path: string, body: { psbt: string }) => {
    const pending = (await loadPendingConnectorOperation(expected, localStorage))!
    const family = buildConnectorFamily(pending.record.contract)
    const tx = Transaction.fromPSBT(hex.decode(body.psbt), OPTIONS)
    const leafHash = tapLeafHash(family.savings.normal)
    const sigs = tx.getInput(0).tapScriptSig!
    for (const [index, pub] of [family.normalTweaks.arkade, family.normalTweaks.vault].entries()) {
      sigs.push([{ pubKey: hex.decode(pub.slice(2)), leafHash }, hex.decode(p.savingsWitness[index])])
    }
    tx.updateInput(0, { tapScriptSig: sigs })
    return { operationId, signedPsbt: base64.encode(tx.toPSBT()) }
  })
  mocks.get.mockResolvedValue({
    operationId,
    candidateTxid: p.txid,
    phase: 'emulator_signed',
    resolution: 'none',
    verified: true,
  })
  mocks.broadcast.mockResolvedValue(p.txid)
})

describe('Savings connector coordinator', () => {
  it('uses one passkey ceremony and verifies the external signature without a second approval', async () => {
    const candidate = await prepare()
    const approved = await approveConnectorWithdrawal(status, enrollment, candidate.candidateTxid)
    expect(mocks.begin).toHaveBeenCalledExactlyOnceWith(
      'connector-withdraw',
      status,
      enrollment.credId,
      candidate.candidateTxid,
    )
    expect(connectorHandoff(approved)).toMatch(/^70736274/)
    const txid = await completeConnectorWithdrawal(status, candidate.candidateTxid, p.responsePSBT)
    expect(txid).toBe(p.txid)
    expect(mocks.begin).toHaveBeenCalledTimes(1)
    const saved = (await loadPendingConnectorOperation(expected, localStorage))!
    expect(saved.record.signedTxHex).toBeTruthy()
    expect(saved.record.operationId).toBe(operationId)
  })
  it('retries identical phone bytes after response loss', async () => {
    const candidate = await prepare()
    const complete = mocks.post.getMockImplementation()!
    mocks.post.mockRejectedValueOnce(new Error('lost response')).mockImplementation(complete)
    await expect(approveConnectorWithdrawal(status, enrollment, candidate.candidateTxid)).rejects.toThrow(
      'lost response',
    )
    const first = mocks.post.mock.calls[0][1].psbt
    await approveConnectorWithdrawal(status, enrollment, candidate.candidateTxid)
    expect(mocks.post.mock.calls[1][1].psbt).toBe(first)
    expect(mocks.decrypt).toHaveBeenCalledTimes(1)
  })
  it('keeps the verified raw transaction on a broadcast timeout and rebroadcasts those bytes', async () => {
    const candidate = await prepare()
    await approveConnectorWithdrawal(status, enrollment, candidate.candidateTxid)
    mocks.broadcast.mockRejectedValueOnce(new Error('timeout'))
    await expect(completeConnectorWithdrawal(status, candidate.candidateTxid, p.responsePSBT)).rejects.toThrow(
      'timeout',
    )
    const saved = (await loadPendingConnectorOperation(expected, localStorage))!
    await completeConnectorWithdrawal(status, candidate.candidateTxid, saved.record.signedTxHex!)
    expect(mocks.broadcast.mock.calls[0][0]).toBe(mocks.broadcast.mock.calls[1][0])
    expect(mocks.begin).toHaveBeenCalledTimes(1)
  })
  it('does not release on stale confirmation, outage, or mismatched operation identity', async () => {
    const candidate = await prepare()
    await approveConnectorWithdrawal(status, enrollment, candidate.candidateTxid)
    mocks.get.mockResolvedValue({
      operationId,
      candidateTxid: candidate.candidateTxid,
      resolution: 'confirmed',
      verified: false,
    })
    expect(await reconcileConnectorWithdrawal(status)).not.toBeNull()
    mocks.get.mockRejectedValue(new Error('offline'))
    await expect(reconcileConnectorWithdrawal(status)).rejects.toThrow('offline')
    expect(localStorage.getItem(connectorStoreKey(expected.vaultId))).not.toBeNull()
    mocks.get.mockResolvedValue({
      operationId,
      candidateTxid: 'ff'.repeat(32),
      resolution: 'confirmed',
      verified: true,
    })
    await expect(reconcileConnectorWithdrawal(status)).rejects.toThrow('does not match')
  })
  it('archives only a freshly verified terminal operation and preserves its transaction', async () => {
    const candidate = await prepare()
    await approveConnectorWithdrawal(status, enrollment, candidate.candidateTxid)
    mocks.get.mockResolvedValue({
      operationId,
      candidateTxid: candidate.candidateTxid,
      resolution: 'confirmed',
      verified: true,
    })
    expect(await reconcileConnectorWithdrawal(status)).toBeNull()
    expect(localStorage.getItem(connectorStoreKey(expected.vaultId))).toBeNull()
    const history = await loadConnectorHistory(expected, localStorage)
    expect(history).toHaveLength(1)
    expect(history[0].candidateTxid).toBe(candidate.candidateTxid)
    expect(history[0].record.savingsWitness).toBeTruthy()
  })
})
