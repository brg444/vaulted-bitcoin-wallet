import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { Transaction } from '@scure/btc-signer'
import { TaprootControlBlock } from '@scure/btc-signer/psbt.js'
import { bitcoinDustSats } from './bitcoin'
import { readBounded } from './bounded'
import {
  broadcastTx,
  esploraBase,
  fetchAddressTxs,
  fetchAddressUtxos,
  fetchTxHex,
  type EsploraTx,
  type EsploraUtxo,
} from './esplora'
import { historyFromTxs, type VaultHistoryItem } from './history'
import {
  acceptLedgerSavingsSignatures,
  buildLedgerSavingsPsbt,
  requireLedgerSavingsPhoneApproval,
  signLedgerSavingsWithPhone,
  type LedgerSavingsCoin,
  type LedgerSavingsContract,
  type LedgerSavingsPayment,
} from './ledgerSavings'
import { canonicalLedgerValue, validateLedgerSavingsContract } from './program/ledgerEnrollment'
import { buildLedgerNativeFamily } from './program/ledgerNativeFamily'
import { ledgerBip32Versions, ledgerSavingsContextDigest } from './program/ledgerNativeKeys'
import { browserVaultLockManager, requireVaultLockManager, type VaultLockManager } from './vtxo/lock'

const OPTIONS = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true } as const
const STORE = 'vaulted-ledger-savings-payments-v1:'
const MAX_MONEY = 2_100_000_000_000_000

export interface LedgerSavingsSnapshot {
  coins: LedgerSavingsCoin[]
  totalSats: number
  availableSats: number
  history: VaultHistoryItem[]
  receiveAddress: string
  changeAddress: string
}
export interface LedgerSavingsPaymentRecord {
  version: 1
  candidateId: string
  contextDigest: string
  payment: LedgerSavingsPayment
  phase: 'prepared' | 'signing' | 'signed' | 'broadcast'
  phonePsbt?: string
  signedPsbt?: string
  txHex?: string
}
export interface LedgerSavingsChainReader {
  addressUtxos(address: string): Promise<EsploraUtxo[]>
  addressTransactions(address: string): Promise<EsploraTx[]>
  transactionHex(txid: string): Promise<string>
  transactionStatus(txid: string): Promise<{ confirmed: boolean } | null>
  outspend(txid: string, vout: number): Promise<{ spent: boolean; txid?: string; status?: { confirmed: boolean } }>
  broadcast(txHex: string): Promise<string>
}
export interface LedgerSavingsWalletDependencies {
  chain?: LedgerSavingsChainReader
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  locks?: VaultLockManager
}

async function json(path: string, missing = false): Promise<unknown> {
  const response = await fetch(`${esploraBase()}${path}`, { cache: 'no-store' })
  if (missing && response.status === 404) return null
  const text = await readBounded(response)
  if (!response.ok) throw new Error('Could not verify the Savings transaction outcome')
  return JSON.parse(text)
}
const chain: LedgerSavingsChainReader = {
  addressUtxos: (address) => fetchAddressUtxos(address),
  addressTransactions: (address) => fetchAddressTxs(address),
  transactionHex: (txid) => fetchTxHex(txid),
  transactionStatus: async (txid) => {
    const value = (await json(`/tx/${txid}/status`, true)) as { confirmed?: unknown } | null
    if (value === null) return null
    if (typeof value?.confirmed !== 'boolean') throw new Error('Invalid Savings confirmation response')
    return { confirmed: value.confirmed }
  },
  outspend: async (txid, vout) => {
    const value = (await json(`/tx/${txid}/outspend/${vout}`)) as Awaited<
      ReturnType<LedgerSavingsChainReader['outspend']>
    >
    if (
      typeof value?.spent !== 'boolean' ||
      (value.spent && (!/^[0-9a-f]{64}$/.test(value.txid || '') || typeof value.status?.confirmed !== 'boolean'))
    )
      throw new Error('Invalid Savings outpoint response')
    return value
  },
  broadcast: (txHex) => broadcastTx(txHex),
}

function rawTransaction(raw: string): Transaction {
  if (typeof raw !== 'string' || raw.length > 8_000_000 || !/^(?:[0-9a-f]{2})+$/.test(raw))
    throw new Error('Invalid Savings parent transaction')
  const tx = Transaction.fromRaw(hex.decode(raw), OPTIONS)
  if (hex.encode(tx.toBytes(true, true)) !== raw) throw new Error('Noncanonical Savings transaction')
  return tx
}

