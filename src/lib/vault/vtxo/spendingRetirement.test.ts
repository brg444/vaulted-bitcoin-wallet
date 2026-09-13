import { ChainTxType, Transaction } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultRequestError } from '../api'
import { networkPins } from '../networkPins'
import golden from './testdata/vault-policy-v1-tree.json'
import type { VaultStatus } from '../types'
import { vaultCosignerClient } from '../cosignerClient'
import { readCommittedRecoveryCoverage, type CommittedRecoveryCoverage } from '../recovery/committedCoverage'
import { packExitArchive } from '../recovery/exitArchive'
import { recoveryFileStore } from '../recovery/fileStore'
import { fetchVaultWalletVtxoSnapshot } from './walletWorker'
import {
  acknowledgeSettledVtxoSpends,
  acknowledgeSpendingVtxoRecovery,
  reconcilePersistedVtxoSpend,
  sendVaultVtxo,
  type VtxoOperationView,
} from './spend'
import {
  clearPersistedVtxoSpend,
  listPersistedVtxoSpends,
  loadPersistedVtxoSpendById,
  persistVtxoSpend,
} from './spendingJournal'
import type { PersistedVtxoSpend } from './spendingTransaction'

vi.mock('../recovery/fileStore', () => ({ recoveryFileStore: vi.fn() }))
vi.mock('../recovery/committedCoverage', () => ({ readCommittedRecoveryCoverage: vi.fn() }))
vi.mock('./walletWorker', () => ({ fetchVaultWalletVtxoSnapshot: vi.fn() }))

const VAULT = 'vault-retire'
const OP = '33'.repeat(16)
const SCRIPT = `5120${golden.fixtures.userPub}`
const RECIPIENT_SCRIPT = `5120${golden.fixtures.exitHardwarePub}`
const FEE_POLICY = 'aa'.repeat(32)

/** Real retained signed graph: parent funds the exact change successor. */
function signedGraph() {
  const pins = networkPins('mutinynet')
  const parent = new Transaction({ version: 2 })
  parent.addInput({ txid: 'cc'.repeat(32), index: 0 })
  parent.addOutput({ amount: 20000n, script: hex.decode(SCRIPT) })
  const ark = new Transaction({ version: 2 })
  ark.addInput({ txid: parent.id, index: 0 })
  ark.addOutput({ amount: 12000n, script: hex.decode(RECIPIENT_SCRIPT) })
  ark.addOutput({ amount: 7500n, script: hex.decode(SCRIPT) })
  const arkPsbt = base64.encode(ark.toPSBT())
  const archive = {
    version: 1 as const,
    descriptorHash: VAULT,
    capturedAt: new Date().toISOString(),
    info: packExitArchive({
      network: 'mutinynet',
      signerPubkey: pins.operatorSignerPub,
      checkpointTapscript: pins.checkpointTapscript,
      forfeitPubkey: pins.checkpointForfeitPub,
    }),
    coins: packExitArchive([
      { txid: ark.id, vout: 1, value: 7500, script: SCRIPT, isSpent: false, createdAt: new Date() },
    ]),
    branches: {
      [`${ark.id}:1`]: [
        { txid: 'cc'.repeat(32), type: ChainTxType.COMMITMENT, expiresAt: '0', spends: [] },
        { txid: parent.id, type: ChainTxType.TREE, expiresAt: '0', spends: ['cc'.repeat(32)] },
        { txid: ark.id, type: ChainTxType.ARK, expiresAt: '0', spends: [parent.id] },
      ],
    },
    transactions: { [parent.id]: base64.encode(parent.toPSBT()), [ark.id]: arkPsbt },
  }
  return { parent, ark, arkPsbt, archive }
}

const GRAPH = signedGraph()
const ARK = GRAPH.ark.id

function retirementStatus(): VaultStatus {
  return {
    vaultId: VAULT,
    network: 'mutinynet',
    spendingArkScript: SCRIPT,
    enrolled: true,
    vtxoExitDelay: 4608,
    vtxoExitDelayUnit: 'seconds',
  } as unknown as VaultStatus
}

function finalizedOp(overrides: Partial<PersistedVtxoSpend> = {}): PersistedVtxoSpend {
  return {
    vaultId: VAULT,
    operationId: OP,
    bundleDigest: '44'.repeat(32),
    destAddress: 'tb1qdestination',
    amountSats: 12_000,
    arkTxid: ARK,
    feeSats: 500,
    feePolicyDigest: FEE_POLICY,
    changeSats: 7_500,
    changeVout: 1,
    operatorArkPsbt: GRAPH.arkPsbt,
    reservedInputs: [{ txid: GRAPH.parent.id, vout: 0, valueSats: 20_000, scriptHex: SCRIPT }],
    stage: 'operator-finalized',
    ...overrides,
  }
}

