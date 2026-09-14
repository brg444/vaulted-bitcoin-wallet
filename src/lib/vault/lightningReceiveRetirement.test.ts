import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ArkAddress, Transaction, VHTLC } from '@arkade-os/sdk'
import {
  InMemoryAssetSwapRepository,
  receiveVtxoScript,
  unilateralClaimDelay,
  type RfqQuote,
  type RfqTransport,
  type RfqSwapRecord,
} from '@arkade-os/swap'
import { base64, bech32, hex } from '@scure/base'
import { compressedFromScalar } from './program/fixtures'
import { memoryContracts } from './lightningTestUtils'
import { BITCOIN_LIGHTNING_SOLVER } from './lightningConfig'
import { requestVaultLightningReceive, receiveProfile } from './lightningReceive'
import { acknowledgeVaultLightningReceiveRecovery, reconcileVaultLightningReceives } from './lightningReceiveClaim'
import { listRetiredReceiveActivityRecords, listSettledVaultLightningRecords } from './lightningLifecycle'
import { readRetiredLightningReceive } from './lightningEvidence'
import { retiredReceiveBindsEntry } from './recovery/lightningArchive'
import { networkPins } from './networkPins'
import type { VaultStatus } from './types'

const evidenceState = vi.hoisted(() => ({ evidence: null as unknown, reads: 0 }))
vi.mock('./recovery/committedCoverage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recovery/committedCoverage')>()
  return {
    ...actual,
    readCommittedRecoveryEvidence: async () => {
      evidenceState.reads++
      return evidenceState.evidence
    },
  }
})

const fateState = vi.hoisted(() => ({ fate: null as unknown }))
vi.mock('@arkade-os/swap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/swap')>()
  return { ...actual, readLockupFate: async () => fateState.fate }
})

const outpointState = vi.hoisted(() => ({ vtxos: [] as unknown[] }))
vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/sdk')>()
  return {
    ...actual,
    RestIndexerProvider: class {
      constructor(...args: unknown[]) {
        void args
      }
      getVtxos = async () => ({ vtxos: outpointState.vtxos })
      getVirtualTxs = async () => ({ txs: [] })
    },
  }
})

const NOW = 1_788_880_000
const pins = networkPins('mainnet')
const DESCRIPTOR = 'aa'.repeat(32)
const DIGEST = 'bb'.repeat(32)

function invoice(hash: string, sats: number) {
  const words = Array.from({ length: 7 }, (_, i) => Math.floor(NOW / 32 ** (6 - i)) % 32)
  words.push(1, 1, 20, ...bech32.toWords(hex.decode(hash)), ...Array(104).fill(0))
  return bech32.encode(`lnbc${sats * 10000}p`, words, 2000)
}

