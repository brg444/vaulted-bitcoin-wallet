import {
  CSVMultisigTapscript,
  Intent,
  PrevArkTxField,
  Transaction,
  VtxoTaprootTree,
  buildOffchainTx,
  createAssetPacket,
  setArkPsbtField,
} from '@arkade-os/sdk'
import { Script } from '@scure/btc-signer'
import { TaprootControlBlock } from '@scure/btc-signer/psbt.js'
import { bytesToHex, hexToBytes, requireLowerHex } from '../hex'
import {
  applyDebit,
  applyMatureCredit,
  buildHistoryProof,
  decodeRollingState,
  encodeRollingState,
  historyWitness,
  receiptMessage,
  verifyRollingHistory,
  type RollingDebit,
  type RollingReceipt,
  type RollingState,
} from './allowance'
import { RollingAllowanceScript, type RollingContractParameters } from './contract'

export interface RollingSource {
  previousTxHex: string
  index: number
}
export interface RollingNativeTransaction {
  arkTx: Transaction
  checkpoints: Transaction[]
  before: RollingState
  after: RollingState
  debit?: RollingDebit
}

export interface RollingRenewalTransaction {
  proof: Transaction
  message: string
  before: RollingState
  after: RollingState
  debit?: RollingDebit
}

/** Constructs one controller-bearing renewal; lifecycle admission remains SDK-owned. */
export function buildRollingRenewal(
  params: RollingContractParameters,
  sources: readonly RollingSource[],
  debits: readonly RollingDebit[],
  fee: number,
  validAt: number,
  expireAt: number,
): RollingRenewalTransaction {
  const ctx = context(params, sources, debits, false)
  if (
    !Number.isSafeInteger(validAt) ||
    !Number.isSafeInteger(expireAt) ||
    validAt < 0 ||
    expireAt <= validAt ||
    expireAt - validAt > 3600
  )
    throw new Error('Invalid renewal validity')
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > params.policy.feeCap || (fee > 0 && sources.length < 2))
    throw new Error('Invalid renewal fee')
  const leaf = ctx.script.renew()
  const message = Intent.encodeMessage({
    type: 'register',
    onchain_output_indexes: [],
    valid_at: validAt,
    expire_at: expireAt,
    cosigners_public_keys: [params.policy.delegatePubkey],
  })
  const inputs = ctx.inputs.map((input) => ({
    txid: hexToBytes(input.txid),
    index: input.vout,
    sequence: 0xffffffff,
    witnessUtxo: { amount: BigInt(input.value), script: ctx.script.pkScript },
    tapLeafScript: [leaf],
    unknown: [VtxoTaprootTree.encode(input.tapTree)],
  }))
  const outputs = sources.map((source, i) => ({
    amount: ctx.previous[i].getOutput(source.index).amount!,
    script: ctx.script.pkScript,
  }))
  outputs[outputs.length - 1].amount -= BigInt(fee)
  if (outputs[outputs.length - 1].amount < 330n) throw new Error('Renewal fee makes dust')
  const proof = Intent.create(message, inputs, outputs)
  let after = ctx.before
  let debit: RollingDebit | undefined
  let witness: Uint8Array[] = []
  if (fee > 0) {
    debit = {
      sequence: ctx.before.sequence,
      amount: fee,
      parentTxid: ctx.previous[0].id,
      parentIndex: sources[0].index,
    }
    const history = buildHistoryProof(debits, ctx.before.sequence).proof
    after = applyDebit(ctx.before, params.policy.budget, debit, history)
    witness = historyWitness(history)
  }
  for (let i = 0; i < ctx.previous.length; i++)
    setArkPsbtField(proof, i + 1, PrevArkTxField, ctx.previous[i].toBytes(true, true))
  const index = new Uint8Array(2)
  new DataView(index.buffer).setUint16(0, params.policy.controllerIndex, true)
  const assets = [{ assetId: `${params.policy.controllerTxid}${bytesToHex(index)}`, amount: 1n }]
  const marker = createAssetPacket(new Map([[1, assets]]), [{ address: '', assets }]).serialize()
  const code = ctx.script.programs.renew
  const encodedWitness = concat(compact(witness.length), ...witness.map((part) => concat(compact(part.length), part)))
  const entries = sources.map((_, i) =>
    concat(new Uint8Array([i + 1, 0]), compact(code.length), code, compact(encodedWitness.length), encodedWitness),
  )
  proof.addOutput({
    amount: 0n,
    script: encodeExtension([
      { type: 0, data: marker },
      { type: 1, data: concat(compact(entries.length), ...entries) },
      { type: 2, data: encodeRollingState(after) },
    ]),
  })
  const stripped = proof.toBytes(false, false).length
  if (fee > stripped * params.policy.feerateCap) throw new Error('Renewal feerate exceeds limit')
  const leafLength = leaf[1].length - 1
  const controlLength = TaprootControlBlock.encode(leaf[0]).length
  const witnessWeight =
    1 + 3 * 66 + compact(leafLength).length + leafLength + compact(controlLength).length + controlLength
  if (stripped * 4 + 2 + proof.inputsLength * witnessWeight > 40000)
    throw new Error('Signed rolling renewal exceeds Operator weight limit; select fewer inputs')
  return { proof, message, before: ctx.before, after, debit }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function compact(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0 || n > 100_000) throw new Error('Invalid packet length')
  if (n < 253) return new Uint8Array([n])
  const value = new Uint8Array(n <= 65535 ? 3 : 5)
  value[0] = n <= 65535 ? 253 : 254
  const view = new DataView(value.buffer)
  if (n <= 65535) view.setUint16(1, n, true)
  else view.setUint32(1, n, true)
  return value
}

