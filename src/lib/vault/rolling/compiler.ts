import { CSVMultisigTapscript } from '@arkade-os/sdk'
import { bytesToHex, hexToBytes } from '../hex'
import { emptyRoots, receiptDomain, MAX_SEQUENCE, type RollingParameters } from './allowance'

// Pinned to emulator 4feb9eaa81b49f8d321407e92dba107ec9ba5158.
// This independent compiler must match the runtime's portable vectors.
const OP = {
  OP_MERKLEBRANCHVERIFY: 0xb3,
  OP_TXWEIGHT: 0xd6,
  OP_MUL: 0x95,
  OP_0NOTEQUAL: 0x92,
  OP_1ADD: 0x8b,
  OP_1SUB: 0x8c,
  OP_ADD: 0x93,
  OP_BIN2NUM: 0xd8,
  OP_CAT: 0x7e,
  OP_CHECKSIGFROMSTACK: 0xcc,
  OP_CHECKTIMEVERIFY: 0xdc,
  OP_DEPTH: 0x74,
  OP_DIV: 0x96,
  OP_DROP: 0x75,
  OP_DUP: 0x76,
  OP_ELSE: 0x67,
  OP_ENDIF: 0x68,
  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,
  OP_FROMALTSTACK: 0x6c,
  OP_GREATERTHAN: 0xa0,
  OP_GREATERTHANOREQUAL: 0xa2,
  OP_IF: 0x63,
  OP_INSPECTASSETGROUP: 0xeb,
  OP_INSPECTASSETGROUPASSETID: 0xe6,
  OP_INSPECTASSETGROUPNUM: 0xea,
  OP_INSPECTINPUTOUTPOINT: 0xc7,
  OP_INSPECTINPUTPACKET: 0xf5,
  OP_INSPECTINPUTSCRIPTPUBKEY: 0xca,
  OP_INSPECTINPUTVALUE: 0xc9,
  OP_INSPECTINTENTMESSAGE: 0xf8,
  OP_INSPECTLOCKTIME: 0xd3,
  OP_INSPECTNUMASSETGROUPS: 0xe5,
  OP_INSPECTNUMINPUTS: 0xd4,
  OP_INSPECTNUMOUTPUTS: 0xd5,
  OP_INSPECTOUTPUTSCRIPTPUBKEY: 0xd1,
  OP_INSPECTOUTPUTVALUE: 0xcf,
  OP_INSPECTPACKET: 0xf4,
  OP_INSPECTVERSION: 0xd2,
  OP_LEFT: 0x80,
  OP_LESSTHAN: 0x9f,
  OP_LESSTHANOREQUAL: 0xa1,
  OP_MOD: 0x97,
  OP_NOT: 0x91,
  OP_NUM2BIN: 0xd7,
  OP_PICK: 0x79,
  OP_PUSHCURRENTINPUTINDEX: 0xcd,
  OP_PUSHEXPIRY: 0xdb,
  OP_RIGHT: 0x81,
  OP_ROT: 0x7b,
  OP_SHA256: 0xa8,
  OP_SIZE: 0x82,
  OP_SUB: 0x94,
  OP_SWAP: 0x7c,
  OP_TOALTSTACK: 0x6b,
  OP_TRUE: 0x51,
  OP_TUNNEL: 0xf7,
  OP_VERIFY: 0x69,
} as const
const StatePacketType = 2
const MaxMoneyInputs = 4
const ControllerSats = 330
const maxMoney = 2_100_000_000_000_000
const RollingStateSize = 52
const MaxSequence = MAX_SEQUENCE
const HistoryWitnessItems = 2
const HistoryBranchTag = 'VaultRollingBranch/v1'
const ReceiptSize = 92
const DebitSize = 52
const WindowSeconds = 86400
const utf8 = new TextEncoder()
const rollingMagic = utf8.encode('VR01')

