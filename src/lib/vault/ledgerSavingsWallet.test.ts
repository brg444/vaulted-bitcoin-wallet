import { afterEach, describe, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { Transaction, p2tr } from '@scure/btc-signer'
import { vaultAddressNetwork } from './bitcoin'
import { buildLedgerNativeFamily } from './program/ledgerNativeFamily'
import { ledgerBip32Versions } from './program/ledgerNativeKeys'
import { compressedFromScalar } from './program/fixtures'
import vectors from './program/ledger-family-vectors.json'
import {
  acceptLedgerSavingsSignatures,
  buildLedgerSavingsPsbt,
  type LedgerSavingsContract,
  type LedgerSavingsPayment,
} from './ledgerSavings'
import type { VaultLockManager } from './vtxo/lock'
import type { EsploraTx, EsploraUtxo } from './esplora'
import {
  broadcastLedgerSavingsPayment,
  cancelLedgerSavingsPayment,
  fetchLedgerSavingsSnapshot,
  loadLedgerSavingsPayment,
  markLedgerSavingsSigning,
  quoteLedgerSavingsPayment,
  reconcileLedgerSavingsPayment,
  retainLedgerSavingsPayment,
  saveLedgerSavingsPhoneApproval,
  saveLedgerSavingsSigned,
  signLedgerSavingsSeed,
  exportLedgerSavingsPaymentJournal,
  restoreLedgerSavingsPaymentJournal,
  validateLedgerSavingsPaymentJournal,
  type LedgerSavingsChainReader,
  type LedgerSavingsWalletDependencies,
} from './ledgerSavingsWallet'

const phoneSeed = new Uint8Array(32).fill(0x43)
const HARDWARE_SEED = new Uint8Array(32).fill(0x42)

function fixture(advanced = false, network: 'mainnet' | 'mutinynet' = 'mutinynet') {
  const vector = vectors.find((v) => v.input.network === network && Boolean(v.input.recovery) === advanced)!
  const contract = structuredClone({
    context: vector.input,
    spendingPolicy: vector.spendingPolicy,
  }) as LedgerSavingsContract
  const family = buildLedgerNativeFamily(contract.context, contract.spendingPolicy)
  const destination = p2tr(
    hex.decode(compressedFromScalar(25).slice(2)),
    undefined,
    vaultAddressNetwork(network),
  ).address!
  const raw = new Map<string, string>()
  const statuses = new Map<string, { confirmed: boolean }>()
  const spent = new Map<string, Awaited<ReturnType<LedgerSavingsChainReader['outspend']>>>()
  const utxos = new Map<string, EsploraUtxo[]>()
  const transactions = new Map<string, EsploraTx[]>()
  const coins = ([0, 1] as const).map((branch) => {
    const tree = branch === 0 ? family.receive : family.change
    const parent = new Transaction({ version: 2 })
    parent.addInput({ txid: (branch ? '43' : '44').repeat(32), index: 0 })
    const value = branch ? 20_000 : 30_000
    parent.addOutput({ amount: BigInt(value), script: tree.script })
    const parentTxHex = hex.encode(parent.toBytes(true, true))
    raw.set(parent.id, parentTxHex)
    statuses.set(parent.id, { confirmed: true })
    utxos.set(tree.address!, [{ txid: parent.id, vout: 0, value, status: { confirmed: true, block_height: 10 } }])
    transactions.set(tree.address!, [
      { txid: parent.id, vin: [], vout: [{ scriptpubkey_address: tree.address, value }], status: { confirmed: true } },
    ])
    return { txid: parent.id, vout: 0, value, parentTxHex, branch, index: 0 as const, confirmedHeight: 10 }
  })
  const reader: LedgerSavingsChainReader = {
    addressUtxos: vi.fn(async (address) => structuredClone(utxos.get(address) || [])),
    addressTransactions: vi.fn(async (address) => structuredClone(transactions.get(address) || [])),
    transactionHex: vi.fn(async (id) => {
      if (!raw.has(id)) throw new Error('Unknown fixture transaction')
      return raw.get(id)!
    }),
    transactionStatus: vi.fn(async (id) => statuses.get(id) || null),
    outspend: vi.fn(async (id, vout) => spent.get(`${id}:${vout}`) || { spent: false }),
    broadcast: vi.fn(async (txHex) => {
      const tx = Transaction.fromRaw(hex.decode(txHex))
      raw.set(tx.id, txHex)
      statuses.set(tx.id, { confirmed: false })
      return tx.id
    }),
  }
  const saved = new Map<string, string>()
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value)
    },
  }
  let queue = Promise.resolve()
  const locks: VaultLockManager = {
    request: (_name, _options, fn) => {
      const result = queue.then(() => fn({}))
      queue = result.then(
        () => {},
        () => {},
      )
      return result
    },
  }
  const deps: LedgerSavingsWalletDependencies = { chain: reader, storage, locks }
  const payment: LedgerSavingsPayment = {
    contract,
    coins: [coins[0]],
    destAddress: destination,
    amountSats: 20_000,
    feeSats: 1000,
  }
  return {
    contract,
    family,
    destination,
    coins,
    payment,
    raw,
    statuses,
    spent,
    utxos,
    transactions,
    reader,
    saved,
    storage,
    locks,
    deps,
  }
}