// Extension envelope lengths use unsigned LEB128; Emulator witness lengths
// use Bitcoin CompactSize. They are distinct protocol encodings.
function uvarint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0 || n > 100000) throw new Error('Invalid extension length')
  const result: number[] = []
  while (n >= 128) {
    result.push((n & 127) | 128)
    n = Math.floor(n / 128)
  }
  result.push(n)
  return new Uint8Array(result)
}

function encodeExtension(packets: { type: number; data: Uint8Array }[]): Uint8Array {
  const payload = concat(
    new TextEncoder().encode('ARK'),
    ...packets.map((p) => concat(new Uint8Array([p.type]), uvarint(p.data.length), p.data)),
  )
  return Script.encode(['RETURN', payload])
}

function stateFromTransaction(tx: Transaction): RollingState {
  let found: RollingState | undefined
  let extensions = 0
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i)
    if (!output.script || output.script[0] !== 0x6a) continue
    const ops = Script.decode(output.script)
    if (ops.length !== 2 || !(ops[1] instanceof Uint8Array)) continue
    const payload = ops[1]
    if (bytesToHex(payload.slice(0, 3)) !== '41524b') continue
    if (++extensions !== 1 || output.amount !== 0n) throw new Error('Ambiguous extension')
    let cursor = 3
    const readLength = (): number => {
      const begin = cursor
      let result = 0
      let factor = 1
      for (let i = 0; i < 3; i++) {
        if (cursor >= payload.length) throw new Error('Truncated extension')
        const n = payload[cursor++]
        result += (n & 127) * factor
        if (n < 128) {
          if (result > 100000 || bytesToHex(uvarint(result)) !== bytesToHex(payload.slice(begin, cursor)))
            throw new Error('Noncanonical extension length')
          return result
        }
        factor *= 128
      }
      throw new Error('Invalid extension length')
    }
    const seen = new Set<number>()
    while (cursor < payload.length) {
      const type = payload[cursor++]
      if (seen.has(type)) throw new Error('Duplicate extension packet')
      seen.add(type)
      const size = readLength()
      if (cursor + size > payload.length) throw new Error('Truncated extension packet')
      if (type === 2) found = decodeRollingState(payload.slice(cursor, cursor + size))
      cursor += size
    }
  }
  if (!found) throw new Error('Controller state missing')
  return found
}

function context(
  params: RollingContractParameters,
  sources: readonly RollingSource[],
  debits: readonly RollingDebit[],
  credit: boolean,
) {
  const script = new RollingAllowanceScript(params)
  if (sources.length < 1 || sources.length > 5 || sources[0].index !== 0) throw new Error('Invalid rolling sources')
  const seen = new Set<string>()
  let principal = 0
  const previous = sources.map((source, i) => {
    requireLowerHex(source.previousTxHex, 'previous transaction')
    if (source.previousTxHex.length > 200000 || !Number.isSafeInteger(source.index) || source.index < 0)
      throw new Error('Invalid rolling source')
    const tx = Transaction.fromRaw(hexToBytes(source.previousTxHex))
    const output = tx.getOutput(source.index)
    if (
      !output.script ||
      bytesToHex(output.script) !== bytesToHex(script.pkScript) ||
      output.amount === undefined ||
      output.amount < 330n ||
      output.amount > 2_100_000_000_000_000n
    )
      throw new Error('Rolling source contract or value mismatch')
    if (i === 0 && output.amount !== 330n) throw new Error('Controller value mismatch')
    const id = `${tx.id}:${source.index}`
    if (seen.has(id)) throw new Error('Duplicate source')
    seen.add(id)
    if (i > 0) principal += Number(output.amount)
    if (!Number.isSafeInteger(principal) || principal > 2_100_000_000_000_000) throw new Error('Principal overflow')
    return tx
  })
  const before = stateFromTransaction(previous[0])
  verifyRollingHistory(before, debits, params.policy.budget)
  const leaf = credit ? script.credit() : script.spend()
  const inputs = sources.map((s, i) => ({
    txid: previous[i].id,
    vout: s.index,
    value: Number(previous[i].getOutput(s.index).amount),
    tapLeafScript: leaf,
    tapTree: script.encode(),
  }))
  const checkpoint = CSVMultisigTapscript.decode(hexToBytes(params.policy.checkpointExit))
  return { script, previous, before, leaf, inputs, checkpoint, principal }
}