class Builder {
  private chunks: number[] = []
  op(code: number): this {
    this.chunks.push(code)
    return this
  }
  data(data: Uint8Array): this {
    if (data.length === 0 || (data.length === 1 && data[0] === 0)) return this.op(0)
    if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return this.op(0x50 + data[0])
    if (data.length === 1 && data[0] === 0x81) return this.op(0x4f)
    if (data.length > 520) throw new Error('Oversized script element')
    if (data.length < 76) this.chunks.push(data.length)
    else if (data.length <= 255) this.chunks.push(76, data.length)
    else this.chunks.push(77, data.length & 255, data.length >> 8)
    this.chunks.push(...data)
    return this
  }
  int(n: number): this {
    if (!Number.isSafeInteger(n)) throw new Error('Unsafe script number')
    if (n === 0) return this.op(0)
    let value = BigInt(Math.abs(n))
    const raw: number[] = []
    while (value > 0n) {
      raw.push(Number(value & 255n))
      value >>= 8n
    }
    if (raw[raw.length - 1] & 128) raw.push(n < 0 ? 128 : 0)
    else if (n < 0) raw[raw.length - 1] |= 128
    return this.data(new Uint8Array(raw))
  }
  bytes(): Uint8Array {
    if (this.chunks.length > 10000) throw new Error('Oversized rolling program')
    return new Uint8Array(this.chunks)
  }
  eq(n: number) {
    this.int(n).op(OP.OP_EQUALVERIFY)
  }
  bounded(lo: number, hi: number) {
    this.op(OP.OP_DUP)
      .int(lo)
      .op(OP.OP_GREATERTHANOREQUAL)
      .op(OP.OP_VERIFY)
      .op(OP.OP_DUP)
      .int(hi)
      .op(OP.OP_LESSTHANOREQUAL)
      .op(OP.OP_VERIFY)
  }
  inputValue(i: number) {
    this.int(i).op(OP.OP_INSPECTINPUTVALUE)
  }
  outputValue(i: number) {
    this.int(i).op(OP.OP_INSPECTOUTPUTVALUE)
  }
  inputScript(i: number) {
    this.int(i).op(OP.OP_INSPECTINPUTSCRIPTPUBKEY)
    this.eq(1)
    this.op(OP.OP_DUP).op(OP.OP_SIZE)
    this.eq(32)
    this.op(OP.OP_DROP)
  }
  outputScript(i: number) {
    this.int(i).op(OP.OP_INSPECTOUTPUTSCRIPTPUBKEY)
    this.eq(1)
    this.op(OP.OP_DUP).op(OP.OP_SIZE)
    this.eq(32)
    this.op(OP.OP_DROP)
  }
  outputMatchesInput(out: number, input: number) {
    this.outputScript(out)
    this.inputScript(input)
    this.op(OP.OP_EQUALVERIFY)
  }
  header(version: number, minInputs: number, maxInputs: number) {
    this.op(OP.OP_INSPECTVERSION)
    this.eq(version)
    this.op(OP.OP_INSPECTLOCKTIME)
    this.eq(0)
    this.op(OP.OP_INSPECTNUMINPUTS)
    this.bounded(minInputs, maxInputs)
    this.op(OP.OP_DROP)
  }
  marker(p: RollingParameters, controller: number) {
    this.op(OP.OP_INSPECTNUMASSETGROUPS)
    this.eq(1)
    this.int(0).op(OP.OP_INSPECTASSETGROUPASSETID)
    this.eq(p.controllerIndex)
    this.data(hexToBytes(p.controllerTxid).reverse()).op(OP.OP_EQUALVERIFY)
    for (let source = 0; source < 2; source++) {
      this.int(0).int(source).op(OP.OP_INSPECTASSETGROUPNUM)
      this.eq(1)
      this.int(0).int(0).int(source).op(OP.OP_INSPECTASSETGROUP)
      this.eq(1) // amount
      if (source == 0) {
        this.eq(controller)
      } else {
        this.eq(0)
      }
      this.eq(1) // LOCAL input or output
    }
  }
  feeRate(cap: number) {
    this.op(OP.OP_DUP)
      .op(OP.OP_TXWEIGHT)
      .int(4)
      .op(OP.OP_DIV)
      .int(cap)
      .op(OP.OP_MUL)
      .op(OP.OP_LESSTHANOREQUAL)
      .op(OP.OP_VERIFY)
  }
  rollingPacket(input: number) {
    this.int(StatePacketType)
    if (input < 0) {
      this.op(OP.OP_INSPECTPACKET)
    } else {
      this.int(input).op(OP.OP_INSPECTINPUTPACKET)
    }
    this.op(OP.OP_VERIFY).op(OP.OP_SIZE)
    this.eq(RollingStateSize)
    this.op(OP.OP_DUP).int(4).op(OP.OP_LEFT).data(rollingMagic).op(OP.OP_EQUALVERIFY)
  }
  slice(offset: number, size: number) {
    this.int(offset + size)
      .op(OP.OP_LEFT)
      .int(size)
      .op(OP.OP_RIGHT)
  }
  unsigned(width: number, max: number) {
    this.op(OP.OP_DUP).op(OP.OP_BIN2NUM).op(OP.OP_DUP).int(width).op(OP.OP_NUM2BIN).op(OP.OP_ROT).op(OP.OP_EQUALVERIFY)
    this.bounded(0, max)
  }
  rollingNumber(input: number, offset: number, max: number) {
    this.rollingPacket(input)
    this.slice(offset, 8)
    this.unsigned(8, max)
  }
  rollingRoot(input: number) {
    this.rollingPacket(input)
    this.slice(20, 32)
  }
  historyRoot() {
    this.op(OP.OP_DROP)
    for (const [i, size] of [512, 480].entries()) {
      this.op(OP.OP_TOALTSTACK)
        .int(0)
        .data(utf8.encode(HistoryBranchTag))
        .int(2 + i)
        .op(OP.OP_PICK)
        .op(OP.OP_SIZE)
      this.eq(size)
      this.op(OP.OP_FROMALTSTACK).op(OP.OP_MERKLEBRANCHVERIFY)
    }
  }
  dropHistoryProof() {
    this.op(OP.OP_DROP).op(OP.OP_DROP)
  }
  receiptField(offset: number, size: number) {
    this.op(OP.OP_FROMALTSTACK).op(OP.OP_DUP).op(OP.OP_TOALTSTACK)
    this.slice(offset, size)
  }
  creditFee() {
    this.int(0)
    for (let i = 1; i <= MaxMoneyInputs; i++) {
      this.op(OP.OP_INSPECTNUMINPUTS).int(i).op(OP.OP_GREATERTHAN).op(OP.OP_IF)
      this.inputValue(i)
      this.op(OP.OP_ADD).op(OP.OP_ENDIF)
    }
    this.op(OP.OP_INSPECTNUMINPUTS).int(1).op(OP.OP_GREATERTHAN).op(OP.OP_IF)
    this.outputValue(1)
    this.op(OP.OP_SUB).op(OP.OP_ENDIF)
  }
}
function compileSpendWithState(p: RollingParameters, state: (b: Builder) => void) {
  const b = new Builder()
  b.header(3, 2, MaxMoneyInputs + 1)
  b.op(OP.OP_INSPECTNUMOUTPUTS)
  b.bounded(4, 5)
  b.op(OP.OP_DROP)
  b.marker(p, 0)
  b.inputValue(0)
  b.eq(ControllerSats)
  b.outputValue(0)
  b.eq(ControllerSats)
  b.outputMatchesInput(0, 0)
  // Every selected principal input belongs to the same enrolled tree.
  for (let i = 1; i <= MaxMoneyInputs; i++) {
    b.op(OP.OP_INSPECTNUMINPUTS).int(i).op(OP.OP_GREATERTHAN).op(OP.OP_IF)
    b.inputScript(i)
    b.inputScript(0)
    b.op(OP.OP_EQUALVERIFY)
    b.inputValue(i)
    b.bounded(ControllerSats, maxMoney)
    b.op(OP.OP_DROP).op(OP.OP_ENDIF)
  }
  b.outputScript(1)
  b.op(OP.OP_DROP)
  b.outputValue(1)
  b.bounded(ControllerSats, p.recipientCap)
  b.op(OP.OP_DROP)
  // The last two outputs are the zero-value P2A and extension outputs.
  b.op(OP.OP_INSPECTNUMOUTPUTS).op(OP.OP_1SUB).op(OP.OP_INSPECTOUTPUTVALUE)
  b.eq(0)
  b.op(OP.OP_INSPECTNUMOUTPUTS).op(OP.OP_1SUB).op(OP.OP_INSPECTOUTPUTSCRIPTPUBKEY)
  b.eq(1)
  b.data(new Uint8Array([0x4e, 0x73])).op(OP.OP_EQUALVERIFY)
  b.op(OP.OP_INSPECTNUMOUTPUTS).int(2).op(OP.OP_SUB).op(OP.OP_INSPECTOUTPUTVALUE)
  b.eq(0)
  b.op(OP.OP_INSPECTNUMOUTPUTS).int(2).op(OP.OP_SUB).op(OP.OP_INSPECTOUTPUTSCRIPTPUBKEY)
  b.eq(-1)
  b.op(OP.OP_DROP)
  // Sum the actual principal inputs. The controller contributes zero outflow.
  b.int(0)
  for (let i = 1; i <= MaxMoneyInputs; i++) {
    b.op(OP.OP_INSPECTNUMINPUTS).int(i).op(OP.OP_GREATERTHAN).op(OP.OP_IF)
    b.inputValue(i)
    b.op(OP.OP_ADD).op(OP.OP_ENDIF)
  }
  b.bounded(ControllerSats, maxMoney)
  b.op(OP.OP_INSPECTNUMOUTPUTS).int(5).op(OP.OP_EQUAL).op(OP.OP_IF)
  b.outputMatchesInput(2, 0)
  b.outputValue(2)
  b.bounded(ControllerSats, maxMoney)
  b.op(OP.OP_SUB).op(OP.OP_ENDIF)
  // stack: debit = principal in - protected principal out = recipient + fee.
  b.op(OP.OP_DUP)
  b.outputValue(1)
  b.op(OP.OP_SUB)
  b.bounded(0, p.feeCap)
  b.op(OP.OP_DROP)
  state(b)
  b.op(OP.OP_TRUE)
  return b.bytes()
}
function rollingDebitState(b: Builder, p: RollingParameters, input: number) {
  // debit is above the proof. Preserve it until its canonical leaf is built.
  b.op(OP.OP_DEPTH)
  b.eq(HistoryWitnessItems + 1)
  b.op(OP.OP_DUP).op(OP.OP_TOALTSTACK)
  b.rollingNumber(input, 4, p.budget)
  b.op(OP.OP_SWAP).op(OP.OP_SUB)
  b.bounded(0, p.budget)
  b.rollingNumber(-1, 4, p.budget)
  b.op(OP.OP_EQUALVERIFY)
  b.rollingNumber(input, 12, MaxSequence)
  b.op(OP.OP_1ADD)
  b.rollingNumber(-1, 12, MaxSequence)
  b.op(OP.OP_EQUALVERIFY)
  const empty = emptyRoots()[0]
  b.data(hexToBytes(empty))
  b.rollingNumber(input, 12, MaxSequence - 1)
  b.historyRoot()
  b.rollingRoot(input)
  b.op(OP.OP_EQUALVERIFY)
  b.data(new Uint8Array([1]))
  b.rollingNumber(input, 12, MaxSequence - 1)
  b.int(8)
    .op(OP.OP_NUM2BIN)
    .op(OP.OP_CAT)
    .op(OP.OP_FROMALTSTACK)
    .int(8)
    .op(OP.OP_NUM2BIN)
    .op(OP.OP_CAT)
    .int(input)
    .op(OP.OP_INSPECTINPUTOUTPOINT)
  b.eq(0)
  b.data(new Uint8Array([0, 0, 0, 0]))
    .op(OP.OP_CAT)
    .op(OP.OP_CAT)
    .op(OP.OP_SHA256)
  b.rollingNumber(input, 12, MaxSequence - 1)
  b.historyRoot()
  b.rollingRoot(-1)
  b.op(OP.OP_EQUALVERIFY)
  b.dropHistoryProof()
  b.op(OP.OP_DEPTH)
  b.eq(0)
}
function compileRollingCredit(p: RollingParameters) {
  const b = new Builder()
  b.header(3, 1, MaxMoneyInputs + 1)
  b.marker(p, 0)
  b.inputValue(0)
  b.eq(ControllerSats)
  b.outputValue(0)
  b.eq(ControllerSats)
  b.outputMatchesInput(0, 0)
  b.op(OP.OP_INSPECTNUMINPUTS).int(1).op(OP.OP_GREATERTHAN).op(OP.OP_IF)
  b.op(OP.OP_INSPECTNUMOUTPUTS)
  b.eq(4)
  b.outputMatchesInput(1, 0)
  b.outputValue(1)
  b.bounded(ControllerSats, maxMoney)
  b.op(OP.OP_DROP)
  b.op(OP.OP_ELSE).op(OP.OP_INSPECTNUMOUTPUTS)
  b.eq(3)
  b.op(OP.OP_ENDIF)
  for (let i = 1; i <= MaxMoneyInputs; i++) {
    b.op(OP.OP_INSPECTNUMINPUTS).int(i).op(OP.OP_GREATERTHAN).op(OP.OP_IF)
    b.inputScript(i)
    b.inputScript(0)
    b.op(OP.OP_EQUALVERIFY)
    b.inputValue(i)
    b.bounded(ControllerSats, maxMoney)
    b.op(OP.OP_DROP).op(OP.OP_ENDIF)
  }
  b.op(OP.OP_INSPECTNUMOUTPUTS).op(OP.OP_1SUB).op(OP.OP_INSPECTOUTPUTVALUE)
  b.eq(0)
  b.op(OP.OP_INSPECTNUMOUTPUTS).op(OP.OP_1SUB).op(OP.OP_INSPECTOUTPUTSCRIPTPUBKEY)
  b.eq(1)
  b.data(new Uint8Array([0x4e, 0x73])).op(OP.OP_EQUALVERIFY)
  b.op(OP.OP_INSPECTNUMOUTPUTS).int(2).op(OP.OP_SUB).op(OP.OP_INSPECTOUTPUTVALUE)
  b.eq(0)
  b.op(OP.OP_INSPECTNUMOUTPUTS).int(2).op(OP.OP_SUB).op(OP.OP_INSPECTOUTPUTSCRIPTPUBKEY)
  b.eq(-1)
  b.op(OP.OP_DROP)
  b.creditFee()
  b.bounded(0, p.feeCap)
  b.feeRate(p.feerateCap)
  b.op(OP.OP_0NOTEQUAL).op(OP.OP_IF)
  b.op(OP.OP_DEPTH)
  b.eq(2 * HistoryWitnessItems + 2)
  b.op(OP.OP_ELSE).op(OP.OP_DEPTH)
  b.eq(HistoryWitnessItems + 2)
  b.op(OP.OP_ENDIF)
  b.op(OP.OP_SIZE)
  b.eq(ReceiptSize)
  const domain = hexToBytes(receiptDomain(p))
  b.op(OP.OP_DUP)
    .int(32)
    .op(OP.OP_LEFT)
    .data(domain)
    .op(OP.OP_EQUALVERIFY)
    .op(OP.OP_DUP)
    .op(OP.OP_TOALTSTACK)
    .op(OP.OP_SHA256)
    .data(hexToBytes(p.receiptKey))
    .op(OP.OP_CHECKSIGFROMSTACK)
    .op(OP.OP_VERIFY)
  b.receiptField(84, 8)
  b.unsigned(8, 100_000_000_000)
  b.bounded(1, 100_000_000_000)
  b.int(WindowSeconds + 1)
    .op(OP.OP_ADD)
    .op(OP.OP_CHECKTIMEVERIFY)
  b.receiptField(32, 8)
  b.unsigned(8, MaxSequence - 1)
  b.rollingNumber(0, 12, MaxSequence)
  b.op(OP.OP_LESSTHAN).op(OP.OP_VERIFY)
  b.receiptField(40, 8)
  b.unsigned(8, p.budget)
  b.bounded(1, p.budget)
  b.rollingNumber(0, 4, p.budget)
  b.op(OP.OP_ADD)
  b.bounded(0, p.budget)
  b.creditFee()
  b.op(OP.OP_SUB)
  b.bounded(0, p.budget)
  b.rollingNumber(-1, 4, p.budget)
  b.op(OP.OP_EQUALVERIFY)
  b.rollingNumber(0, 12, MaxSequence)
  b.creditFee()
  b.op(OP.OP_0NOTEQUAL).op(OP.OP_IF).op(OP.OP_1ADD).op(OP.OP_ENDIF)
  b.rollingNumber(-1, 12, MaxSequence)
  b.op(OP.OP_EQUALVERIFY)
  // Remove exactly the authenticated debit from the previous history.
  b.receiptField(32, DebitSize)
  b.data(new Uint8Array([1]))
    .op(OP.OP_SWAP)
    .op(OP.OP_CAT)
    .op(OP.OP_SHA256)
  b.receiptField(32, 8)
  b.unsigned(8, MaxSequence - 1)
  b.historyRoot()
  b.rollingRoot(0)
  b.op(OP.OP_EQUALVERIFY)
  const empty = emptyRoots()[0]
  b.data(hexToBytes(empty))
  b.receiptField(32, 8)
  b.unsigned(8, MaxSequence - 1)
  b.historyRoot()
  b.creditFee()
  b.op(OP.OP_0NOTEQUAL).op(OP.OP_IF)
  // The removal root is the insertion's authenticated intermediate root.
  b.op(OP.OP_TOALTSTACK)
  b.dropHistoryProof()
  b.data(hexToBytes(empty))
  b.rollingNumber(0, 12, MaxSequence - 1)
  b.historyRoot()
  b.op(OP.OP_FROMALTSTACK).op(OP.OP_EQUALVERIFY)
  b.data(new Uint8Array([1]))
  b.rollingNumber(0, 12, MaxSequence - 1)
  b.int(8).op(OP.OP_NUM2BIN).op(OP.OP_CAT)
  b.creditFee()
  b.int(8).op(OP.OP_NUM2BIN).op(OP.OP_CAT)
  b.int(0).op(OP.OP_INSPECTINPUTOUTPOINT)
  b.eq(0)
  b.data(new Uint8Array([0, 0, 0, 0]))
    .op(OP.OP_CAT)
    .op(OP.OP_CAT)
    .op(OP.OP_SHA256)
  b.rollingNumber(0, 12, MaxSequence - 1)
  b.historyRoot()
  b.rollingRoot(-1)
  b.op(OP.OP_EQUALVERIFY)
  b.dropHistoryProof()
  b.op(OP.OP_ELSE)
  b.rollingRoot(-1)
  b.op(OP.OP_EQUALVERIFY)
  b.dropHistoryProof()
  b.op(OP.OP_ENDIF).op(OP.OP_FROMALTSTACK).op(OP.OP_DROP).op(OP.OP_DEPTH)
  b.eq(0)
  b.op(OP.OP_TRUE)
  return b.bytes()
}
function compileRollingRenew(p: RollingParameters) {
  const b = new Builder()
  b.header(2, 2, MaxMoneyInputs + 2)
  b.op(OP.OP_INSPECTNUMOUTPUTS).op(OP.OP_INSPECTNUMINPUTS).op(OP.OP_EQUALVERIFY)
  b.inputValue(0)
  b.eq(0)
  b.op(OP.OP_PUSHEXPIRY).int(p.renewalWindow).op(OP.OP_SUB).op(OP.OP_CHECKTIMEVERIFY)
  for (const pair of [
    ['type', 'register'],
    ['onchain_output_indexes', '[]'],
    ['cosigners_public_keys.0', p.delegatePubkey],
  ]) {
    b.data(utf8.encode(pair[0]))
      .op(OP.OP_INSPECTINTENTMESSAGE)
      .op(OP.OP_VERIFY)
      .data(utf8.encode(pair[1]))
      .op(OP.OP_EQUALVERIFY)
  }
  b.data(utf8.encode('cosigners_public_keys.1'))
    .op(OP.OP_INSPECTINTENTMESSAGE)
    .op(OP.OP_NOT)
    .op(OP.OP_VERIFY)
    .op(OP.OP_DROP)
  // Compute fee over preserved protected destinations, including the controller.
  b.int(0)
  for (let i = 1; i <= MaxMoneyInputs + 1; i++) {
    b.op(OP.OP_INSPECTNUMINPUTS).int(i).op(OP.OP_GREATERTHAN).op(OP.OP_IF)
    b.inputScript(i)
    b.inputScript(1)
    b.op(OP.OP_EQUALVERIFY)
    b.outputMatchesInput(i - 1, i)
    b.inputValue(i)
    b.bounded(ControllerSats, maxMoney)
    b.outputValue(i - 1)
    b.bounded(ControllerSats, maxMoney)
    b.op(OP.OP_SUB)
    b.bounded(0, p.feeCap)
    b.op(OP.OP_ADD).op(OP.OP_ENDIF)
  }
  b.bounded(0, p.feeCap)
  b.feeRate(p.feerateCap)
  // No controller means there is no authority to charge a renewal fee.
  b.int(0).op(OP.OP_INSPECTPACKET).op(OP.OP_SWAP).op(OP.OP_DROP).op(OP.OP_NOT).op(OP.OP_IF)
  b.eq(0)
  b.op(OP.OP_INSPECTNUMINPUTS)
  b.bounded(2, MaxMoneyInputs + 1)
  b.op(OP.OP_DROP)
  b.int(StatePacketType).op(OP.OP_INSPECTPACKET).op(OP.OP_NOT).op(OP.OP_VERIFY).op(OP.OP_DROP)
  b.op(OP.OP_DEPTH)
  b.eq(0)
  b.op(OP.OP_ELSE)
  b.marker(p, 1)
  b.inputValue(1)
  b.eq(ControllerSats)
  b.outputValue(0)
  b.eq(ControllerSats)
  b.op(OP.OP_DUP).op(OP.OP_0NOTEQUAL).op(OP.OP_IF)
  rollingDebitState(b, p, 1)
  b.op(OP.OP_ELSE).op(OP.OP_DROP)
  b.rollingNumber(1, 4, p.budget)
  b.op(OP.OP_DROP)
  b.rollingNumber(1, 12, MaxSequence)
  b.op(OP.OP_DROP)
  b.rollingPacket(1)
  b.rollingPacket(-1)
  b.op(OP.OP_EQUALVERIFY)
  b.op(OP.OP_DEPTH)
  b.eq(0)
  b.op(OP.OP_ENDIF).op(OP.OP_ENDIF)
  b.op(OP.OP_INSPECTNUMOUTPUTS).op(OP.OP_1SUB).op(OP.OP_INSPECTOUTPUTVALUE)
  b.eq(0)
  // Script and assets remain unchanged; explicit arithmetic above allows only
  // a bounded fee charged to the controller. Value preservation is checked there.
  b.op(OP.OP_PUSHCURRENTINPUTINDEX).op(OP.OP_1SUB).int(5).int(0).op(OP.OP_TUNNEL).op(OP.OP_VERIFY).op(OP.OP_TRUE)
  return b.bytes()
}