/** Discover both fixed enrolled coordinates; every selectable coin is checked against its complete parent. */
export async function fetchLedgerSavingsSnapshot(
  raw: LedgerSavingsContract,
  deps: LedgerSavingsWalletDependencies = {},
): Promise<LedgerSavingsSnapshot> {
  const contract = validateLedgerSavingsContract(raw)
  const family = buildLedgerNativeFamily(contract.context, contract.spendingPolicy)
  const reader = deps.chain || chain
  const addresses = [family.receive.address!, family.change.address!]
  const loaded = await Promise.all(
    addresses.map(async (address) => {
      const [utxos, transactions] = await Promise.all([
        reader.addressUtxos(address),
        reader.addressTransactions(address),
      ])
      if (!Array.isArray(utxos) || utxos.length > 1000 || !Array.isArray(transactions))
        throw new Error('Invalid Savings address response')
      return { utxos, transactions }
    }),
  )
  const transactions = new Map<string, EsploraTx>()
  for (const item of loaded)
    for (const tx of item.transactions) {
      const previous = transactions.get(tx.txid)
      if (!previous || (!previous.status.confirmed && tx.status.confirmed)) transactions.set(tx.txid, tx)
    }
  const ownSpends = new Set(
    [...transactions.values()]
      .filter((tx) => tx.vin.some((input) => addresses.includes(input.prevout?.scriptpubkey_address || '')))
      .map((tx) => tx.txid),
  )
  const parents = new Map<string, Promise<Transaction>>()
  const seen = new Set<string>()
  const coins: LedgerSavingsCoin[] = []
  let pendingChange = 0
  for (const branch of [0, 1] as const)
    for (const coin of loaded[branch].utxos) {
      if (
        !/^[0-9a-f]{64}$/.test(coin.txid) ||
        !Number.isInteger(coin.vout) ||
        coin.vout < 0 ||
        coin.vout > 0xffffffff ||
        !Number.isSafeInteger(coin.value) ||
        coin.value <= 0 ||
        coin.value > MAX_MONEY ||
        typeof coin.status?.confirmed !== 'boolean'
      )
        throw new Error('Invalid Savings coin response')
      const outpoint = `${coin.txid}:${coin.vout}`
      if (seen.has(outpoint)) throw new Error('Duplicate Savings coin response')
      seen.add(outpoint)
      if (!parents.has(coin.txid)) parents.set(coin.txid, reader.transactionHex(coin.txid).then(rawTransaction))
      const parent = await parents.get(coin.txid)!
      if (parent.id !== coin.txid || coin.vout >= parent.outputsLength) throw new Error('Savings parent mismatch')
      const output = parent.getOutput(coin.vout)
      const tree = branch === 0 ? family.receive : family.change
      if (output.amount !== BigInt(coin.value) || hex.encode(output.script!) !== hex.encode(tree.script))
        throw new Error('Savings coin differs from its enrolled parent output')
      if (coin.status.confirmed)
        coins.push({
          txid: coin.txid,
          vout: coin.vout,
          value: coin.value,
          ...(coin.status.block_height === undefined ? {} : { confirmedHeight: coin.status.block_height }),
          branch,
          index: 0,
          parentTxHex: hex.encode(parent.toBytes(true, true)),
        })
      else if (ownSpends.has(coin.txid)) pendingChange += coin.value
    }
  const availableSats = coins.reduce((sum, coin) => sum + coin.value, 0)
  if (!Number.isSafeInteger(availableSats + pendingChange) || availableSats + pendingChange > MAX_MONEY)
    throw new Error('Invalid Savings balance')
  // Treat both coordinates as one account before classification: a change output
  // must not produce a second deposit row for a payment already counted as sent.
  const alias = (io: EsploraTx['vout'][number]) => ({
    ...io,
    scriptpubkey_address: addresses.includes(io.scriptpubkey_address || '') ? addresses[0] : io.scriptpubkey_address,
  })
  const history = historyFromTxs(
    [...transactions.values()].map((tx) => ({
      ...tx,
      vin: tx.vin.map((input) => ({ ...input, ...(input.prevout ? { prevout: alias(input.prevout) } : {}) })),
      vout: tx.vout.map(alias),
    })),
    addresses[0],
    'savings',
  )
  return {
    coins: coins.sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout),
    totalSats: availableSats + pendingChange,
    availableSats,
    history,
    receiveAddress: addresses[0],
    changeAddress: addresses[1],
  }
}