function complete(
  params: RollingContractParameters,
  ctx: ReturnType<typeof context>,
  outputs: { amount: bigint; script: Uint8Array }[],
  after: RollingState,
  witness: Uint8Array[],
  credit: boolean,
): ReturnType<typeof buildOffchainTx> {
  const p = params.policy
  const index = new Uint8Array(2)
  new DataView(index.buffer).setUint16(0, p.controllerIndex, true)
  const assetId = `${p.controllerTxid}${bytesToHex(index)}`
  const assets = [{ assetId, amount: 1n }]
  const marker = createAssetPacket(new Map([[0, assets]]), [{ address: '', assets }]).serialize()
  const encodedWitness = concat(compact(witness.length), ...witness.map((part) => concat(compact(part.length), part)))
  const code = credit ? ctx.script.programs.credit : ctx.script.programs.spend
  const entries = ctx.inputs.map((_, vin) =>
    concat(new Uint8Array([vin, 0]), compact(code.length), code, compact(encodedWitness.length), encodedWitness),
  )
  const emulator = concat(compact(entries.length), ...entries)
  const extension = encodeExtension([
    { type: 0, data: marker },
    { type: 1, data: emulator },
    { type: 2, data: encodeRollingState(after) },
  ])
  const result = buildOffchainTx(ctx.inputs, [...outputs, { amount: 0n, script: extension }], ctx.checkpoint)
  for (let i = 0; i < ctx.previous.length; i++)
    setArkPsbtField(result.arkTx, i, PrevArkTxField, ctx.previous[i].toBytes(true, true))
  const leafLength = ctx.leaf[1].length - 1
  const controlLength = TaprootControlBlock.encode(ctx.leaf[0]).length
  const witnessWeight =
    1 + 4 * 65 + compact(leafLength).length + leafLength + compact(controlLength).length + controlLength
  const weight = result.arkTx.toBytes(false, false).length * 4 + 2 + ctx.inputs.length * witnessWeight
  if (weight > 40000) throw new Error('Signed rolling transaction exceeds Operator weight limit; select fewer inputs')
  return result
}

/** Pure construction. Admission and atomic authorization precede submission. */
export function buildRollingPayment(
  params: RollingContractParameters,
  sources: readonly RollingSource[],
  debits: readonly RollingDebit[],
  recipientScript: string,
  amount: number,
): RollingNativeTransaction {
  const ctx = context(params, sources, debits, false)
  if (
    !Number.isSafeInteger(amount) ||
    amount < 330 ||
    amount > params.policy.recipientCap ||
    amount > ctx.principal ||
    sources.length < 2
  )
    throw new Error('Invalid rolling payment amount')
  requireLowerHex(recipientScript, 'recipient script', 34)
  if (!recipientScript.startsWith('5120')) throw new Error('Taproot recipient required')
  const change = ctx.principal - amount
  if (change > 0 && change < 330) throw new Error('Dust change')
  const outputs = [
    { amount: 330n, script: ctx.script.pkScript },
    { amount: BigInt(amount), script: hexToBytes(recipientScript) },
  ]
  if (change > 0) outputs.push({ amount: BigInt(change), script: ctx.script.pkScript })
  const first = buildOffchainTx(ctx.inputs, outputs, ctx.checkpoint)
  const parent = first.arkTx.getInput(0)
  if (!parent.txid || parent.index !== 0) throw new Error('Checkpoint controller mismatch')
  const debit = { sequence: ctx.before.sequence, amount, parentTxid: bytesToHex(parent.txid), parentIndex: 0 }
  const { proof } = buildHistoryProof(debits, ctx.before.sequence)
  const after = applyDebit(ctx.before, params.policy.budget, debit, proof)
  return { ...complete(params, ctx, outputs, after, historyWitness(proof), false), before: ctx.before, after, debit }
}

export function buildRollingCredit(
  params: RollingContractParameters,
  sources: readonly RollingSource[],
  debits: readonly RollingDebit[],
  receipt: RollingReceipt,
  now: number,
): RollingNativeTransaction {
  const ctx = context(params, sources, debits, true)
  const { proof } = buildHistoryProof(debits, receipt.debit.sequence)
  const after = applyMatureCredit(ctx.before, params.policy, receipt, proof, now)
  const outputs = [{ amount: 330n, script: ctx.script.pkScript }]
  if (sources.length > 1) outputs.push({ amount: BigInt(ctx.principal), script: ctx.script.pkScript })
  const witness = [
    ...historyWitness(proof),
    hexToBytes(requireLowerHex(receipt.signature, 'receipt signature', 64)),
    receiptMessage(receipt),
  ]
  return { ...complete(params, ctx, outputs, after, witness, true), before: ctx.before, after }
}
