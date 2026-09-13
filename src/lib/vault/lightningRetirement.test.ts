import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { base64, hex } from '@scure/base'
import type { RfqSwap, RfqSwapRecord } from '@arkade-os/swap'
import { Transaction } from '@arkade-os/sdk'
import type { VaultStatus } from './types'
import { acknowledgeSettledVaultLightning, acknowledgeVaultLightningRecovery } from './spendingPayments'
import {
  beginVaultLightningFunding,
  createVaultLightningObserver,
  durableVaultLightningRefund,
  isFundedLightningRecord,
  listFundedTerminalLightningRecords,
  readLightningRecoveryAcknowledgment,
  recordingVaultLightningRefundArk,
  recordVaultLightningFundingTxid,
  type VaultLightningRefundRecorder,
} from './lightningLifecycle'
import {
  mergeLightningRefundAttempts,
  readLightningRefundAttempt,
  recordRefundAttemptProgress,
  sameCheckpointGraph,
  seedRestoredRefundAttempt,
  validateLightningRefundGraph,
  type VaultLightningRefundAttempt,
  type VaultLightningRefundFacts,
} from './lightningEvidence'
import { readCommittedRecoveryCoverage } from './recovery/committedCoverage'
import { INVOICE_TIMESTAMP, emptyIndexer, lightningQuoteHarness } from './lightningTestUtils'
import { lightningRefundPackageFixture } from './testdata/lightningRefundFixture'

vi.mock('./recovery/committedCoverage', () => ({ readCommittedRecoveryCoverage: vi.fn() }))

/** The owner fate read builds its own indexer, so tests stand in a canned
 * lockup observation without touching the package manager's own indexer. */
const fateState = vi.hoisted(() => ({
  checkpointTxid: '',
  checkpointPsbt: '',
  arkTxid: undefined as string | undefined,
}))
vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/sdk')>()
  return {
    ...actual,
    RestIndexerProvider: class {
      constructor(...args: unknown[]) {
        void args
      }
      getVtxos = async () => ({
        vtxos: [
          {
            txid: 'ee'.repeat(32),
            vout: 0,
            spentBy: fateState.checkpointTxid,
            ...(fateState.arkTxid ? { arkTxId: fateState.arkTxid } : {}),
          },
        ],
      })
      getVirtualTxs = async () => ({ txs: [fateState.checkpointPsbt] })
    },
  }
})

const FUNDING_TXID = 'bb'.repeat(32)
const REFUND_TXID = 'cc'.repeat(32)
const SCRIPT = '5120' + 'ab'.repeat(32)
const OLD_NOW = INVOICE_TIMESTAMP + 3 + 31 * 24 * 60 * 60