async function harness() {
  const payout = new ArkAddress(
    hex.decode(pins.operatorSignerPub).slice(1),
    ArkAddress.decode(
      new ArkAddress(hex.decode(pins.operatorSignerPub).slice(1), new Uint8Array(32).fill(2), 'ark').encode(),
    ).vtxoTaprootKey,
    'ark',
  ).encode()
  const status = {
    enrolled: true,
    vaultId: 'aa'.repeat(32),
    network: 'mainnet',
    phoneBip340Pub: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    spendingArkAddress: payout,
    spendingArkScript: hex.encode(ArkAddress.decode(payout).pkScript),
    arkadeCosignerOrigin: 'urn:vaulted:mainnet-signer:v1',
  } as VaultStatus
  const { contracts, rows } = memoryContracts()
  const repository = new InMemoryAssetSwapRepository()
  const transport = {
    requestQuote: vi.fn(async (request) => {
      const p = request.profile
      const quote: RfqQuote = {
        v: 1,
        type: 'rfq_quote',
        rfq_id: request.rfq_id,
        pair: request.pair,
        amount_side: 'to',
        from_amount: 1004,
        to_amount: 1000,
        solver_pubkey: compressedFromScalar(5).slice(2),
        valid_until: NOW + 300,
        refund_locktime: NOW + 3600,
        profile: { invoice: invoice(p.payment_hash, 1004), solver_refund_pk_script: status.spendingArkScript },
      }
      const eight = receiveVtxoScript({
        solverPubkey: hex.decode(quote.solver_pubkey),
        refundLocktime: quote.refund_locktime!,
        serverPubkey: hex.decode(pins.operatorSignerPub).slice(1),
        paymentHash: p.payment_hash,
        claimDelay: unilateralClaimDelay(605184),
        emulatorPubkey: hex.decode(pins.emulatorSignerPub).slice(1),
        solverRefundPkScript: hex.decode(status.spendingArkScript!),
        payoutPubkey: hex.decode(p.payout_pubkey),
        payoutPkScript: ArkAddress.decode(p.payout_address).pkScript,
      })
      const script = new VHTLC.ScriptV2({
        ...eight.options,
        nonInteractiveRefund: { ...eight.options.nonInteractiveRefund!, withoutReceiver: true },
      })
      quote.profile!.lockup_address = script.address('ark', hex.decode(pins.operatorSignerPub).slice(1)).encode()
      return quote
    }),
    close: vi.fn(),
  } as unknown as RfqTransport
  const request = () =>
    requestVaultLightningReceive({
      status,
      amountSats: 1000,
      profile: BITCOIN_LIGHTNING_SOLVER,
      transport,
      repository,
      contracts,
      operatorInfo: { network: 'bitcoin', signerPubkey: pins.operatorSignerPub, unilateralExitDelay: 605184 },
      now: NOW,
    })
  return { status, repository, contracts, rows, request }
}

function installImmediateLock() {
  const original = (navigator as Navigator & { locks?: unknown }).locks
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => callback({}),
    },
  })
  return () => {
    if (original) Object.defineProperty(navigator, 'locks', { configurable: true, value: original })
    else Reflect.deleteProperty(navigator, 'locks')
  }
}

/** Produce a settled receive record with a real saved claim. */
async function settledReceive() {
  const h = await harness()
  const record = await h.request()
  const contract = [...h.rows.values()][0]
  const parent = new Transaction({ version: 3, allowUnknownInputs: true, allowUnknownOutputs: true })
  parent.addInput({ txid: '11'.repeat(32), index: 0 })
  parent.addOutput({ amount: 1000n, script: hex.decode(contract.script) })
  const coin = {
    txid: parent.id,
    vout: 0,
    value: 1000,
    script: contract.script,
    createdAt: new Date(),
    isPreconfirmed: true,
    isUnrolled: false,
    virtualStatus: 'preconfirmed',
  }
  let funding = [coin]
  let payout: typeof funding = []
  const indexer = {
    getVtxos: vi.fn(async (q: { scripts: string[] }) => ({
      vtxos: q.scripts[0] === contract.script ? funding : payout,
    })),
    getVirtualTxs: vi.fn(async () => ({ txs: [base64.encode(parent.toPSBT())] })),
  }
  const operator = {
    getInfo: vi.fn(async () => ({
      network: 'bitcoin',
      signerPubkey: pins.operatorSignerPub,
      checkpointTapscript: pins.checkpointTapscript,
    })),
  }
  const emulator = {
    getInfo: vi.fn(async () => ({ signerPubkey: pins.emulatorSignerPub })),
    submitTx: vi.fn(async () => {
      throw new Error('response lost')
    }),
  }
  const run = () =>
    reconcileVaultLightningReceives({
      status: h.status,
      repository: h.repository,
      contracts: h.contracts as never,
      indexer: indexer as never,
      operator: operator as never,
      emulator: emulator as never,
    })
  await expect(run()).rejects.toThrow('response lost')
  const saved = (await h.repository.getRfqSwap(record.rfqId))!
  const claim = receiveProfile(saved).claim!
  payout = [{ ...coin, txid: claim.txid, script: h.status.spendingArkScript! }]
  funding = []
  await run()
  const settled = (await h.repository.getRfqSwap(record.rfqId))!
  expect(settled.state).toBe('settled')
  return { h, contract, settled: settled as RfqSwapRecord, claim }
}