function hardwareSign(payment: LedgerSavingsPayment, psbt: string) {
  const tx = Transaction.fromPSBT(hex.decode(psbt), { allowUnknownInputs: true, allowUnknownOutputs: true })
  const keys: HDKey[] = []
  try {
    let key = HDKey.fromMasterSeed(HARDWARE_SEED, ledgerBip32Versions(payment.contract.context.network))
    keys.push(key)
    for (const index of payment.contract.context.hardware.path) {
      key = key.deriveChild(index)
      keys.push(key)
    }
    const coins = [...payment.coins].sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout)
    coins.forEach((coin, i) => {
      const branch = key.deriveChild(coin.branch),
        child = branch.deriveChild(0)
      keys.push(branch, child)
      tx.signIdx(child.privateKey!, i)
    })
    return hex.encode(tx.toPSBT())
  } finally {
    for (const key of keys) key.wipePrivateData()
  }
}

async function signedFixture() {
  const f = fixture()
  const record = await retainLedgerSavingsPayment(f.payment, f.deps)
  await markLedgerSavingsSigning(f.contract, record.candidateId, f.deps)
  const phone = signLedgerSavingsSeed(f.payment, phoneSeed)
  await saveLedgerSavingsPhoneApproval(f.contract, record.candidateId, phone, f.deps)
  const signed = hardwareSign(f.payment, phone)
  await saveLedgerSavingsSigned(f.contract, record.candidateId, signed, f.deps)
  return { ...f, record, phone, signed }
}

afterEach(() => vi.restoreAllMocks())