function paymentFacts(payment: LedgerSavingsPayment) {
  validateLedgerSavingsContract(payment.contract)
  const normalized: LedgerSavingsPayment = {
    contract: payment.contract,
    coins: payment.coins.map((coin) => ({
      txid: coin.txid,
      vout: coin.vout,
      value: coin.value,
      ...(coin.confirmedHeight === undefined ? {} : { confirmedHeight: coin.confirmedHeight }),
      branch: coin.branch,
      index: coin.index,
      parentTxHex: coin.parentTxHex,
    })),
    destAddress: payment.destAddress,
    amountSats: payment.amountSats,
    feeSats: payment.feeSats,
  }
  if (canonicalLedgerValue(payment) !== canonicalLedgerValue(normalized))
    throw new Error('Ledger Savings payment contains unsupported metadata')
  if (payment.coins.length > 128 || !Number.isSafeInteger(payment.feeSats) || payment.feeSats <= 0)
    throw new Error('Invalid Ledger Savings payment fee or input count')
  if (
    payment.coins.some((coin) => coin.value > MAX_MONEY) ||
    payment.coins.reduce((sum, coin) => sum + coin.value, 0) > MAX_MONEY
  )
    throw new Error('Ledger Savings amount exceeds the Bitcoin supply')
  for (const coin of payment.coins) rawTransaction(coin.parentTxHex)
  const tx = Transaction.fromPSBT(hex.decode(buildLedgerSavingsPsbt(payment)), OPTIONS)
  const measured = tx.clone()
  for (let i = 0; i < measured.inputsLength; i++) {
    const leaf = measured.getInput(i).tapLeafScript![0]
    measured.updateInput(i, {
      finalScriptWitness: [
        new Uint8Array(64),
        new Uint8Array(64),
        leaf[1].slice(0, -1),
        TaprootControlBlock.encode(leaf[0]),
      ],
    })
  }
  const vsize = measured.vsize
  if (
    payment.feeSats > payment.contract.spendingPolicy.absoluteFeeCapSats ||
    payment.feeSats > vsize * payment.contract.spendingPolicy.feerateCapSatPerV
  )
    throw new Error('Ledger Savings payment fee exceeds the enrolled caps')
  return { tx, vsize, changeSats: tx.outputsLength === 2 ? Number(tx.getOutput(1).amount) : 0 }
}

export async function quoteLedgerSavingsPayment(
  input: { contract: LedgerSavingsContract; destAddress: string; amountSats: number; feeRate: number },
  snapshot?: LedgerSavingsSnapshot,
  deps: LedgerSavingsWalletDependencies = {},
) {
  input = structuredClone(input)
  const contract = validateLedgerSavingsContract(input.contract)
  if (!Number.isFinite(input.feeRate) || input.feeRate < 1 || input.feeRate > contract.spendingPolicy.feerateCapSatPerV)
    throw new Error('Savings fee rate exceeds the enrolled limits')
  if (
    !Number.isSafeInteger(input.amountSats) ||
    input.amountSats < bitcoinDustSats(input.destAddress, contract.context.network)
  )
    throw new Error('Invalid Savings payment amount')
  const available = (snapshot || (await fetchLedgerSavingsSnapshot(contract, deps))).coins
  if (available.length > 1000) throw new Error('Too many Savings coins')
  const candidates: LedgerSavingsCoin[][] = available
    .filter((coin) => coin.value > input.amountSats)
    .sort((a, b) => a.value - b.value || a.txid.localeCompare(b.txid) || a.vout - b.vout)
    .map((coin) => [coin])
  const largest = [...available].sort((a, b) => b.value - a.value || a.txid.localeCompare(b.txid) || a.vout - b.vout)
  for (let i = 2; i <= Math.min(largest.length, 128); i++) candidates.push(largest.slice(0, i))
  for (const coins of candidates) {
    const excess = coins.reduce((sum, coin) => sum + coin.value, 0) - input.amountSats
    if (!Number.isSafeInteger(excess) || excess <= 0) continue
    for (const change of [true, false]) {
      if (change && excess < 331) continue
      const trial: LedgerSavingsPayment = {
        contract,
        coins: structuredClone(coins),
        destAddress: input.destAddress,
        amountSats: input.amountSats,
        feeSats: change ? excess - 330 : excess,
      }
      // Estimate geometry before applying the actual fee cap: the trial amount
      // deliberately leaves exactly one dust-sized change output.
      const tx = Transaction.fromPSBT(hex.decode(buildLedgerSavingsPsbt(trial)), OPTIONS)
      const measured = tx.clone()
      for (let i = 0; i < measured.inputsLength; i++) {
        const leaf = measured.getInput(i).tapLeafScript![0]
        measured.updateInput(i, {
          finalScriptWitness: [
            new Uint8Array(64),
            new Uint8Array(64),
            leaf[1].slice(0, -1),
            TaprootControlBlock.encode(leaf[0]),
          ],
        })
      }
      const minimumFee = Math.ceil(measured.vsize * input.feeRate)
      trial.feeSats = change ? minimumFee : excess
      if (
        (change && excess - minimumFee < 330) ||
        (!change && excess < minimumFee) ||
        trial.feeSats > contract.spendingPolicy.absoluteFeeCapSats ||
        trial.feeSats > measured.vsize * contract.spendingPolicy.feerateCapSatPerV
      )
        continue
      const facts = paymentFacts(trial)
      return { payment: trial, vsize: facts.vsize, changeSats: facts.changeSats }
    }
  }
  throw new Error('Confirmed Savings funds do not cover this payment and fee')
}

