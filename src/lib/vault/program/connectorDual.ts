import { buildConnectorApprovalProof } from './connectorApproval'
import { hex } from '@scure/base'
import { DUAL_CONNECTOR_PROGRAM, validateConnectorRules, type ConnectorRules } from './connector'
import { OP, concat, pushData, pushInt } from './script'

const X = { inputScript: 0xca, toAlt: 0x6b, fromAlt: 0x6c, if: 0x63, endif: 0x68, boolOr: 0x9b }

export function buildDualConnectorProgram(r: ConnectorRules): Uint8Array {
  return buildConnectorApprovalProof(r.connectorScript, concat(buildDualPolicy(r), Uint8Array.of(OP.VERIFY)))
}

function buildDualPolicy(r: ConnectorRules): Uint8Array {
  validateConnectorRules(r)
  const chunks: Uint8Array[] = []
  const op = (...values: number[]) => chunks.push(Uint8Array.from(values))
  const num = (n: number) => chunks.push(pushInt(n))
  const data = (b: Uint8Array) => chunks.push(pushData(b))
  const equal = (opcode: number, n: number) => {
    op(opcode)
    num(n)
    op(OP.EQUALVERIFY)
  }
  const script = (opcode: number, index: number, b: Uint8Array) => {
    num(index)
    op(opcode)
    num(b[0] === 0x51 ? 1 : 0)
    op(OP.EQUALVERIFY)
    data(b.slice(2))
    op(OP.EQUALVERIFY)
  }
  const withChange = () => {
    op(OP.INSPECTNUMOUTPUTS)
    num(6)
    op(OP.EQUAL, X.if)
  }
  // Two hardware inputs bind output 0 and output 1 with SINGLE.
  // Full: recipient, reserve A, reserve B, anchor, packet.
  // Partial: recipient, protected change, reserve A, reserve B, anchor, packet.
  const position = (full: number) => {
    withChange()
    num(full + 1)
    op(0x67)
    num(full)
    op(X.endif)
  }
  const outputScript = (full: number, bytes: Uint8Array) => {
    position(full)
    op(OP.INSPECTOUTPUTSCRIPTPUBKEY)
    num(bytes[0] === 0x51 ? 1 : 0)
    op(OP.EQUALVERIFY)
    data(bytes.slice(2))
    op(OP.EQUALVERIFY)
  }
  data(new TextEncoder().encode(DUAL_CONNECTOR_PROGRAM))
  op(OP.DROP)
  equal(OP.INSPECTVERSION, 2)
  equal(OP.INSPECTLOCKTIME, 0)
  equal(OP.INSPECTNUMINPUTS, 3)
  op(OP.INSPECTNUMOUTPUTS, OP.DUP)
  num(5)
  op(OP.EQUAL, OP.SWAP)
  num(6)
  op(OP.EQUAL, X.boolOr, OP.VERIFY)
  for (const i of [0, 1, 2]) {
    num(i)
    equal(OP.INSPECTINPUTSEQUENCE, 0xfffffffd)
  }
  for (const i of [0, 1]) {
    script(X.inputScript, i, r.connectorScript)
    num(i)
    equal(OP.INSPECTINPUTVALUE, 500)
    outputScript(i + 1, r.connectorScript)
    position(i + 1)
    equal(OP.INSPECTOUTPUTVALUE, 500)
  }
  outputScript(3, hex.decode('51024e73'))
  position(3)
  equal(OP.INSPECTOUTPUTVALUE, 240)
  position(4)
  equal(OP.INSPECTOUTPUTVALUE, 0)
  withChange()
  num(2)
  op(X.inputScript, X.toAlt)
  num(1)
  op(OP.INSPECTOUTPUTSCRIPTPUBKEY, X.fromAlt, OP.EQUALVERIFY, OP.EQUALVERIFY)
  num(1)
  op(OP.INSPECTOUTPUTVALUE)
  num(330)
  op(OP.GREATERTHANOREQUAL, OP.VERIFY, X.endif)
  num(0)
  op(OP.INSPECTOUTPUTVALUE)
  num(294)
  op(OP.GREATERTHANOREQUAL, OP.VERIFY)
  num(2)
  op(OP.INSPECTINPUTVALUE)
  num(0)
  op(OP.INSPECTOUTPUTVALUE, OP.SUB)
  position(3)
  op(OP.INSPECTOUTPUTVALUE, OP.SUB)
  withChange()
  num(1)
  op(OP.INSPECTOUTPUTVALUE, OP.SUB, X.endif)
  op(OP.DUP)
  num(0)
  op(OP.GREATERTHANOREQUAL, OP.VERIFY, OP.DUP)
  num(r.absoluteFeeCapSats)
  op(OP.LESSTHANOREQUAL, OP.VERIFY, OP.TXWEIGHT)
  num(r.witnessBytes)
  op(OP.ADD)
  num(3)
  op(OP.ADD)
  num(4)
  op(OP.DIV)
  num(r.feerateCapSatPerV)
  op(OP.MUL, OP.LESSTHANOREQUAL)
  return concat(...chunks)
}