describe('Ledger Savings receive/change discovery and exact fee quotes', () => {
  it('verifies both addresses, adds balances once, and classifies change inside the same payment', async () => {
    const f = fixture()
    const pending = new Transaction({ version: 2 })
    pending.addInput({ txid: f.coins[0].txid, index: 0 })
    pending.addOutputAddress(f.destination, 20_000n, vaultAddressNetwork('mutinynet'))
    pending.addOutput({ amount: 9000n, script: f.family.change.script })
    f.raw.set(pending.id, hex.encode(pending.toBytes(true, true)))
    f.utxos.set(f.family.receive.address!, [])
    f.utxos
      .get(f.family.change.address!)!
      .push({ txid: pending.id, vout: 1, value: 9000, status: { confirmed: false } })
    const history = {
      txid: pending.id,
      vin: [{ prevout: { scriptpubkey_address: f.family.receive.address, value: 30_000 } }],
      vout: [
        { scriptpubkey_address: f.destination, value: 20_000 },
        { scriptpubkey_address: f.family.change.address, value: 9000 },
      ],
      status: { confirmed: false },
    }
    f.transactions.get(f.family.receive.address!)!.push(history)
    f.transactions.get(f.family.change.address!)!.push(history)
    const snapshot = await fetchLedgerSavingsSnapshot(f.contract, f.deps)
    expect(snapshot).toMatchObject({
      totalSats: 29_000,
      availableSats: 20_000,
      receiveAddress: f.family.receive.address,
      changeAddress: f.family.change.address,
    })
    expect(snapshot.coins).toHaveLength(1)
    expect(snapshot.coins[0].branch).toBe(1)
    expect(snapshot.history.filter((item) => item.txid === pending.id)).toEqual([
      { txid: pending.id, type: 'sent', account: 'savings', amount: 21_000, confirmed: false, blockTime: undefined },
    ])
    expect(f.reader.addressUtxos).toHaveBeenCalledTimes(2)
  })

  it('excludes unconfirmed outside deposits and rejects forged values, scripts, parents and duplicate listings', async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.utxos.get(f.family.receive.address!)![0].value++
      },
      (f: ReturnType<typeof fixture>) => {
        f.raw.set(f.coins[0].txid, f.coins[1].parentTxHex)
      },
      (f: ReturnType<typeof fixture>) => {
        f.utxos.get(f.family.change.address!)!.push(f.utxos.get(f.family.receive.address!)![0])
      },
    ]) {
      const f = fixture()
      change(f)
      await expect(fetchLedgerSavingsSnapshot(f.contract, f.deps)).rejects.toThrow()
    }
    const f = fixture()
    f.utxos.get(f.family.receive.address!)![0].status.confirmed = false
    expect(await fetchLedgerSavingsSnapshot(f.contract, f.deps)).toMatchObject({
      totalSats: 20_000,
      availableSats: 20_000,
    })
  })

  for (const advanced of [false, true])
    for (const network of ['mainnet', 'mutinynet'] as const) {
      it(`quotes and signs mixed receive/change inputs with complete witness fees: ${network}, advanced=${advanced}`, async () => {
        const f = fixture(advanced, network)
        const snapshot = await fetchLedgerSavingsSnapshot(f.contract, f.deps)
        const quote = await quoteLedgerSavingsPayment(
          { contract: f.contract, destAddress: f.destination, amountSats: 40_000, feeRate: 2 },
          snapshot,
          f.deps,
        )
        expect(quote.payment.coins.map((coin) => coin.branch).sort()).toEqual([0, 1])
        expect(quote.payment.feeSats).toBe(quote.vsize * 2)
        expect(quote.changeSats).toBe(10_000 - quote.payment.feeSats)
        const before = Uint8Array.from(phoneSeed)
        const phone = signLedgerSavingsSeed(quote.payment, phoneSeed)
        const signed = hardwareSign(quote.payment, phone)
        const accepted = acceptLedgerSavingsSignatures(quote.payment, phone, signed)
        const tx = Transaction.fromPSBT(hex.decode(accepted), { allowUnknownInputs: true, allowUnknownOutputs: true })
        tx.finalize()
        expect(tx.vsize).toBe(quote.vsize)
        expect(phoneSeed).toEqual(before)
        expect(() => signLedgerSavingsSeed(quote.payment, HARDWARE_SEED)).toThrow('enrollment')
      })
    }

  it('selects one sufficient coin, handles an exact no-change amount, and rejects dust or unaffordable fees', async () => {
    const f = fixture()
    const snapshot = await fetchLedgerSavingsSnapshot(f.contract, f.deps)
    const input = { contract: f.contract, destAddress: f.destination, amountSats: 10_000, feeRate: 1 }
    const one = await quoteLedgerSavingsPayment(input, snapshot, f.deps)
    expect(one.payment.coins).toHaveLength(1)
    expect(one.payment.coins[0].value).toBe(20_000)
    // The fee difference from dropping a P2TR output is exactly 43 vbytes.
    const noChange = await quoteLedgerSavingsPayment(
      { ...input, amountSats: 20_000 - (one.vsize - 43) },
      { ...snapshot, coins: [f.coins[1]] },
      f.deps,
    )
    expect(noChange.changeSats).toBe(0)
    expect(noChange.payment.feeSats).toBe(noChange.vsize)
    for (const patch of [
      { amountSats: 329 },
      { amountSats: 50_000 },
      { feeRate: 0 },
      { feeRate: 11 },
      { feeRate: NaN },
    ])
      await expect(quoteLedgerSavingsPayment({ ...input, ...patch }, snapshot, f.deps)).rejects.toThrow()
  })

  it('never serializes extra caller fields and wipes every owned phone derivation', async () => {
    const f = fixture()
    await expect(
      retainLedgerSavingsPayment({ ...f.payment, seed: phoneSeed } as LedgerSavingsPayment, f.deps),
    ).rejects.toThrow('unsupported metadata')
    const derive = HDKey.prototype.deriveChild
    const master = HDKey.fromMasterSeed
    const privateKeys: HDKey[] = []
    const copies: Uint8Array[] = []
    vi.spyOn(HDKey, 'fromMasterSeed').mockImplementation((bytes, versions) => {
      copies.push(bytes)
      const key = master(bytes, versions)
      privateKeys.push(key)
      return key
    })
    vi.spyOn(HDKey.prototype, 'deriveChild').mockImplementation(function (this: HDKey, index: number) {
      const key = derive.call(this, index)
      if (key.privateKey) privateKeys.push(key)
      return key
    })
    signLedgerSavingsSeed(f.payment, phoneSeed)
    expect(privateKeys.length).toBe(6)
    expect(privateKeys.every((key) => key.privateKey === null)).toBe(true)
    expect(copies.every((copy) => copy.every((value) => value === 0))).toBe(true)
    expect(phoneSeed.every((value) => value === 0x43)).toBe(true)
  })
})