function lightningStatus(): VaultStatus {
  return { vaultId: 'vault-lightning', network: 'bitcoin', spendingArkScript: SCRIPT } as unknown as VaultStatus
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

async function fundedHarness(state: 'pending' | 'settled' | 'refunded' | 'failed', rfqId: string) {
  const harness = await lightningQuoteHarness({ rfqId })
  const quote = await harness.request()
  const proof = {
    rfqId: quote.rfqId,
    address: quote.fundAddress,
    amountSats: quote.fundAmountSats,
    operationId: '11'.repeat(16),
    bundleDigest: 'aa'.repeat(32),
    fundingFeeSats: 25,
  }
  await beginVaultLightningFunding(harness.repository, quote.rfqId, proof, INVOICE_TIMESTAMP + 2)
  await recordVaultLightningFundingTxid(harness.repository, quote.rfqId, FUNDING_TXID)
  const saved = (await harness.repository.getRfqSwap(quote.rfqId))!
  await harness.repository.saveRfqSwap({
    ...saved,
    state,
    ...(state === 'refunded' ? { refundArkTxid: REFUND_TXID } : {}),
    updatedAt: INVOICE_TIMESTAMP + 3,
  })
  const stored = (await harness.repository.getRfqSwap(quote.rfqId))!
  expect(isFundedLightningRecord(stored)).toBe(true)
  return { harness, quote, proof }
}

function historyFor(fundingTxid: string) {
  return [{ account: 'spend', type: 'sent', txid: fundingTxid, amount: 2125 }] as never
}

function coverageFor(outputs: { txid: string; vout: number; value: number; script: string }[]) {
  return {
    vaultId: 'vault-lightning',
    network: 'bitcoin',
    descriptorHash: 'vault-lightning',
    fileDigest: 'digest-lightning',
    outputs,
  } as never
}

function journalFor(record: RfqSwapRecord) {
  return {
    name: 'vaulted-lightning-recovery',
    version: 1,
    binding: {
      vaultId: 'vault-lightning',
      network: 'bitcoin',
      phonePub: '02'.repeat(32),
      descriptorHash: 'vault-lightning',
      spendingScript: SCRIPT,
    },
    entries: [{ record, contract: {} as never, exit: {} as never }],
  } as never
}

function refundPsbtBytes(txid = 'ee'.repeat(32), vout = 0, valueSats = 2125n) {
  const tx = new Transaction({ version: 2 })
  tx.addInput({ txid, index: vout })
  tx.addOutput({ amount: valueSats, script: hex.decode('ab'.repeat(34)) })
  const psbt = base64.encode(tx.toPSBT())
  return { psbt, txid: tx.id }
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (!needle.length) return -1
  for (let index = 0; index + needle.length <= haystack.length; index++) {
    let match = true
    for (let position = 0; position < needle.length; position++) {
      if (haystack[index + position] !== needle[position]) {
        match = false
        break
      }
    }
    if (match) return index
  }
  return -1
}

function corruptFirstInputSignature(psbt: string): string {
  const tx = Transaction.fromPSBT(base64.decode(psbt))
  const entries = (tx.getInput(0).tapScriptSig as [unknown, Uint8Array][] | undefined) ?? []
  if (!entries.length) throw new Error('test setup has no signatures to corrupt')
  const raw = base64.decode(psbt)
  const at = indexOfBytes(raw, entries[0][1])
  if (at < 0) throw new Error('test setup could not locate the signature')
  const corrupted = Uint8Array.from(raw)
  corrupted[at] ^= 1
  Transaction.fromPSBT(corrupted)
  return base64.encode(corrupted)
}

function neverRecord(): VaultLightningRefundRecorder {
  const refuse = async (): Promise<never> => {
    throw new Error('refund recorder must not dispatch on the fresh path')
  }
  return { submitRefund: refuse, signCheckpoint: refuse, finalizeRefund: refuse }
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  const fateCheckpoint = refundPsbtBytes()
  fateState.checkpointTxid = fateCheckpoint.txid
  fateState.checkpointPsbt = fateCheckpoint.psbt
  fateState.arkTxid = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Lightning funded-record retirement', () => {
  it.each(['pending', 'refunded'] as const)(
    'keeps funded %s recovery data past package retention without owner acknowledgment',
    async (state) => {
      const { harness, quote } = await fundedHarness(state, 'ab'.repeat(32))
      const observer = createVaultLightningObserver({
        repository: harness.repository,
        contracts: harness.contracts,
        indexer: emptyIndexer(),
        managerConfig: { now: () => OLD_NOW },
      })
      const restored = await observer.restoreFromRepository()
      expect(restored.pruned).not.toContain(quote.rfqId)
      expect(await harness.repository.getRfqSwap(quote.rfqId)).not.toBeNull()
    },
  )

  it('leaves unfunded expired quotes to existing cleanup paths', async () => {
    const harness = await lightningQuoteHarness({ rfqId: 'aa'.repeat(32) })
    await harness.request()
    const observer = createVaultLightningObserver({
      repository: harness.repository,
      contracts: harness.contracts,
      indexer: emptyIndexer(),
      managerConfig: { now: () => OLD_NOW },
    })
    const restored = await observer.restoreFromRepository()
    expect(restored.pruned).not.toContain('aa'.repeat(32))
    expect(await harness.repository.getRfqSwap('aa'.repeat(32))).not.toBeNull()
  })

  it('retires a settled funded record when receipt, history, journal, fate and coverage agree', async () => {
    const restoreLock = installImmediateLock()
    try {
      const { harness, quote } = await fundedHarness('settled', 'ab'.repeat(32))
      const saved = (await harness.repository.getRfqSwap(quote.rfqId))!
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverageFor([]))
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          historyFor(FUNDING_TXID),
          journalFor(saved),
          coverageFor([]),
        ),
      ).resolves.toBe(true)
      expect(await harness.repository.getRfqSwap(quote.rfqId)).toBeUndefined()
      expect(readLightningRecoveryAcknowledgment(quote.rfqId)).toMatchObject({
        rfqId: quote.rfqId,
        lockupAddress: quote.fundAddress,
        amountSats: quote.fundAmountSats,
        fundingArkTxid: FUNDING_TXID,
        state: 'settled',
        fileDigest: 'digest-lightning',
        network: 'bitcoin',
        vaultId: 'vault-lightning',
      })
    } finally {
      restoreLock()
    }
  })

  it('retires a refunded record only with the refund successor in coverage', async () => {
    const restoreLock = installImmediateLock()
    try {
      const { harness, quote } = await fundedHarness('refunded', 'ab'.repeat(32))
      const saved = (await harness.repository.getRfqSwap(quote.rfqId))!
      fateState.arkTxid = REFUND_TXID
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverageFor([]))
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          historyFor(FUNDING_TXID),
          journalFor(saved),
          coverageFor([]),
        ),
      ).resolves.toBe(false)
      expect(await harness.repository.getRfqSwap(quote.rfqId)).not.toBeNull()
      const refundCoin = { txid: REFUND_TXID, vout: 0, value: 2100, script: SCRIPT }
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverageFor([refundCoin]))
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          historyFor(FUNDING_TXID),
          journalFor(saved),
          coverageFor([refundCoin]),
        ),
      ).resolves.toBe(true)
      expect(await harness.repository.getRfqSwap(quote.rfqId)).toBeUndefined()
    } finally {
      restoreLock()
    }
  })

  it('retains non-terminal and unfunded records with complete evidence present', async () => {
    const restoreLock = installImmediateLock()
    try {
      const live = await fundedHarness('pending', 'ab'.repeat(32))
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverageFor([]))
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          live.harness.repository,
          live.quote.rfqId,
          historyFor(FUNDING_TXID),
          null,
        ),
      ).resolves.toBe(false)
      expect(await live.harness.repository.getRfqSwap(live.quote.rfqId)).not.toBeNull()
      const { harness, quote } = await fundedHarness('failed', 'cd'.repeat(32))
      const saved = (await harness.repository.getRfqSwap(quote.rfqId))!
      await harness.repository.saveRfqSwap({
        ...saved,
        fundingArkTxid: undefined,
        profile: {
          ...saved.profile,
          vaultLightning: {
            ...(saved.profile as Record<string, { fundingState: string }>).vaultLightning,
            fundingState: 'quoted',
          },
        },
      })
      expect(isFundedLightningRecord((await harness.repository.getRfqSwap(quote.rfqId))!)).toBe(false)
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          historyFor(FUNDING_TXID),
          null,
        ),
      ).resolves.toBe(false)
      expect(await harness.repository.getRfqSwap(quote.rfqId)).not.toBeNull()
    } finally {
      restoreLock()
    }
  })

  it('retains the journal on missing coverage, history, digest match, journal filing or fate', async () => {
    const restoreLock = installImmediateLock()
    try {
      const { harness, quote } = await fundedHarness('settled', 'ab'.repeat(32))
      const saved = (await harness.repository.getRfqSwap(quote.rfqId))!
      const journal = journalFor(saved)
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(null)
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          historyFor(FUNDING_TXID),
          journal,
        ),
      ).resolves.toBe(false)
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverageFor([]))
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          [] as never,
          journal,
          coverageFor([]),
        ),
      ).resolves.toBe(false)
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          historyFor(FUNDING_TXID),
          journal,
          {
            ...(coverageFor([]) as object),
            fileDigest: 'other-digest',
          } as never,
        ),
      ).resolves.toBe(false)
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          historyFor(FUNDING_TXID),
          null,
          coverageFor([]),
        ),
      ).resolves.toBe(false)
      fateState.checkpointPsbt = 'not-a-psbt'
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          historyFor(FUNDING_TXID),
          journal,
          coverageFor([]),
        ),
      ).resolves.toBe(false)
      expect(await harness.repository.getRfqSwap(quote.rfqId)).not.toBeNull()
    } finally {
      restoreLock()
    }
  })

  it('cannot retire a record rewritten during observation', async () => {
    const restoreLock = installImmediateLock()
    try {
      const { harness, quote } = await fundedHarness('settled', 'ab'.repeat(32))
      const saved = (await harness.repository.getRfqSwap(quote.rfqId))!
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverageFor([]))
      const real = harness.repository.getRfqSwap.bind(harness.repository)
      let calls = 0
      vi.spyOn(harness.repository, 'getRfqSwap').mockImplementation(async (id) => {
        calls++
        const record = await real(id)
        if (calls === 2 && record) return { ...record, amount: (record.amount ?? 0) + 1 }
        return record
      })
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          historyFor(FUNDING_TXID),
          journalFor(saved),
          coverageFor([]),
        ),
      ).resolves.toBe(false)
      expect(await harness.repository.getRfqSwap(quote.rfqId)).not.toBeNull()
    } finally {
      restoreLock()
    }
  })

  it('aborts acknowledgment on a cancelled caller without retiring', async () => {
    const restoreLock = installImmediateLock()
    try {
      const { harness, quote } = await fundedHarness('settled', 'ab'.repeat(32))
      const saved = (await harness.repository.getRfqSwap(quote.rfqId))!
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverageFor([]))
      const controller = new AbortController()
      controller.abort()
      await expect(
        acknowledgeVaultLightningRecovery(
          lightningStatus(),
          harness.repository,
          quote.rfqId,
          historyFor(FUNDING_TXID),
          journalFor(saved),
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow()
      expect(await harness.repository.getRfqSwap(quote.rfqId)).not.toBeNull()
    } finally {
      restoreLock()
    }
  })

  it('settles only funded terminals and leaves other records alone', async () => {
    const restoreLock = installImmediateLock()
    try {
      const { harness, quote } = await fundedHarness('settled', 'ab'.repeat(32))
      const saved = (await harness.repository.getRfqSwap(quote.rfqId))!
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverageFor([]))
      const history = historyFor(FUNDING_TXID)
      await expect(
        acknowledgeSettledVaultLightning(
          lightningStatus(),
          harness.repository,
          history,
          journalFor(saved),
          coverageFor([]),
        ),
      ).resolves.toBe(1)
      expect(await harness.repository.getRfqSwap(quote.rfqId)).toBeUndefined()
      expect(await listFundedTerminalLightningRecords(harness.repository)).toEqual([])
    } finally {
      restoreLock()
    }
  })
})