/** The new Savings phone seed is separate from the existing Spending scalar. */
export function signLedgerSavingsSeed(payment: LedgerSavingsPayment, seed: Uint8Array): string {
  paymentFacts(payment)
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('Ledger Savings phone seed must be 32 bytes')
  const copy = Uint8Array.from(seed)
  const keys: HDKey[] = []
  try {
    const context = payment.contract.context
    let key = HDKey.fromMasterSeed(copy, ledgerBip32Versions(context.network))
    keys.push(key)
    if (key.fingerprint.toString(16).padStart(8, '0') !== context.phone.fingerprint)
      throw new Error('Savings phone seed does not match enrollment')
    for (const index of context.phone.path) {
      key = key.deriveChild(index)
      keys.push(key)
      if (key.index !== index) throw new Error('Invalid Savings phone account derivation')
    }
    return signLedgerSavingsWithPhone(payment, key)
  } finally {
    copy.fill(0)
    for (const key of keys) key.wipePrivateData()
  }
}

export interface LedgerSavingsPaymentJournal {
  version: 1
  pending: LedgerSavingsPaymentRecord | null
  history: LedgerSavingsPaymentRecord[]
}
type Journal = LedgerSavingsPaymentJournal
function digest(contract: LedgerSavingsContract): string {
  return hex.encode(ledgerSavingsContextDigest(contract.context))
}
function validateRecord(contract: LedgerSavingsContract, raw: LedgerSavingsPaymentRecord): LedgerSavingsPaymentRecord {
  if (
    !raw ||
    raw.version !== 1 ||
    raw.contextDigest !== digest(contract) ||
    canonicalLedgerValue(raw.payment?.contract) !== canonicalLedgerValue(contract)
  )
    throw new Error('Saved Ledger Savings payment belongs to another enrollment')
  const facts = paymentFacts(raw.payment)
  if (raw.candidateId !== facts.tx.id || !['prepared', 'signing', 'signed', 'broadcast'].includes(raw.phase))
    throw new Error('Saved Ledger Savings candidate changed')
  const rebuilt: LedgerSavingsPaymentRecord = {
    version: 1,
    candidateId: facts.tx.id,
    contextDigest: raw.contextDigest,
    payment: raw.payment,
    phase: raw.phase,
  }
  if (raw.phase === 'prepared') {
    if (raw.phonePsbt || raw.signedPsbt || raw.txHex) throw new Error('Prepared Savings payment contains signatures')
  } else if (raw.phonePsbt) {
    requireLedgerSavingsPhoneApproval(raw.payment, raw.phonePsbt)
    rebuilt.phonePsbt = raw.phonePsbt
  }
  if (raw.phase === 'signed' || raw.phase === 'broadcast') {
    if (!raw.phonePsbt || !raw.signedPsbt || !raw.txHex) throw new Error('Signed Savings payment is incomplete')
    const accepted = acceptLedgerSavingsSignatures(raw.payment, raw.phonePsbt, raw.signedPsbt)
    const tx = Transaction.fromPSBT(hex.decode(accepted), OPTIONS)
    tx.finalize()
    if (accepted !== raw.signedPsbt || tx.hex !== raw.txHex)
      throw new Error('Saved Savings signatures or transaction changed')
    rebuilt.signedPsbt = accepted
    rebuilt.txHex = tx.hex
  }
  if (canonicalLedgerValue(raw) !== canonicalLedgerValue(rebuilt))
    throw new Error('Saved Savings payment metadata changed')
  return structuredClone(rebuilt)
}