describe('retained Ledger Savings approval and broadcast lifecycle', () => {
  it('persists before signing, preserves exact approvals after reload, and broadcasts only saved fully signed bytes', async () => {
    const f = fixture()
    const record = await retainLedgerSavingsPayment(f.payment, f.deps)
    const phone = signLedgerSavingsSeed(f.payment, phoneSeed)
    await expect(saveLedgerSavingsPhoneApproval(f.contract, record.candidateId, phone, f.deps)).rejects.toThrow('Mark')
    await expect(broadcastLedgerSavingsPayment(f.contract, record.candidateId, f.deps)).rejects.toThrow('Both')
    await markLedgerSavingsSigning(f.contract, record.candidateId, f.deps)
    expect((await loadLedgerSavingsPayment(f.contract, f.deps))!.phase).toBe('signing')
    await saveLedgerSavingsPhoneApproval(f.contract, record.candidateId, phone, f.deps)
    expect((await loadLedgerSavingsPayment(f.contract, { ...f.deps }))!.phonePsbt).toBe(phone)
    const signed = hardwareSign(f.payment, phone)
    const retained = await saveLedgerSavingsSigned(f.contract, record.candidateId, signed, f.deps)
    expect(retained.phase).toBe('signed')
    expect(await broadcastLedgerSavingsPayment(f.contract, record.candidateId, f.deps)).toBe(record.candidateId)
    expect(f.reader.broadcast).toHaveBeenCalledWith(retained.txHex)
    expect((await loadLedgerSavingsPayment(f.contract, f.deps))!.phase).toBe('broadcast')
  })

  it('keeps uncertain broadcasts locked and reconciles only the exact retained transaction without broadcasting again', async () => {
    const f = await signedFixture()
    vi.mocked(f.reader.broadcast).mockRejectedValue(new Error('Lost broadcast response'))
    await expect(broadcastLedgerSavingsPayment(f.contract, f.record.candidateId, f.deps)).rejects.toThrow('Lost')
    const retained = (await loadLedgerSavingsPayment(f.contract, f.deps))!
    expect(retained.phase).toBe('signed')
    await expect(retainLedgerSavingsPayment({ ...f.payment, amountSats: 19_000 }, f.deps)).rejects.toThrow('retained')
    expect((await reconcileLedgerSavingsPayment(f.contract, f.deps)).kind).toBe('unknown')
    f.raw.set(f.record.candidateId, retained.txHex!)
    f.statuses.set(f.record.candidateId, { confirmed: false })
    expect((await reconcileLedgerSavingsPayment(f.contract, f.deps)).kind).toBe('broadcast')
    f.statuses.set(f.record.candidateId, { confirmed: true })
    expect((await reconcileLedgerSavingsPayment(f.contract, f.deps)).kind).toBe('confirmed')
    expect(f.reader.broadcast).toHaveBeenCalledTimes(1)
    const next = await retainLedgerSavingsPayment({ ...f.payment, coins: [f.coins[1]], amountSats: 10_000 }, f.deps)
    expect(next.candidateId).not.toBe(f.record.candidateId)
    expect(JSON.parse([...f.saved.values()][0]).history[0].txHex).toBe(retained.txHex)
  })

  it('requires confirmed conflict evidence before releasing a signed payment', async () => {
    const f = await signedFixture()
    const conflict = new Transaction({ version: 2 })
    conflict.addInput({ txid: f.coins[0].txid, index: 0 })
    conflict.addOutputAddress(f.destination, 29_000n, vaultAddressNetwork('mutinynet'))
    f.raw.set(conflict.id, hex.encode(conflict.toBytes(true, true)))
    f.spent.set(`${f.coins[0].txid}:0`, { spent: true, txid: conflict.id, status: { confirmed: false } })
    expect((await reconcileLedgerSavingsPayment(f.contract, f.deps)).kind).toBe('unknown')
    f.spent.get(`${f.coins[0].txid}:0`)!.status!.confirmed = true
    expect(await reconcileLedgerSavingsPayment(f.contract, f.deps)).toMatchObject({
      kind: 'conflicted',
      conflictingTxid: conflict.id,
    })
    f.raw.set(conflict.id, f.coins[1].parentTxHex)
    await expect(reconcileLedgerSavingsPayment(f.contract, f.deps)).rejects.toThrow('conflict evidence')
  })

  it('serializes tabs, rejects stale callbacks, and permits cancellation only before a signature may issue', async () => {
    const f = fixture()
    const results = await Promise.allSettled([
      retainLedgerSavingsPayment(f.payment, f.deps),
      retainLedgerSavingsPayment({ ...f.payment, amountSats: 19_000 }, f.deps),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const first = (await loadLedgerSavingsPayment(f.contract, f.deps))!
    await cancelLedgerSavingsPayment(f.contract, first.candidateId, f.deps)
    const next = await retainLedgerSavingsPayment({ ...f.payment, amountSats: 18_000 }, f.deps)
    await expect(markLedgerSavingsSigning(f.contract, first.candidateId, f.deps)).rejects.toThrow('candidate changed')
    await expect(cancelLedgerSavingsPayment(f.contract, first.candidateId, f.deps)).rejects.toThrow('candidate changed')
    await markLedgerSavingsSigning(f.contract, next.candidateId, f.deps)
    await expect(cancelLedgerSavingsPayment(f.contract, next.candidateId, f.deps)).rejects.toThrow('may have issued')
  })

  it('refuses to dispatch signatures after a coin becomes spent, loses confirmation, or persistence fails', async () => {
    const f = fixture()
    const record = await retainLedgerSavingsPayment(f.payment, f.deps)
    f.statuses.set(f.coins[0].txid, { confirmed: false })
    await expect(markLedgerSavingsSigning(f.contract, record.candidateId, f.deps)).rejects.toThrow('no longer')
    f.statuses.set(f.coins[0].txid, { confirmed: true })
    f.spent.set(`${f.coins[0].txid}:0`, { spent: true })
    await expect(markLedgerSavingsSigning(f.contract, record.candidateId, f.deps)).rejects.toThrow('no longer')
    f.spent.clear()
    const fail = {
      ...f.deps,
      storage: {
        ...f.storage,
        setItem: () => {
          throw new Error('Storage full')
        },
      },
    }
    await expect(markLedgerSavingsSigning(f.contract, record.candidateId, fail)).rejects.toThrow('Storage full')
    expect((await loadLedgerSavingsPayment(f.contract, f.deps))!.phase).toBe('prepared')
  })

  it('rejects tampered journal payment, phase, origin, metadata, fee, and signature material', async () => {
    const f = await signedFixture()
    const [key, original] = [...f.saved.entries()][0]
    for (const change of [
      (j: any) => {
        j.pending.contextDigest = '00'.repeat(32)
      },
      (j: any) => {
        j.pending.candidateId = '00'.repeat(32)
      },
      (j: any) => {
        j.pending.payment.amountSats--
      },
      (j: any) => {
        j.pending.payment.feeSats++
      },
      (j: any) => {
        j.pending.payment.coins[0].value++
      },
      (j: any) => {
        j.pending.payment.contract.context.hardware.fingerprint = '00000000'
      },
      (j: any) => {
        j.pending.phase = 'prepared'
      },
      (j: any) => {
        j.pending.txHex = f.coins[0].parentTxHex
      },
      (j: any) => {
        j.pending.phonePsbt = j.pending.signedPsbt
      },
      (j: any) => {
        j.pending.extra = true
      },
    ]) {
      const changed = JSON.parse(original)
      change(changed)
      f.saved.set(key, JSON.stringify(changed))
      await expect(loadLedgerSavingsPayment(f.contract, f.deps)).rejects.toThrow()
    }
    f.saved.set(key, original)
    const wrong = structuredClone(f.contract)
    wrong.context.vaultId = 'aa'.repeat(16)
    f.saved.set('vaulted-ledger-savings-payments-v1:' + wrong.context.vaultId, original)
    await expect(loadLedgerSavingsPayment(wrong, f.deps)).rejects.toThrow('another enrollment')
  })

  it('rejects modified device output and requires an exact broadcast txid', async () => {
    const f = await signedFixture()
    const changed = Transaction.fromPSBT(hex.decode(f.signed), { allowUnknownInputs: true, allowUnknownOutputs: true })
    // Rebuild a substituted output without bypassing the scure signed-transaction guard.
    const raw = Transaction.fromPSBT(hex.decode(buildLedgerSavingsPsbt({ ...f.payment, amountSats: 19_000 })), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    })
    raw.updateInput(0, { tapScriptSig: changed.getInput(0).tapScriptSig })
    await expect(
      saveLedgerSavingsSigned(f.contract, f.record.candidateId, hex.encode(raw.toPSBT()), f.deps),
    ).rejects.toThrow()
    vi.mocked(f.reader.broadcast).mockResolvedValue('ff'.repeat(32))
    await expect(broadcastLedgerSavingsPayment(f.contract, f.record.candidateId, f.deps)).rejects.toThrow(
      'different transaction',
    )
    expect((await loadLedgerSavingsPayment(f.contract, f.deps))!.phase).toBe('signed')
  })

  it('restores protected journals without losing signatures, regressing state or replacing an active payment', async () => {
    const f = fixture()
    const prepared = await retainLedgerSavingsPayment(f.payment, f.deps)
    const older = await exportLedgerSavingsPaymentJournal(f.contract, f.deps)
    await markLedgerSavingsSigning(f.contract, prepared.candidateId, f.deps)
    const phone = signLedgerSavingsSeed(f.payment, phoneSeed)
    await saveLedgerSavingsPhoneApproval(f.contract, prepared.candidateId, phone, f.deps)
    await saveLedgerSavingsSigned(f.contract, prepared.candidateId, hardwareSign(f.payment, phone), f.deps)
    const signed = await exportLedgerSavingsPaymentJournal(f.contract, f.deps)
    await restoreLedgerSavingsPaymentJournal(f.contract, older, f.deps)
    expect(await exportLedgerSavingsPaymentJournal(f.contract, f.deps)).toEqual(signed)
    await restoreLedgerSavingsPaymentJournal(f.contract, { version: 1, pending: null, history: [] }, f.deps)
    expect(await exportLedgerSavingsPaymentJournal(f.contract, f.deps)).toEqual(signed)
    const fresh = fixture()
    await restoreLedgerSavingsPaymentJournal(f.contract, signed, fresh.deps)
    expect(await exportLedgerSavingsPaymentJournal(f.contract, fresh.deps)).toEqual(signed)
    const foreign = fixture()
    await retainLedgerSavingsPayment({ ...foreign.payment, amountSats: 19_000 }, foreign.deps)
    await expect(restoreLedgerSavingsPaymentJournal(f.contract, signed, foreign.deps)).rejects.toThrow(
      'another active payment',
    )
    const duplicate = structuredClone(signed)
    duplicate.history.push(duplicate.pending!)
    expect(() => validateLedgerSavingsPaymentJournal(f.contract, duplicate)).toThrow('Duplicate')
    const substituted = structuredClone(signed)
    substituted.pending!.phonePsbt = signLedgerSavingsSeed(f.payment, phoneSeed)
    // Even another valid signature on the same transaction cannot replace the retained approval.
    substituted.pending!.signedPsbt = hardwareSign(f.payment, substituted.pending!.phonePsbt!)
    const changed = Transaction.fromPSBT(hex.decode(substituted.pending!.signedPsbt!), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    })
    changed.finalize()
    substituted.pending!.txHex = changed.hex
    await expect(restoreLedgerSavingsPaymentJournal(f.contract, substituted, f.deps)).rejects.toThrow('conflicts')
  })
})