function historyFor(claimTxid: string) {
  return [{ account: 'spend', type: 'received', txid: claimTxid, amount: 1000 }] as never
}

/** The caller supplies only the coverage half; the predicate re-reads the full
 * evidence from the committed store. */
function coverageOf() {
  return (evidenceState.evidence as { coverage: unknown }).coverage as never
}

function checkpointOutpoint(raw: string) {
  const checkpoint = Transaction.fromPSBT(base64.decode(raw))
  const input = checkpoint.getInput(0)
  return { txid: hex.encode(input.txid!), vout: input.index as number }
}

function armAccept(f: Awaited<ReturnType<typeof settledReceive>>) {
  const outpoint = checkpointOutpoint(f.claim.checkpoints[0])
  outpointState.vtxos = [{ ...outpoint, spentBy: 'aa'.repeat(32) }]
  const checkpointId = Transaction.fromPSBT(base64.decode(f.claim.checkpoints[0])).id
  fateState.fate = {
    fate: 'claimed',
    preimage: new Uint8Array(32),
    spends: [{ checkpointTxid: checkpointId, arkTxid: f.claim.txid }],
  }
  evidenceState.evidence = {
    coverage: {
      vaultId: f.h.status.vaultId,
      network: f.h.status.network,
      descriptorHash: DESCRIPTOR,
      fileDigest: DIGEST,
      outputs: [{ txid: f.claim.txid, vout: 0, value: 1000, script: f.h.status.spendingArkScript }],
    },
    matureBoardingJournal: null,
    lightningJournal: {
      name: 'vaulted-lightning-recovery',
      version: 1,
      binding: {
        vaultId: f.h.status.vaultId,
        network: f.h.status.network,
        phonePub: f.h.status.phoneBip340Pub,
        descriptorHash: DESCRIPTOR,
        spendingScript: f.h.status.spendingArkScript,
      },
      entries: [
        {
          record: f.settled,
          contract: {
            script: hex.encode(ArkAddress.decode(f.settled.lockupAddress).pkScript),
            address: f.settled.lockupAddress,
          },
          exit: {},
        },
      ],
    },
  } as never
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
  localStorage.clear()
  evidenceState.evidence = null
  evidenceState.reads = 0
  fateState.fate = null
  outpointState.vtxos = []
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Lightning receive retirement predicate', () => {
  it('retires a settled receive when receipt, history, claim, outpoints, fate and coverage agree', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      armAccept(f)
      expect(await listSettledVaultLightningRecords(f.h.repository)).toEqual([f.settled.rfqId])
      const retired = await acknowledgeVaultLightningReceiveRecovery(
        f.h.status,
        f.h.repository,
        f.settled.rfqId,
        historyFor(f.claim.txid),
        coverageOf(),
      )
      expect(retired).toBe(true)
      expect(await f.h.repository.getRfqSwap(f.settled.rfqId)).toBeUndefined()
      const receipt = readRetiredLightningReceive(f.settled.rfqId)
      expect(receipt).toMatchObject({
        claimArkTxid: f.claim.txid,
        amountSats: 1000,
        displayAmount: 1000,
        fee: 4,
        state: 'settled',
        network: 'mainnet',
        vaultId: f.h.status.vaultId,
        descriptorHash: DESCRIPTOR,
        fileDigest: DIGEST,
      })
      expect(receipt).not.toHaveProperty('preimageHex')
    } finally {
      restore()
    }
  })

  it('refuses a pending receive', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      const pending = { ...f.settled, state: 'pending' } as RfqSwapRecord
      await f.h.repository.saveRfqSwap(pending)
      armAccept(f)
      expect(
        await acknowledgeVaultLightningReceiveRecovery(
          f.h.status,
          f.h.repository,
          f.settled.rfqId,
          historyFor(f.claim.txid),
          coverageOf(),
        ),
      ).toBe(false)
      expect(await f.h.repository.getRfqSwap(f.settled.rfqId)).not.toBeNull()
    } finally {
      restore()
    }
  })

  it('refuses when the wallet history lacks the payout row', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      armAccept(f)
      expect(
        await acknowledgeVaultLightningReceiveRecovery(
          f.h.status,
          f.h.repository,
          f.settled.rfqId,
          [] as never,
          coverageOf(),
        ),
      ).toBe(false)
    } finally {
      restore()
    }
  })

  it('refuses a stale committed snapshot loaded after a replacement', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      armAccept(f)
      const stale = structuredClone(coverageOf()) as { fileDigest: string }
      stale.fileDigest = 'cc'.repeat(32)
      expect(
        await acknowledgeVaultLightningReceiveRecovery(
          f.h.status,
          f.h.repository,
          f.settled.rfqId,
          historyFor(f.claim.txid),
          stale as never,
        ),
      ).toBe(false)
    } finally {
      restore()
    }
  })

  it('refuses when the committed coverage omits the claim payout', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      armAccept(f)
      ;(evidenceState.evidence as { coverage: { outputs: unknown[] } }).coverage.outputs = []
      expect(
        await acknowledgeVaultLightningReceiveRecovery(
          f.h.status,
          f.h.repository,
          f.settled.rfqId,
          historyFor(f.claim.txid),
          coverageOf(),
        ),
      ).toBe(false)
    } finally {
      restore()
    }
  })

  it('refuses when an original outpoint is unconsumed', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      armAccept(f)
      const outpoint = checkpointOutpoint(f.claim.checkpoints[0])
      outpointState.vtxos = [{ ...outpoint }]
      expect(
        await acknowledgeVaultLightningReceiveRecovery(
          f.h.status,
          f.h.repository,
          f.settled.rfqId,
          historyFor(f.claim.txid),
          coverageOf(),
        ),
      ).toBe(false)
    } finally {
      restore()
    }
  })

  it('refuses a wrong or unclaimed fate', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      armAccept(f)
      fateState.fate = { fate: 'open' }
      expect(
        await acknowledgeVaultLightningReceiveRecovery(
          f.h.status,
          f.h.repository,
          f.settled.rfqId,
          historyFor(f.claim.txid),
          coverageOf(),
        ),
      ).toBe(false)
    } finally {
      restore()
    }
  })

  it('refuses a record rewritten during observation', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      armAccept(f)
      const changed = { ...f.settled, amount: 999, updatedAt: NOW + 5 } as RfqSwapRecord
      await f.h.repository.saveRfqSwap(changed)
      expect(
        await acknowledgeVaultLightningReceiveRecovery(
          f.h.status,
          f.h.repository,
          f.settled.rfqId,
          historyFor(f.claim.txid),
          coverageOf(),
        ),
      ).toBe(false)
      expect(await f.h.repository.getRfqSwap(f.settled.rfqId)).not.toBeNull()
    } finally {
      restore()
    }
  })

  it('is idempotent and keeps a single receipt', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      armAccept(f)
      expect(
        await acknowledgeVaultLightningReceiveRecovery(
          f.h.status,
          f.h.repository,
          f.settled.rfqId,
          historyFor(f.claim.txid),
          coverageOf(),
        ),
      ).toBe(true)
      expect(
        await acknowledgeVaultLightningReceiveRecovery(
          f.h.status,
          f.h.repository,
          f.settled.rfqId,
          historyFor(f.claim.txid),
          coverageOf(),
        ),
      ).toBe(false)
      expect(listRetiredReceiveActivityRecords({ vaultId: f.h.status.vaultId, network: 'mainnet' })).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('keeps the journal when the receipt cannot be written', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      armAccept(f)
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota')
      })
      await expect(
        acknowledgeVaultLightningReceiveRecovery(
          f.h.status,
          f.h.repository,
          f.settled.rfqId,
          historyFor(f.claim.txid),
          coverageOf(),
        ),
      ).rejects.toThrow()
      setItem.mockRestore()
      expect(await f.h.repository.getRfqSwap(f.settled.rfqId)).not.toBeNull()
      expect(readRetiredLightningReceive(f.settled.rfqId)).toBeNull()
    } finally {
      restore()
    }
  })

  it('projects a retired receipt as a labeled received history record', async () => {
    const restore = installImmediateLock()
    try {
      const f = await settledReceive()
      armAccept(f)
      await acknowledgeVaultLightningReceiveRecovery(
        f.h.status,
        f.h.repository,
        f.settled.rfqId,
        historyFor(f.claim.txid),
        coverageOf(),
      )
      const rows = listRetiredReceiveActivityRecords({ vaultId: f.h.status.vaultId, network: 'mainnet' })
      expect(rows).toEqual([
        {
          type: 'received',
          rfqId: f.settled.rfqId,
          fundingTxid: f.claim.txid,
          state: 'settled',
          amount: 1000,
          displayAmount: 1000,
          fee: 4,
          createdAt: f.settled.createdAt,
          terminal: true,
        },
      ])
    } finally {
      restore()
    }
  })
})