function readJournal(contract: LedgerSavingsContract, storage: Pick<Storage, 'getItem' | 'setItem'>): Journal {
  const raw = storage.getItem(STORE + contract.context.vaultId)
  if (!raw) return { version: 1, pending: null, history: [] }
  if (raw.length > 12_000_000) throw new Error('Saved Savings journal is too large')
  return validateLedgerSavingsPaymentJournal(contract, JSON.parse(raw))
}

export function validateLedgerSavingsPaymentJournal(
  contract: LedgerSavingsContract,
  raw: unknown,
): LedgerSavingsPaymentJournal {
  contract = validateLedgerSavingsContract(contract)
  const encoded = JSON.stringify(raw)
  if (!encoded || encoded.length > 12_000_000) throw new Error('Saved Savings journal is missing or too large')
  const value = raw as Journal
  if (!value || value.version !== 1 || !Array.isArray(value.history) || value.history.length > 100)
    throw new Error('Invalid Savings journal')
  const rebuilt: Journal = {
    version: 1,
    pending: value.pending === null ? null : validateRecord(contract, value.pending),
    history: value.history.map((record) => validateRecord(contract, record)),
  }
  if (canonicalLedgerValue(value) !== canonicalLedgerValue(rebuilt)) throw new Error('Saved Savings journal changed')
  const records = [...rebuilt.history, ...(rebuilt.pending ? [rebuilt.pending] : [])]
  if (new Set(records.map((record) => record.candidateId)).size !== records.length)
    throw new Error('Duplicate Savings journal candidate')
  return rebuilt
}
function writeJournal(
  contract: LedgerSavingsContract,
  journal: Journal,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
) {
  const value = JSON.stringify(journal)
  if (value.length > 12_000_000) throw new Error('Saved Savings journal is too large')
  storage.setItem(STORE + contract.context.vaultId, value)
  if (storage.getItem(STORE + contract.context.vaultId) !== value)
    throw new Error('Could not retain the Savings payment')
}
async function locked<T>(
  contract: LedgerSavingsContract,
  deps: LedgerSavingsWalletDependencies,
  fn: (journal: Journal, save: () => void) => Promise<T> | T,
): Promise<T> {
  const valid = validateLedgerSavingsContract(structuredClone(contract))
  const storage = deps.storage || localStorage
  const locks = requireVaultLockManager(deps.locks || browserVaultLockManager())
  return locks.request(`vaulted-ledger-savings:${valid.context.vaultId}`, { mode: 'exclusive' }, async (lock) => {
    if (!lock) throw new Error('Savings coordination lock unavailable')
    const journal = readJournal(valid, storage)
    return fn(journal, () => writeJournal(valid, journal, storage))
  })
}
function current(journal: Journal, candidateId: string): LedgerSavingsPaymentRecord {
  if (!journal.pending || journal.pending.candidateId !== candidateId)
    throw new Error('Savings candidate changed; reopen the retained payment')
  return journal.pending
}

export type LedgerSavingsOutcomeKind = 'prepared' | 'signing' | 'unknown' | 'broadcast' | 'confirmed' | 'conflicted'
export type LedgerSavingsReconciliation =
  | { kind: 'none'; record?: never; conflictingTxid?: never }
  | { kind: LedgerSavingsOutcomeKind; record: LedgerSavingsPaymentRecord; conflictingTxid?: string }