function compileRollingCleanup(): Uint8Array {
  const b = new Builder()
  b.header(2, 2, MaxMoneyInputs + 2)
  b.op(OP.OP_INSPECTNUMOUTPUTS)
  b.eq(1)
  b.inputValue(0)
  b.eq(0)
  b.outputValue(0)
  b.eq(0)
  b.int(0).op(OP.OP_INSPECTOUTPUTSCRIPTPUBKEY)
  b.eq(-1)
  b.op(OP.OP_DROP)
  b.data(utf8.encode('type'))
    .op(OP.OP_INSPECTINTENTMESSAGE)
    .op(OP.OP_VERIFY)
    .data(utf8.encode('delete'))
    .op(OP.OP_EQUALVERIFY)
  b.data(utf8.encode('expire_at')).op(OP.OP_INSPECTINTENTMESSAGE).op(OP.OP_VERIFY)
  b.bounded(300, 100_000_000_000)
  b.int(300).op(OP.OP_SUB).op(OP.OP_CHECKTIMEVERIFY)
  for (const packet of [0, StatePacketType]) {
    b.int(packet).op(OP.OP_INSPECTPACKET).op(OP.OP_NOT).op(OP.OP_VERIFY).op(OP.OP_DROP)
  }
  for (let i = 1; i <= MaxMoneyInputs + 1; i++) {
    b.op(OP.OP_INSPECTNUMINPUTS).int(i).op(OP.OP_GREATERTHAN).op(OP.OP_IF)
    b.inputScript(i)
    b.inputScript(1)
    b.op(OP.OP_EQUALVERIFY)
    b.inputValue(i)
    b.bounded(ControllerSats, maxMoney)
    b.op(OP.OP_DROP).op(OP.OP_ENDIF)
  }
  b.op(OP.OP_DEPTH)
  b.eq(0)
  b.op(OP.OP_TRUE)
  return b.bytes()
}

export function compileRollingPrograms(p: RollingParameters): {
  spend: Uint8Array
  credit: Uint8Array
  renew: Uint8Array
  cleanup: Uint8Array
} {
  receiptDomain(p)
  const checkpoint = hexToBytes(p.checkpointExit)
  const decoded = CSVMultisigTapscript.decode(checkpoint)
  if (
    decoded.params.pubkeys.length !== 1 ||
    bytesToHex(CSVMultisigTapscript.encode(decoded.params).script) !== p.checkpointExit
  ) {
    throw new Error('Noncanonical checkpoint exit')
  }
  return {
    spend: compileSpendWithState(p, (b) => {
      b.op(OP.OP_DUP)
      b.outputValue(1)
      b.op(OP.OP_SUB)
      b.feeRate(p.feerateCap)
      b.op(OP.OP_DROP)
      rollingDebitState(b, p, 0)
    }),
    credit: compileRollingCredit(p),
    renew: compileRollingRenew(p),
    cleanup: compileRollingCleanup(),
  }
}