describe('Lightning receive retirement restore guard', () => {
  it('suppresses only an exact claim-bound receipt and restores conservatively otherwise', async () => {
    const f = await settledReceive()
    const profile = receiveProfile(f.settled)
    const lockupScript = hex.encode(ArkAddress.decode(f.settled.lockupAddress).pkScript)
    const binding = {
      vaultId: f.h.status.vaultId,
      network: f.h.status.network,
      phonePub: f.h.status.phoneBip340Pub!,
      descriptorHash: DESCRIPTOR,
      spendingScript: f.h.status.spendingArkScript!,
    }
    const base = {
      rfqId: f.settled.rfqId,
      claimArkTxid: f.claim.txid,
      lockupAddress: f.settled.lockupAddress,
      lockupPkScriptHex: lockupScript,
      amountSats: f.settled.amount!,
      displayAmount: f.settled.amount!,
      fee: 4,
      payoutAddress: profile.payoutAddress,
      payoutPkScriptHex: hex.encode(ArkAddress.decode(profile.payoutAddress).pkScript),
      state: 'settled',
      createdAt: f.settled.createdAt,
      network: f.h.status.network,
      vaultId: f.h.status.vaultId,
      descriptorHash: DESCRIPTOR,
      fileDigest: DIGEST,
      retiredAt: f.settled.createdAt + 1,
    }
    expect(retiredReceiveBindsEntry(base as never, f.settled, binding)).toBe(true)
    expect(retiredReceiveBindsEntry({ ...base, rfqId: 'ee'.repeat(32) } as never, f.settled, binding)).toBe(false)
    expect(retiredReceiveBindsEntry({ ...base, vaultId: 'other-vault' } as never, f.settled, binding)).toBe(false)
    expect(retiredReceiveBindsEntry({ ...base, network: 'mutinynet' } as never, f.settled, binding)).toBe(false)
    expect(retiredReceiveBindsEntry({ ...base, descriptorHash: 'cc'.repeat(32) } as never, f.settled, binding)).toBe(
      false,
    )
    expect(retiredReceiveBindsEntry({ ...base, claimArkTxid: 'dd'.repeat(32) } as never, f.settled, binding)).toBe(
      false,
    )
    expect(
      retiredReceiveBindsEntry(
        { ...base, payoutAddress: 'tark1elsewhere', payoutPkScriptHex: '5120' + '00'.repeat(32) } as never,
        f.settled,
        binding,
      ),
    ).toBe(false)
    expect(retiredReceiveBindsEntry({ ...base, amountSats: 999 } as never, f.settled, binding)).toBe(false)
    // An unclaimed precursor restores conservatively rather than being suppressed.
    const vaultLightningReceive = {
      ...(f.settled.profile as { vaultLightningReceive: Record<string, unknown> }).vaultLightningReceive,
    }
    delete vaultLightningReceive.claim
    const noClaim = {
      ...f.settled,
      profile: { ...f.settled.profile, vaultLightningReceive },
    } as RfqSwapRecord
    expect(retiredReceiveBindsEntry(base as never, noClaim, binding)).toBe(false)
  })
})