describe('Lightning refund attempt durability', () => {
  const attempt: VaultLightningRefundFacts = {
    rfqId: 'ab'.repeat(32),
    lockupAddress: 'tark1lockup',
    lockupPkScriptHex: 'ab'.repeat(34),
    amountSats: 2125,
    destination: 'tark1spending',
    vaultId: 'vault-lightning',
    network: 'bitcoin',
    senderPub: '11'.repeat(32),
    serverPub: '22'.repeat(32),
  }
  const swap = {
    rfqId: 'ab'.repeat(32),
    state: 'pending',
    lockupPkScript: hex.decode('ab'.repeat(34)),
  } as unknown as RfqSwap

  it('persists the attempt before dispatch and replays the observed result', async () => {
    const inner = vi.fn(async () => ({ arkTxid: 'cc'.repeat(32), amount: 2125 }))
    // A real dispatch records its funded inputs; the result merges over them.
    recordRefundAttemptProgress(
      { ...attempt, fundedInputs: [{ txid: 'ee'.repeat(32), vout: 0, value: 2125 }] },
      'dispatched',
    )
    const refund = durableVaultLightningRefund(attempt, inner, { record: neverRecord() })
    await expect(refund(swap)).resolves.toEqual({ arkTxid: 'cc'.repeat(32), amount: 2125 })
    expect(inner).toHaveBeenCalledTimes(1)
    await expect(refund(swap)).resolves.toEqual({ arkTxid: 'cc'.repeat(32), amount: 2125 })
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('rejects a different operation or changed inputs', async () => {
    const inner = vi.fn(async () => ({ arkTxid: 'cc'.repeat(32), amount: 2125 }))
    const refund = durableVaultLightningRefund(attempt, inner, { record: neverRecord() })
    await expect(refund({ ...swap, rfqId: 'dd'.repeat(32) })).rejects.toThrow('changed operation')
    await expect(refund({ ...swap, lockupPkScript: hex.decode('dd'.repeat(34)) })).rejects.toThrow('lockup changed')
    expect(inner).not.toHaveBeenCalled()
  })

  it('refuses a retry whose facts differ from the retained attempt', async () => {
    const inner = vi.fn(async () => ({ arkTxid: 'cc'.repeat(32), amount: 2125 }))
    recordRefundAttemptProgress(attempt, 'dispatched')
    const changed = durableVaultLightningRefund({ ...attempt, amountSats: attempt.amountSats + 1 }, inner, {
      record: neverRecord(),
    })
    await expect(changed(swap)).rejects.toThrow('inputs changed')
    expect(inner).not.toHaveBeenCalled()
    const same = durableVaultLightningRefund(attempt, inner, { record: neverRecord() })
    await expect(same(swap)).resolves.toEqual({ arkTxid: 'cc'.repeat(32), amount: 2125 })
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('rejects a different transaction than the retained submission', async () => {
    localStorage.setItem(
      `vaulted-lightning-refund-attempt:${attempt.rfqId}`,
      JSON.stringify({
        ...attempt,
        stage: 'submitted',
        fundedInputs: [{ txid: 'ee'.repeat(32), vout: 0, value: 2125 }],
        submittedRefundTxid: 'cc'.repeat(32),
        updatedAt: 1,
      }),
    )
    const other = vi.fn(async () => ({ arkTxid: 'dd'.repeat(32), amount: 2125 }))
    await expect(durableVaultLightningRefund(attempt, other, { record: neverRecord() })(swap)).rejects.toThrow(
      'transaction changed',
    )
    expect(other).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(`vaulted-lightning-refund-attempt:${attempt.rfqId}`)!)).toMatchObject({
      stage: 'submitted',
      submittedRefundTxid: 'cc'.repeat(32),
    })
  })

  it('fences dispatch after cancellation and retains the attempt on dispatch errors', async () => {
    const inner = vi.fn(async () => ({ arkTxid: 'cc'.repeat(32), amount: 2125 }))
    const controller = new AbortController()
    controller.abort()
    await expect(
      durableVaultLightningRefund(attempt, inner, { record: neverRecord(), signal: controller.signal })(swap),
    ).rejects.toThrow()
    expect(inner).not.toHaveBeenCalled()
    const failing = vi.fn(async () => {
      throw new Error('lost refund response')
    })
    await expect(durableVaultLightningRefund(attempt, failing, { record: neverRecord() })(swap)).rejects.toThrow(
      'lost refund response',
    )
    const retry = vi.fn(async () => ({ arkTxid: 'cc'.repeat(32), amount: 2125 }))
    await expect(durableVaultLightningRefund(attempt, retry, { record: neverRecord() })(swap)).resolves.toEqual({
      arkTxid: 'cc'.repeat(32),
      amount: 2125,
    })
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('does not cache empty results so later passes can dispatch', async () => {
    const inner = vi.fn(async () => null)
    const refund = durableVaultLightningRefund(attempt, inner, { record: neverRecord() })
    await expect(refund(swap)).resolves.toBeNull()
    await expect(refund(swap)).resolves.toBeNull()
    expect(inner).toHaveBeenCalledTimes(2)
  })

  it('rejects corrupt journal data and unavailable storage instead of dispatching', async () => {
    const inner = vi.fn(async () => ({ arkTxid: 'cc'.repeat(32), amount: 2125 }))
    localStorage.setItem(`vaulted-lightning-refund-attempt:${attempt.rfqId}`, 'not-json')
    await expect(durableVaultLightningRefund(attempt, inner, { record: neverRecord() })(swap)).rejects.toThrow(
      'corrupt',
    )
    expect(inner).not.toHaveBeenCalled()
  })
})

describe('Lightning refund merge hardening', () => {
  const facts: VaultLightningRefundFacts = {
    rfqId: 'ab'.repeat(32),
    lockupAddress: 'tark1lockup',
    lockupPkScriptHex: 'ab'.repeat(34),
    amountSats: 2125,
    destination: 'tark1spending',
    vaultId: 'vault-lightning',
    network: 'bitcoin',
    senderPub: '11'.repeat(32),
    serverPub: '22'.repeat(32),
  }
  const signed = refundPsbtBytes()
  const submitted = {
    ...facts,
    fundedInputs: [{ txid: 'ee'.repeat(32), vout: 0, value: 2125 as number | null }],
    signedRefundPsbt: signed.psbt,
    submittedRefundTxid: signed.txid,
    submittedCheckpointPsbts: ['cp-a'],
    refundOutputSats: 2125,
  }

  it('rejects conflicting identity facts on replay', () => {
    recordRefundAttemptProgress(facts, 'dispatched')
    expect(() => recordRefundAttemptProgress({ ...facts, amountSats: facts.amountSats + 1 }, 'dispatched')).toThrow(
      'inputs changed',
    )
    expect(() => recordRefundAttemptProgress({ ...facts, destination: 'tark1other' }, 'dispatched')).toThrow(
      'inputs changed',
    )
    expect(readLightningRefundAttempt(facts.rfqId)).toMatchObject({ stage: 'dispatched', ...facts })
  })

  it('rejects conflicting signed evidence and replays identical bytes', () => {
    recordRefundAttemptProgress(submitted, 'submitted')
    expect(() =>
      recordRefundAttemptProgress(
        { ...submitted, signedRefundPsbt: refundPsbtBytes('ff'.repeat(32)).psbt },
        'submitted',
      ),
    ).toThrow('evidence changed')
    expect(() =>
      recordRefundAttemptProgress({ ...submitted, submittedRefundTxid: 'dd'.repeat(32) }, 'submitted'),
    ).toThrow('evidence changed')
    recordRefundAttemptProgress(submitted, 'submitted')
    expect(readLightningRefundAttempt(facts.rfqId)).toMatchObject({
      stage: 'submitted',
      signedRefundPsbt: signed.psbt,
      submittedRefundTxid: signed.txid,
    })
  })

  it('never demotes a recorded phase on a repeated dispatch', () => {
    recordRefundAttemptProgress(submitted, 'submitted')
    recordRefundAttemptProgress(facts, 'dispatched')
    expect(readLightningRefundAttempt(facts.rfqId)).toMatchObject({
      stage: 'submitted',
      signedRefundPsbt: signed.psbt,
    })
  })

  it('keeps accepted evidence against explicit undefined updates', () => {
    recordRefundAttemptProgress(
      { ...submitted, serverCheckpointPsbts: ['cp-server'], serverRefundPsbt: 'server-psbt' },
      'submitted',
    )
    recordRefundAttemptProgress({ ...facts, serverRefundPsbt: undefined }, 'submitted')
    expect(readLightningRefundAttempt(facts.rfqId)).toMatchObject({
      stage: 'submitted',
      signedRefundPsbt: signed.psbt,
      serverCheckpointPsbts: ['cp-server'],
      serverRefundPsbt: 'server-psbt',
    })
  })

  it('seeds restores by highest phase and accepted bytes, not wall-clock', () => {
    const attempt: VaultLightningRefundAttempt = {
      ...submitted,
      stage: 'submitted',
      updatedAt: 10,
    } as VaultLightningRefundAttempt
    expect(seedRestoredRefundAttempt(attempt)).toBe(true)
    expect(seedRestoredRefundAttempt({ ...attempt, updatedAt: 9 })).toBe(false)
    expect(seedRestoredRefundAttempt({ ...attempt, updatedAt: 99 })).toBe(false)
    expect(() =>
      seedRestoredRefundAttempt({
        ...attempt,
        signedRefundPsbt: refundPsbtBytes('ff'.repeat(32)).psbt,
        updatedAt: 99,
      }),
    ).toThrow('Conflicting')
    expect(
      seedRestoredRefundAttempt({
        ...attempt,
        stage: 'finalized',
        serverCheckpointPsbts: ['cp-server'],
        serverRefundPsbt: 'server-psbt',
        finalCheckpointPsbts: ['cp-final'],
        updatedAt: 1,
      }),
    ).toBe(true)
    expect(readLightningRefundAttempt(facts.rfqId)).toMatchObject({
      stage: 'finalized',
      signedRefundPsbt: signed.psbt,
      serverRefundPsbt: 'server-psbt',
      finalCheckpointPsbts: ['cp-final'],
    })
    expect(seedRestoredRefundAttempt({ ...attempt, updatedAt: 500 })).toBe(false)
    expect(readLightningRefundAttempt(facts.rfqId)?.stage).toBe('finalized')
    expect(() => seedRestoredRefundAttempt({ ...attempt, lockupAddress: 'tark1other', updatedAt: 12 })).toThrow(
      'Conflicting',
    )
    const merged = mergeLightningRefundAttempts(readLightningRefundAttempt(facts.rfqId), {
      ...attempt,
      stage: 'submitted',
      updatedAt: 800,
    })
    expect(merged.stage).toBe('finalized')
    expect(merged.signedRefundPsbt).toBe(signed.psbt)
    localStorage.setItem(`vaulted-lightning-refund-attempt:${facts.rfqId}`, 'not-json')
    expect(seedRestoredRefundAttempt({ ...attempt, updatedAt: 13 })).toBe(true)
  })

  it('rejects equal-timestamp conflicting bytes and keeps later-phase fields when they are omitted', () => {
    const finalized: VaultLightningRefundAttempt = {
      ...submitted,
      stage: 'finalized',
      serverCheckpointPsbts: ['cp-server'],
      serverRefundPsbt: 'server-psbt',
      finalCheckpointPsbts: ['cp-final'],
      updatedAt: 40,
    }
    expect(seedRestoredRefundAttempt(finalized)).toBe(true)
    expect(() =>
      seedRestoredRefundAttempt({
        ...submitted,
        stage: 'submitted',
        signedRefundPsbt: refundPsbtBytes('ff'.repeat(32)).psbt,
        updatedAt: 40,
      }),
    ).toThrow('Conflicting')
    expect(
      mergeLightningRefundAttempts(readLightningRefundAttempt(facts.rfqId), {
        ...submitted,
        stage: 'submitted',
        updatedAt: 40,
      }),
    ).toMatchObject({
      stage: 'finalized',
      signedRefundPsbt: signed.psbt,
      serverRefundPsbt: 'server-psbt',
      finalCheckpointPsbts: ['cp-final'],
      updatedAt: 40,
    })
  })
})

describe('Lightning refund graph validation', () => {
  async function submittedAttempt() {
    const fixture = await lightningRefundPackageFixture()
    const record = (await fixture.repository.getRfqSwap(fixture.swap.rfqId))!
    const facts: VaultLightningRefundFacts = {
      rfqId: fixture.swap.rfqId,
      lockupAddress: record.lockupAddress,
      lockupPkScriptHex: hex.encode(fixture.swap.lockupPkScript),
      amountSats: fixture.originalLockupInputs.reduce((total, input) => total + input.value, 0),
      destination: fixture.destinationAddress,
      vaultId: 'vault-lightning',
      network: 'bitcoin',
      senderPub: fixture.senderPub,
      serverPub: fixture.serverPub,
    }
    const attempt: VaultLightningRefundAttempt = {
      ...facts,
      fundedInputs: fixture.originalLockupInputs.map((input) => ({ ...input })),
      stage: 'submitted',
      signedRefundPsbt: fixture.signedRefundPsbt,
      submittedRefundTxid: fixture.refundId,
      submittedCheckpointPsbts: [...fixture.submittedCheckpointPsbts],
      refundOutputSats: facts.amountSats,
      updatedAt: 1,
    }
    return { fixture, facts, record, attempt }
  }

  it('binds the real package graph across every stage', async () => {
    const { fixture, facts, attempt } = await submittedAttempt()
    expect(facts.amountSats).toBe(2400)
    validateLightningRefundGraph(attempt)
    validateLightningRefundGraph({
      ...attempt,
      serverCheckpointPsbts: [...fixture.serverCheckpointPsbts],
      serverRefundPsbt: fixture.serverRefundPsbt,
    })
    validateLightningRefundGraph({
      ...attempt,
      serverCheckpointPsbts: [...fixture.serverCheckpointPsbts],
      serverRefundPsbt: fixture.serverRefundPsbt,
      stage: 'finalized',
      finalCheckpointPsbts: [...fixture.finalCheckpointPsbts],
    })
    validateLightningRefundGraph({
      ...attempt,
      serverCheckpointPsbts: [...fixture.serverCheckpointPsbts],
      serverRefundPsbt: fixture.serverRefundPsbt,
      stage: 'result',
      finalCheckpointPsbts: [...fixture.finalCheckpointPsbts],
      refundArkTxid: fixture.refundId,
      resultAmount: fixture.resultAmount,
    })
    expect(fixture.resultAmount).toBe(2400)
  })

  it('accepts a reversed Operator checkpoint list and rejects version or locktime changes', async () => {
    const { fixture, attempt } = await submittedAttempt()
    const reversed = {
      ...attempt,
      serverCheckpointPsbts: [...fixture.serverCheckpointPsbts].reverse(),
      serverRefundPsbt: fixture.serverRefundPsbt,
    }
    validateLightningRefundGraph(reversed)
    validateLightningRefundGraph({
      ...reversed,
      stage: 'finalized',
      finalCheckpointPsbts: [...fixture.finalCheckpointPsbts].reverse(),
    })
    const unsigned = fixture.submittedCheckpointPsbts[0]
    const source = Transaction.fromPSBT(base64.decode(unsigned))
    const clone = (version: number, lockTime: number) => {
      const tx = new Transaction({ version, lockTime })
      for (let index = 0; index < source.inputsLength; index++) tx.addInput(source.getInput(index))
      for (let index = 0; index < source.outputsLength; index++) {
        const output = source.getOutput(index)
        if (!output?.script) throw new Error('test checkpoint output is incomplete')
        tx.addOutput({ amount: output.amount ?? 0n, script: output.script })
      }
      return base64.encode(tx.toPSBT())
    }
    expect(sameCheckpointGraph(unsigned, clone(source.version, source.lockTime + 1))).toBe(false)
    expect(sameCheckpointGraph(unsigned, clone(source.version === 3 ? 2 : 3, source.lockTime))).toBe(false)
  })

  it('rejects a forged input set, a replaced transaction, and a diverted destination', async () => {
    const { fixture, record, attempt } = await submittedAttempt()
    expect(() =>
      validateLightningRefundGraph({
        ...attempt,
        fundedInputs: [{ txid: 'ff'.repeat(32), vout: 0, value: 2400 }],
      }),
    ).toThrow('funded inputs')
    expect(() =>
      validateLightningRefundGraph({
        ...attempt,
        stage: 'result',
        serverCheckpointPsbts: [...fixture.serverCheckpointPsbts],
        serverRefundPsbt: fixture.serverRefundPsbt,
        finalCheckpointPsbts: [...fixture.finalCheckpointPsbts],
        refundArkTxid: 'dd'.repeat(32),
        resultAmount: 2400,
      }),
    ).toThrow('transaction changed')
    expect(() => validateLightningRefundGraph({ ...attempt, destination: record.lockupAddress })).toThrow('destination')
  })

  it('rejects signed bytes in the unsigned checkpoint set and half an Operator response', async () => {
    const { fixture, attempt } = await submittedAttempt()
    expect(() =>
      validateLightningRefundGraph({ ...attempt, submittedCheckpointPsbts: [...fixture.serverCheckpointPsbts] }),
    ).toThrow('already signed')
    expect(() =>
      validateLightningRefundGraph({
        ...attempt,
        serverCheckpointPsbts: [...fixture.serverCheckpointPsbts],
      }),
    ).toThrow('incomplete')
    expect(() => validateLightningRefundGraph({ ...attempt, serverRefundPsbt: fixture.serverRefundPsbt })).toThrow(
      'incomplete',
    )
  })

  it('rejects wrong enrolled signers on real package bytes', async () => {
    const { fixture, attempt } = await submittedAttempt()
    const finalized = {
      ...attempt,
      stage: 'finalized' as const,
      serverCheckpointPsbts: [...fixture.serverCheckpointPsbts],
      serverRefundPsbt: fixture.serverRefundPsbt,
      finalCheckpointPsbts: [...fixture.finalCheckpointPsbts],
    }
    validateLightningRefundGraph(finalized)
    expect(() =>
      validateLightningRefundGraph({ ...finalized, senderPub: finalized.serverPub, serverPub: finalized.senderPub }),
    ).toThrow('invalid signer')
    expect(() => validateLightningRefundGraph({ ...finalized, serverPub: '33'.repeat(32) })).toThrow('invalid signer')
  })

  it('rejects missing and corrupted signatures before finalization', async () => {
    const { fixture, attempt } = await submittedAttempt()
    const responded = {
      ...attempt,
      serverCheckpointPsbts: [...fixture.serverCheckpointPsbts],
      serverRefundPsbt: fixture.serverRefundPsbt,
    }
    validateLightningRefundGraph({
      ...responded,
      stage: 'finalized',
      finalCheckpointPsbts: [...fixture.finalCheckpointPsbts],
    })
    // Unsigned bytes where signed evidence is required fail closed.
    expect(() =>
      validateLightningRefundGraph({
        ...responded,
        stage: 'finalized',
        finalCheckpointPsbts: [...fixture.submittedCheckpointPsbts],
      }),
    ).toThrow('invalid signer')
    expect(() =>
      validateLightningRefundGraph({ ...responded, serverCheckpointPsbts: [...fixture.submittedCheckpointPsbts] }),
    ).toThrow('invalid signer')
    expect(() =>
      validateLightningRefundGraph({
        ...responded,
        stage: 'finalized',
        finalCheckpointPsbts: fixture.finalCheckpointPsbts.map((raw, position) =>
          position === 0 ? corruptFirstInputSignature(raw) : raw,
        ),
      }),
    ).toThrow('invalid signer')
    expect(() =>
      validateLightningRefundGraph({
        ...responded,
        serverRefundPsbt: corruptFirstInputSignature(fixture.serverRefundPsbt),
      }),
    ).toThrow('invalid signer')
  })
})

describe('Lightning refund recording against real package bytes', () => {
  async function recordingHarness() {
    const fixture = await lightningRefundPackageFixture()
    const record = (await fixture.repository.getRfqSwap(fixture.swap.rfqId))!
    const facts: VaultLightningRefundFacts = {
      rfqId: fixture.swap.rfqId,
      lockupAddress: record.lockupAddress,
      lockupPkScriptHex: hex.encode(fixture.swap.lockupPkScript),
      amountSats: fixture.originalLockupInputs.reduce((total, input) => total + input.value, 0),
      destination: fixture.destinationAddress,
      vaultId: 'vault-lightning',
      network: 'bitcoin',
      senderPub: fixture.senderPub,
      serverPub: fixture.serverPub,
    }
    const base = {
      getInfo: vi.fn(async () => ({}) as never),
      submitTx: vi.fn(
        async (): Promise<{ arkTxid: string; finalArkTx?: string; signedCheckpointTxs: string[] }> => ({
          arkTxid: fixture.refundId,
          finalArkTx: fixture.serverRefundPsbt,
          signedCheckpointTxs: [...fixture.serverCheckpointPsbts],
        }),
      ),
      finalizeTx: vi.fn(async () => undefined),
    }
    return {
      fixture,
      facts,
      base,
      ark: recordingVaultLightningRefundArk(
        base as unknown as Parameters<typeof recordingVaultLightningRefundArk>[0],
        facts,
      ),
    }
  }

  it('records exact submission and finalization bytes before dispatch', async () => {
    const { fixture, facts, base, ark } = await recordingHarness()
    await expect(ark.submitTx(fixture.signedRefundPsbt, [...fixture.submittedCheckpointPsbts])).resolves.toMatchObject({
      arkTxid: fixture.refundId,
    })
    expect(base.submitTx).toHaveBeenCalledTimes(1)
    await expect(ark.finalizeTx(fixture.refundId, [...fixture.finalCheckpointPsbts])).resolves.toBeUndefined()
    expect(base.finalizeTx).toHaveBeenCalledTimes(1)
    const stored = readLightningRefundAttempt(facts.rfqId)!
    expect(stored).toMatchObject({
      rfqId: facts.rfqId,
      stage: 'finalized',
      signedRefundPsbt: fixture.signedRefundPsbt,
      submittedRefundTxid: fixture.refundId,
      submittedCheckpointPsbts: fixture.submittedCheckpointPsbts,
      serverCheckpointPsbts: fixture.serverCheckpointPsbts,
      serverRefundPsbt: fixture.serverRefundPsbt,
      finalCheckpointPsbts: fixture.finalCheckpointPsbts,
    })
    expect(stored.fundedInputs).toEqual(fixture.originalLockupInputs.map((input) => ({ ...input })))
    expect(stored.refundOutputSats).toBe(2400)
    validateLightningRefundGraph(stored)
  })

  it('replaces nothing when the Operator answers a different transaction', async () => {
    const { fixture, facts, base, ark } = await recordingHarness()
    base.submitTx.mockResolvedValueOnce({
      arkTxid: 'dd'.repeat(32),
      finalArkTx: fixture.serverRefundPsbt,
      signedCheckpointTxs: [...fixture.serverCheckpointPsbts],
    })
    await expect(ark.submitTx(fixture.signedRefundPsbt, [...fixture.submittedCheckpointPsbts])).rejects.toThrow(
      'transaction changed',
    )
    expect(base.submitTx).toHaveBeenCalledTimes(1)
    expect(readLightningRefundAttempt(facts.rfqId)).toMatchObject({ stage: 'submitted' })
  })

  it('rejects malformed payloads and fences dispatch after cancellation', async () => {
    const { base, ark } = await recordingHarness()
    await expect(ark.submitTx('', [])).rejects.toThrow('malformed')
    await expect(ark.finalizeTx('not-hex', ['final-a'])).rejects.toThrow('malformed')
    expect(base.submitTx).not.toHaveBeenCalled()
    expect(base.finalizeTx).not.toHaveBeenCalled()
    const controller = new AbortController()
    controller.abort()
    const { facts } = await recordingHarness()
    const cancelled = recordingVaultLightningRefundArk(
      base as unknown as Parameters<typeof recordingVaultLightningRefundArk>[0],
      facts,
      controller.signal,
    )
    await expect(cancelled.submitTx('signed-psbt', ['cp-a'])).rejects.toThrow()
    expect(base.submitTx).not.toHaveBeenCalled()
  })

  it('withholds first-attempt finalization without a validated Operator successor', async () => {
    const { fixture, facts, base, ark } = await recordingHarness()
    base.submitTx.mockResolvedValueOnce({
      arkTxid: fixture.refundId,
      signedCheckpointTxs: [...fixture.serverCheckpointPsbts],
      finalArkTx: undefined,
    })
    await expect(ark.submitTx(fixture.signedRefundPsbt, [...fixture.submittedCheckpointPsbts])).rejects.toThrow(
      'incomplete',
    )
    expect(readLightningRefundAttempt(facts.rfqId)?.serverRefundPsbt).toBeUndefined()
    await expect(ark.finalizeTx(fixture.refundId, [...fixture.finalCheckpointPsbts])).rejects.toThrow('incomplete')
    expect(base.finalizeTx).not.toHaveBeenCalled()

    base.submitTx.mockResolvedValueOnce({
      arkTxid: fixture.refundId,
      signedCheckpointTxs: [...fixture.serverCheckpointPsbts],
      finalArkTx: fixture.signedRefundPsbt,
    })
    await expect(ark.submitTx(fixture.signedRefundPsbt, [...fixture.submittedCheckpointPsbts])).rejects.toThrow(
      'invalid signer',
    )
    expect(base.finalizeTx).not.toHaveBeenCalled()

    base.submitTx.mockResolvedValueOnce({
      arkTxid: fixture.refundId,
      signedCheckpointTxs: [...fixture.serverCheckpointPsbts],
      finalArkTx: corruptFirstInputSignature(fixture.serverRefundPsbt),
    })
    await expect(ark.submitTx(fixture.signedRefundPsbt, [...fixture.submittedCheckpointPsbts])).rejects.toThrow(
      'invalid signer',
    )
    expect(base.finalizeTx).not.toHaveBeenCalled()
  })

  it('withholds package finalization for missing, sender-only, and forged successors', async () => {
    const run = async (
      mutate: (
        submitted: { arkTxid: string; finalArkTx?: string; signedCheckpointTxs: string[] },
        signedRefundPsbt: string,
      ) => { arkTxid: string; finalArkTx?: string; signedCheckpointTxs: string[] },
      expected: RegExp,
    ) => {
      localStorage.clear()
      const finalizeTx = vi.fn(async () => undefined)
      await expect(
        lightningRefundPackageFixture({
          wrapArk: (ark, facts) =>
            recordingVaultLightningRefundArk(
              {
                getInfo: ark.getInfo,
                submitTx: async (signedRefundPsbt: string, checkpoints: string[]) =>
                  mutate(await ark.submitTx(signedRefundPsbt, checkpoints), signedRefundPsbt),
                finalizeTx,
              } as unknown as Parameters<typeof recordingVaultLightningRefundArk>[0],
              facts,
            ),
        }),
      ).rejects.toThrow(expected)
      expect(finalizeTx).not.toHaveBeenCalled()
    }

    await run((submitted) => ({ ...submitted, finalArkTx: undefined }), /incomplete/)
    await run((submitted, signedRefundPsbt) => ({ ...submitted, finalArkTx: signedRefundPsbt }), /invalid signer/)
    await run(
      (submitted) => ({
        ...submitted,
        finalArkTx: submitted.finalArkTx ? corruptFirstInputSignature(submitted.finalArkTx) : submitted.finalArkTx,
      }),
      /invalid signer/,
    )
  })
})

describe('Lightning refund resume replays durable phases', () => {
  async function resumeHarness() {
    const fixture = await lightningRefundPackageFixture()
    const record = (await fixture.repository.getRfqSwap(fixture.swap.rfqId))!
    const facts: VaultLightningRefundFacts = {
      rfqId: fixture.swap.rfqId,
      lockupAddress: record.lockupAddress,
      lockupPkScriptHex: hex.encode(fixture.swap.lockupPkScript),
      amountSats: fixture.originalLockupInputs.reduce((total, input) => total + input.value, 0),
      destination: fixture.destinationAddress,
      vaultId: 'vault-lightning',
      network: 'bitcoin',
      senderPub: fixture.senderPub,
      serverPub: fixture.serverPub,
    }
    recordRefundAttemptProgress(
      {
        ...facts,
        fundedInputs: fixture.originalLockupInputs.map((input) => ({ ...input })),
        signedRefundPsbt: fixture.signedRefundPsbt,
        submittedRefundTxid: fixture.refundId,
        submittedCheckpointPsbts: [...fixture.submittedCheckpointPsbts],
        refundOutputSats: facts.amountSats,
      },
      'submitted',
    )
    const finalByCheckpointId = new Map(
      fixture.serverCheckpointPsbts.map((raw, position) => [
        Transaction.fromPSBT(base64.decode(raw)).id,
        fixture.finalCheckpointPsbts[position],
      ]),
    )
    const recordCalls = {
      submitRefund: vi.fn(
        async (): Promise<{ arkTxid: string; signedCheckpointTxs: string[]; finalArkTx?: string }> => ({
          arkTxid: fixture.refundId,
          signedCheckpointTxs: [...fixture.serverCheckpointPsbts],
          finalArkTx: fixture.serverRefundPsbt,
        }),
      ),
      signCheckpoint: vi.fn(async (checkpointPsbt: string) => {
        const final = finalByCheckpointId.get(Transaction.fromPSBT(base64.decode(checkpointPsbt)).id)
        if (!final) throw new Error('Lightning refund resume signed an unknown checkpoint.')
        return final
      }),
      finalizeRefund: vi.fn(async () => undefined),
    }
    const inner = vi.fn(async (): Promise<never> => {
      throw new Error('refund resume must not rebuild the package refund')
    })
    const refund = () => durableVaultLightningRefund(facts, inner, { record: recordCalls })(fixture.swap)
    return { fixture, facts, recordCalls, inner, refund }
  }

  it('replays a lost finalization without resubmitting or re-signing', async () => {
    const { fixture, facts, recordCalls, inner, refund } = await resumeHarness()
    recordCalls.finalizeRefund.mockRejectedValueOnce(new Error('lost finalize response'))
    await expect(refund()).rejects.toThrow('lost finalize response')
    expect(recordCalls.submitRefund).toHaveBeenCalledTimes(1)
    expect(recordCalls.signCheckpoint).toHaveBeenCalledTimes(fixture.serverCheckpointPsbts.length)
    expect(recordCalls.finalizeRefund).toHaveBeenCalledTimes(1)
    expect(inner).not.toHaveBeenCalled()
    expect(readLightningRefundAttempt(facts.rfqId)).toMatchObject({
      stage: 'finalized',
      finalCheckpointPsbts: fixture.finalCheckpointPsbts,
    })
    await expect(refund()).resolves.toEqual({ arkTxid: fixture.refundId, amount: 2400 })
    expect(recordCalls.submitRefund).toHaveBeenCalledTimes(1)
    expect(recordCalls.signCheckpoint).toHaveBeenCalledTimes(fixture.serverCheckpointPsbts.length)
    expect(recordCalls.finalizeRefund).toHaveBeenCalledTimes(2)
    expect(recordCalls.finalizeRefund).toHaveBeenLastCalledWith(fixture.refundId, fixture.finalCheckpointPsbts)
    expect(inner).not.toHaveBeenCalled()
    await expect(refund()).resolves.toEqual({ arkTxid: fixture.refundId, amount: 2400 })
    expect(recordCalls.submitRefund).toHaveBeenCalledTimes(1)
    expect(recordCalls.signCheckpoint).toHaveBeenCalledTimes(fixture.serverCheckpointPsbts.length)
    expect(recordCalls.finalizeRefund).toHaveBeenCalledTimes(2)
  })

  it('refuses finals when the retained successor is missing or replaced', async () => {
    const { fixture, facts, recordCalls, inner, refund } = await resumeHarness()
    recordCalls.submitRefund.mockResolvedValueOnce({
      arkTxid: fixture.refundId,
      signedCheckpointTxs: [...fixture.serverCheckpointPsbts],
      finalArkTx: undefined,
    })
    await expect(refund()).rejects.toThrow('incomplete')
    expect(recordCalls.signCheckpoint).not.toHaveBeenCalled()
    expect(recordCalls.finalizeRefund).not.toHaveBeenCalled()
    expect(inner).not.toHaveBeenCalled()
    const replaced = refundPsbtBytes()
    recordCalls.submitRefund.mockResolvedValueOnce({
      arkTxid: fixture.refundId,
      signedCheckpointTxs: [...fixture.serverCheckpointPsbts],
      finalArkTx: replaced.psbt,
    })
    await expect(refund()).rejects.toThrow('changed the transaction')
    expect(recordCalls.signCheckpoint).not.toHaveBeenCalled()
    expect(recordCalls.finalizeRefund).not.toHaveBeenCalled()
    expect(readLightningRefundAttempt(facts.rfqId)).toMatchObject({ stage: 'submitted' })
  })
})

describe('Lightning retirement receipt gate', () => {
  async function ackWithFailingRemoval() {
    const { harness, quote } = await fundedHarness('settled', 'ab'.repeat(32))
    const saved = (await harness.repository.getRfqSwap(quote.rfqId))!
    vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue({
      vaultId: 'vault-lightning',
      network: 'bitcoin',
      descriptorHash: 'vault-lightning',
      fileDigest: 'digest-lightning',
      outputs: [],
    } as never)
    const history = [{ account: 'spend', type: 'sent', txid: FUNDING_TXID, amount: 2125 }] as never
    const failingRemove = {
      getRfqSwap: harness.repository.getRfqSwap.bind(harness.repository),
      getAllRfqSwaps: harness.repository.getAllRfqSwaps.bind(harness.repository),
      saveRfqSwap: harness.repository.saveRfqSwap.bind(harness.repository),
      removeRfqSwap: async () => {
        throw new Error('partial retirement failure')
      },
    }
    const evidence = {
      vaultId: 'vault-lightning',
      network: 'bitcoin',
      descriptorHash: 'vault-lightning',
      fileDigest: 'digest-lightning',
      outputs: [],
    } as never
    await expect(
      acknowledgeVaultLightningRecovery(
        lightningStatus(),
        failingRemove,
        quote.rfqId,
        history,
        journalFor(saved),
        evidence,
      ),
    ).rejects.toThrow('partial retirement failure')
    expect(await harness.repository.getRfqSwap(quote.rfqId)).not.toBeNull()
    expect(readLightningRecoveryAcknowledgment(quote.rfqId)).toMatchObject({
      rfqId: quote.rfqId,
      fundingArkTxid: FUNDING_TXID,
    })
    return { harness, quote }
  }

  it('prunes matched receipts while withholding rewritten records and foreign vaults', async () => {
    const restoreLock = installImmediateLock()
    try {
      const observe = (
        repository: Parameters<typeof createVaultLightningObserver>[0]['repository'],
        contracts: Parameters<typeof createVaultLightningObserver>[0]['contracts'],
        vault?: { vaultId: string; network: string },
      ) =>
        createVaultLightningObserver({
          repository,
          contracts,
          indexer: emptyIndexer(),
          managerConfig: { now: () => OLD_NOW },
          ...(vault ? { vault } : {}),
        }).restoreFromRepository()
      const { harness, quote } = await ackWithFailingRemoval()
      const matched = await observe(harness.repository, harness.contracts, {
        vaultId: 'vault-lightning',
        network: 'bitcoin',
      })
      expect(matched.pruned).toContain(quote.rfqId)
      const rewritten = await ackWithFailingRemoval()
      const tampered = (await rewritten.harness.repository.getRfqSwap(quote.rfqId))!
      await rewritten.harness.repository.saveRfqSwap({ ...tampered, lockupAddress: 'tark1rewritten' })
      const withheld = await observe(rewritten.harness.repository, rewritten.harness.contracts, {
        vaultId: 'vault-lightning',
        network: 'bitcoin',
      })
      expect(withheld.pruned).not.toContain(quote.rfqId)
      expect(await rewritten.harness.repository.getRfqSwap(quote.rfqId)).not.toBeNull()
      const fresh = await ackWithFailingRemoval()
      const distant = await observe(fresh.harness.repository, fresh.harness.contracts, {
        vaultId: 'other-vault',
        network: 'bitcoin',
      })
      expect(distant.pruned).not.toContain(quote.rfqId)
      expect(await fresh.harness.repository.getRfqSwap(quote.rfqId)).not.toBeNull()
    } finally {
      restoreLock()
    }
  })
})