function finalizedView(overrides: Partial<VtxoOperationView> = {}): VtxoOperationView {
  return {
    operationId: OP,
    bundleDigest: '44'.repeat(32),
    state: 'finalized',
    arkTxid: ARK,
    feeSats: 500,
    feePolicyDigest: FEE_POLICY,
    changeSats: 7_500,
    changeVout: 1,
    ...overrides,
  }
}

function coverage(): CommittedRecoveryCoverage {
  return {
    vaultId: VAULT,
    network: 'mutinynet',
    descriptorHash: VAULT,
    fileDigest: 'digest-1',
    outputs: [{ txid: ARK, vout: 1, value: 7_500, script: SCRIPT }],
  }
}

function agreeEvidence() {
  vi.mocked(recoveryFileStore).mockResolvedValue(structuredClone(GRAPH.archive) as never)
  vi.mocked(fetchVaultWalletVtxoSnapshot).mockResolvedValue({
    history: [{ account: 'spend', type: 'sent', txid: ARK, amount: 12_500 }],
  } as never)
  vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverage() as never)
  vi.spyOn(vaultCosignerClient.spending, 'operation').mockResolvedValue(finalizedView() as never)
}

function installImmediateLock() {
  const original = (navigator as Navigator & { locks?: unknown }).locks
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) =>
        callback({}),
    },
  })
  return () => {
    if (original) Object.defineProperty(navigator, 'locks', { configurable: true, value: original })
    else Reflect.deleteProperty(navigator, 'locks')
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  for (const record of listPersistedVtxoSpends(VAULT)) clearPersistedVtxoSpend(VAULT, record.operationId)
})