async function outcome(
  record: LedgerSavingsPaymentRecord,
  reader: LedgerSavingsChainReader,
): Promise<{ kind: LedgerSavingsOutcomeKind; conflictingTxid?: string }> {
  if (record.phase === 'prepared') return { kind: record.phase }
  const status = await reader.transactionStatus(record.candidateId)
  if (status) {
    if (rawTransaction(await reader.transactionHex(record.candidateId)).id !== record.candidateId)
      throw new Error('Savings transaction lookup changed its identity')
    return { kind: status.confirmed ? 'confirmed' : 'broadcast' }
  }
  for (const coin of record.payment.coins) {
    const spent = await reader.outspend(coin.txid, coin.vout)
    if (spent.spent && spent.txid !== record.candidateId && spent.status?.confirmed) {
      const conflict = rawTransaction(await reader.transactionHex(spent.txid!))
      if (
        conflict.id !== spent.txid ||
        !Array.from({ length: conflict.inputsLength }, (_, i) => conflict.getInput(i)).some(
          (input) => hex.encode(input.txid!) === coin.txid && input.index === coin.vout,
        )
      )
        throw new Error('Savings conflict evidence does not spend the retained input')
      return { kind: 'conflicted', conflictingTxid: spent.txid }
    }
  }
  return { kind: record.phase === 'signing' ? 'signing' : 'unknown' }
}

export async function loadLedgerSavingsPayment(
  contract: LedgerSavingsContract,
  deps: LedgerSavingsWalletDependencies = {},
) {
  return locked(contract, deps, (journal) => (journal.pending ? structuredClone(journal.pending) : null))
}

export async function exportLedgerSavingsPaymentJournal(
  contract: LedgerSavingsContract,
  deps: LedgerSavingsWalletDependencies = {},
): Promise<LedgerSavingsPaymentJournal> {
  return locked(contract, deps, (journal) => structuredClone(journal))
}

/** Importing an older backup cannot erase a pending approval or roll back a retained signature. */
export async function restoreLedgerSavingsPaymentJournal(
  contract: LedgerSavingsContract,
  raw: unknown,
  deps: LedgerSavingsWalletDependencies = {},
) {
  const incoming = validateLedgerSavingsPaymentJournal(contract, structuredClone(raw))
  const merge = (
    current: LedgerSavingsPaymentRecord | undefined,
    added: LedgerSavingsPaymentRecord,
  ): LedgerSavingsPaymentRecord => {
    if (!current) return added
    if (
      canonicalLedgerValue(current.payment) !== canonicalLedgerValue(added.payment) ||
      (current.phonePsbt && added.phonePsbt && current.phonePsbt !== added.phonePsbt) ||
      (current.signedPsbt && added.signedPsbt && current.signedPsbt !== added.signedPsbt)
    )
      throw new Error('Restored Savings approval conflicts with the retained candidate')
    const rank = { prepared: 0, signing: 1, signed: 2, broadcast: 3 }
    return rank[added.phase] > rank[current.phase] || (!current.phonePsbt && added.phonePsbt) ? added : current
  }
  return locked(contract, deps, (journal, save) => {
    if (journal.pending && incoming.pending && journal.pending.candidateId !== incoming.pending.candidateId)
      throw new Error('Restored Savings journal would replace another active payment')
    const records = new Map(journal.history.map((record) => [record.candidateId, record]))
    for (const record of incoming.history)
      records.set(record.candidateId, merge(records.get(record.candidateId), record))
    const pending = incoming.pending ? merge(journal.pending || undefined, incoming.pending) : journal.pending
    if (pending) {
      journal.pending = merge(records.get(pending.candidateId), pending)
      records.delete(pending.candidateId)
    }
    journal.history = [...records.values()]
    validateLedgerSavingsPaymentJournal(contract, journal)
    save()
    return structuredClone(journal)
  })
}
export async function retainLedgerSavingsPayment(
  payment: LedgerSavingsPayment,
  deps: LedgerSavingsWalletDependencies = {},
) {
  const snapshot = structuredClone(payment)
  const facts = paymentFacts(snapshot)
  return locked(snapshot.contract, deps, async (journal, save) => {
    if (journal.history.some((record) => record.candidateId === facts.tx.id))
      throw new Error('This Savings payment is already retained in history')
    if (journal.pending) {
      if (journal.pending.candidateId === facts.tx.id) return structuredClone(journal.pending)
      const prior = await outcome(journal.pending, deps.chain || chain)
      if (!['broadcast', 'confirmed', 'conflicted'].includes(prior.kind))
        throw new Error('Complete the retained Savings payment before creating another')
      journal.history.push(journal.pending)
      if (journal.history.length > 100)
        throw new Error('Archive the Savings payment journal before creating another payment')
    }
    journal.pending = {
      version: 1,
      candidateId: facts.tx.id,
      contextDigest: digest(snapshot.contract),
      payment: snapshot,
      phase: 'prepared',
    }
    save()
    return structuredClone(journal.pending)
  })
}
export async function markLedgerSavingsSigning(
  contract: LedgerSavingsContract,
  candidateId: string,
  deps: LedgerSavingsWalletDependencies = {},
) {
  return locked(contract, deps, async (journal, save) => {
    const record = current(journal, candidateId)
    if (record.phase === 'prepared') {
      const reader = deps.chain || chain
      const evidence = await Promise.all(
        record.payment.coins.map(async (coin) => {
          const [status, spent] = await Promise.all([
            reader.transactionStatus(coin.txid),
            reader.outspend(coin.txid, coin.vout),
          ])
          return status?.confirmed === true && spent.spent === false
        }),
      )
      if (evidence.some((valid) => !valid))
        throw new Error('Savings coins are no longer confirmed and available; review this payment again')
      record.phase = 'signing'
      save()
    }
    return structuredClone(record)
  })
}
export async function saveLedgerSavingsPhoneApproval(
  contract: LedgerSavingsContract,
  candidateId: string,
  phonePsbt: string,
  deps: LedgerSavingsWalletDependencies = {},
) {
  return locked(contract, deps, (journal, save) => {
    const record = current(journal, candidateId)
    if (record.phase !== 'signing') throw new Error('Mark the retained Savings payment before requesting a signature')
    requireLedgerSavingsPhoneApproval(record.payment, phonePsbt)
    if (record.phonePsbt && record.phonePsbt !== phonePsbt) throw new Error('Savings phone approval already retained')
    record.phonePsbt = phonePsbt
    save()
    return structuredClone(record)
  })
}
export async function saveLedgerSavingsSigned(
  contract: LedgerSavingsContract,
  candidateId: string,
  signedPsbt: string,
  deps: LedgerSavingsWalletDependencies = {},
) {
  return locked(contract, deps, (journal, save) => {
    const record = current(journal, candidateId)
    if (!record.phonePsbt) throw new Error('Savings phone approval missing')
    const accepted = acceptLedgerSavingsSignatures(record.payment, record.phonePsbt, signedPsbt)
    if (record.signedPsbt && record.signedPsbt !== accepted)
      throw new Error('Savings hardware approval already retained')
    const tx = Transaction.fromPSBT(hex.decode(accepted), OPTIONS)
    tx.finalize()
    record.signedPsbt = accepted
    record.txHex = tx.hex
    if (record.phase !== 'broadcast') record.phase = 'signed'
    save()
    return structuredClone(record)
  })
}
export async function broadcastLedgerSavingsPayment(
  contract: LedgerSavingsContract,
  candidateId: string,
  deps: LedgerSavingsWalletDependencies = {},
) {
  return locked(contract, deps, async (journal, save) => {
    const record = current(journal, candidateId)
    if (!record.txHex || !['signed', 'broadcast'].includes(record.phase))
      throw new Error('Both Savings signatures must be retained before broadcast')
    const returned = await (deps.chain || chain).broadcast(record.txHex)
    if (returned !== record.candidateId) throw new Error('Savings broadcast returned a different transaction')
    record.phase = 'broadcast'
    save()
    return record.candidateId
  })
}
export async function reconcileLedgerSavingsPayment(
  contract: LedgerSavingsContract,
  deps: LedgerSavingsWalletDependencies = {},
): Promise<LedgerSavingsReconciliation> {
  return locked(contract, deps, async (journal, save) => {
    if (!journal.pending) return { kind: 'none' as const }
    const result = await outcome(journal.pending, deps.chain || chain)
    if (
      ['broadcast', 'confirmed'].includes(result.kind) &&
      journal.pending.txHex &&
      journal.pending.phase !== 'broadcast'
    ) {
      journal.pending.phase = 'broadcast'
      save()
    }
    return { ...result, record: structuredClone(journal.pending) }
  })
}
export async function cancelLedgerSavingsPayment(
  contract: LedgerSavingsContract,
  candidateId: string,
  deps: LedgerSavingsWalletDependencies = {},
) {
  return locked(contract, deps, (journal, save) => {
    if (current(journal, candidateId).phase !== 'prepared')
      throw new Error('A Savings signature may have issued; retain this payment until its outcome is known')
    journal.pending = null
    save()
  })
}