describe('shared Spending retirement predicate', () => {
  it('retires only when receipt, archive, history and coverage agree', async () => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp())
      agreeEvidence()
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP, coverage())).resolves.toBe(true)
      expect(loadPersistedVtxoSpendById(VAULT, OP)).toBeUndefined()
    } finally {
      restoreLock()
    }
  })

  it.each([
    ['different operation id', { operationId: '55'.repeat(16) }],
    ['different bundle digest', { bundleDigest: '66'.repeat(32) }],
    ['different transaction', { arkTxid: 'ff'.repeat(32) }],
    ['different fee', { feeSats: 501 }],
    ['different change', { changeSats: 7_499 }],
  ])('retains the journal for a receipt with %s', async (_label, changes) => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp())
      agreeEvidence()
      vi.mocked(vaultCosignerClient.spending.operation).mockResolvedValue({
        ...finalizedView(),
        ...changes,
      } as never)
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(VAULT, OP)?.stage).toBe('operator-finalized')
    } finally {
      restoreLock()
    }
  })

  it.each([
    ['missing archive', null],
    ['malformed archive', { transactions: { [ARK]: 'cHNidP9ark' } }],
    ['stripped ancestry', { ...structuredClone(GRAPH.archive), branches: {} }],
    ['foreign binding', { ...structuredClone(GRAPH.archive), descriptorHash: 'other-vault' }],
  ])('retains the journal when the stored finalization archive is %s', async (_label, archive) => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp())
      agreeEvidence()
      vi.mocked(recoveryFileStore).mockResolvedValue(archive as never)
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(VAULT, OP)?.stage).toBe('operator-finalized')
    } finally {
      restoreLock()
    }
  })

  it('retains the journal when the archived bytes differ from the signed successor', async () => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp({ operatorArkPsbt: `${GRAPH.arkPsbt.slice(0, -4)}AAAA` }))
      agreeEvidence()
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(VAULT, OP)?.stage).toBe('operator-finalized')
    } finally {
      restoreLock()
    }
  })

  it('retains the journal on missing history, coverage or change successor', async () => {
    const restoreLock = installImmediateLock()
    try {
      for (const mutate of [
        () => vi.mocked(fetchVaultWalletVtxoSnapshot).mockResolvedValue({ history: [] } as never),
        () => vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(null),
        () => vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue({ ...coverage(), outputs: [] } as never),
      ]) {
        persistVtxoSpend(finalizedOp())
        agreeEvidence()
        mutate()
        await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(false)
        expect(loadPersistedVtxoSpendById(VAULT, OP)?.stage).toBe('operator-finalized')
        clearPersistedVtxoSpend(VAULT, OP)
        vi.restoreAllMocks()
      }
    } finally {
      restoreLock()
    }
  })

  it('rejects a mismatched evidence digest and a journal rewritten mid-flight', async () => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp())
      agreeEvidence()
      await expect(
        acknowledgeSpendingVtxoRecovery(retirementStatus(), OP, { ...coverage(), fileDigest: 'other-digest' }),
      ).resolves.toBe(false)
      vi.mocked(readCommittedRecoveryCoverage).mockImplementation(async () => {
        persistVtxoSpend({ ...finalizedOp(), reservationExpires: '2030-01-01T00:00:00Z' })
        return coverage() as never
      })
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(VAULT, OP)?.reservationExpires).toBe('2030-01-01T00:00:00Z')
    } finally {
      restoreLock()
    }
  })

  it('retires a zero-change successor without requiring a change output', async () => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp({ changeSats: 0, changeVout: undefined }))
      agreeEvidence()
      vi.mocked(vaultCosignerClient.spending.operation).mockResolvedValue({
        ...finalizedView(),
        changeSats: 0,
        changeVout: undefined,
      } as never)
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue({ ...coverage(), outputs: [] } as never)
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(true)
      expect(loadPersistedVtxoSpendById(VAULT, OP)).toBeUndefined()
    } finally {
      restoreLock()
    }
  })

  it('retires through coverage when the operation finalized without a local operator result', async () => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp({ operatorArkPsbt: undefined, stage: 'authorized' }))
      agreeEvidence()
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(true)
      expect(loadPersistedVtxoSpendById(VAULT, OP)).toBeUndefined()
    } finally {
      restoreLock()
    }
  })

  it('retains when coverage still shows the supposedly spent inputs', async () => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp({ operatorArkPsbt: undefined, stage: 'authorized' }))
      agreeEvidence()
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue({
        ...coverage(),
        outputs: [
          ...coverage().outputs,
          { txid: GRAPH.parent.id, vout: 0, value: 20_000, script: SCRIPT },
        ],
      } as never)
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(VAULT, OP)?.stage).toBe('authorized')
    } finally {
      restoreLock()
    }
  })

  it('retires on a later capture after missing evidence', async () => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp())
      agreeEvidence()
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(null)
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(VAULT, OP)?.stage).toBe('operator-finalized')
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverage() as never)
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(true)
      expect(loadPersistedVtxoSpendById(VAULT, OP)).toBeUndefined()
      await expect(acknowledgeSpendingVtxoRecovery(retirementStatus(), OP)).resolves.toBe(false)
    } finally {
      restoreLock()
    }
  })

  it('aborts acknowledgment on a cancelled caller without retiring', async () => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp())
      agreeEvidence()
      const controller = new AbortController()
      controller.abort()
      await expect(
        acknowledgeSpendingVtxoRecovery(retirementStatus(), OP, undefined, controller.signal),
      ).rejects.toThrow()
      expect(loadPersistedVtxoSpendById(VAULT, OP)?.stage).toBe('operator-finalized')
    } finally {
      restoreLock()
    }
  })

  it('settles only finalized operations and skips pre-reserve records', async () => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp())
      persistVtxoSpend({
        vaultId: VAULT,
        operationId: '55'.repeat(16),
        bundleDigest: '',
        destAddress: 'tb1qdestination',
        amountSats: 1_000,
        arkTxid: '',
        stage: 'pre-reserve',
      })
      agreeEvidence()
      await expect(acknowledgeSettledVtxoSpends(retirementStatus())).resolves.toBe(1)
      expect(loadPersistedVtxoSpendById(VAULT, OP)).toBeUndefined()
      expect(loadPersistedVtxoSpendById(VAULT, '55'.repeat(16))?.stage).toBe('pre-reserve')
    } finally {
      restoreLock()
    }
  })

  it('reconcile reports the service receipt while retaining the journal without evidence', async () => {
    const restoreLock = installImmediateLock()
    try {
      persistVtxoSpend(finalizedOp())
      vi.spyOn(vaultCosignerClient.spending, 'operation').mockResolvedValue(finalizedView() as never)
      await expect(reconcilePersistedVtxoSpend(retirementStatus())).resolves.toEqual({
        kind: 'receipt-finalized',
        txid: ARK,
        operationId: OP,
      })
      expect(loadPersistedVtxoSpendById(VAULT, OP)?.stage).toBe('operator-finalized')
    } finally {
      restoreLock()
    }
  })

  it('keeps a live operation on a lost reservation response instead of clearing it', async () => {
    const restoreLock = installImmediateLock()
    try {
      const reservationExpires = new Date(Date.now() + 3600_000).toISOString()
      persistVtxoSpend(
        finalizedOp({
          stage: 'authorized',
          authorizedPsbt: 'cHNidP9a',
          authorizedPendingProof: 'cHNidP9p',
          feePolicyDigest: FEE_POLICY,
          reservationExpires,
        }),
      )
      vi.spyOn(vaultCosignerClient.spending, 'operation').mockRejectedValue(new VaultRequestError('gone', 404))
      const quote = {
        operationId: OP,
        bundleDigest: '44'.repeat(32),
        destAddress: 'tb1qdestination',
        amountSats: 12_000,
        feeSats: 500,
        feePolicyDigest: FEE_POLICY,
        reservationExpires,
        changeSats: 7_500,
        changeVout: 1,
      }
      const unlocker = () => ({ unlock: async () => ({}), dispose: () => {} })
      await expect(sendVaultVtxo({} as never, retirementStatus(), quote, unlocker as never)).rejects.toThrow()
      expect(loadPersistedVtxoSpendById(VAULT, OP)?.stage).toBe('authorized')
    } finally {
      restoreLock()
    }
  })
})
