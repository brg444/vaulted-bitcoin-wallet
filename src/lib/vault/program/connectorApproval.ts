import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { concat, pushData, pushInt } from './script'
import { exactPacketOutputPrefix } from './packet'
const P = {
  DEPTH: 0x74,
  SUB: 0x94,
  PICK: 0x79,
  EQUALVERIFY: 0x88,
  SIZE: 0x82,
  DROP: 0x75,
  SHA256INITIALIZE: 0xc4,
  SHA256UPDATE: 0xc5,
  SHA256FINALIZE: 0xc6,
  INSPECTINPUTARKADESCRIPTHASH: 0xc8,
  INSPECTNUMOUTPUTS: 0xd5,
  INSPECTOUTPUTSCRIPTPUBKEY: 0xd1,
  HASH160: 0xa9,
  INSPECTINPUTOUTPOINT: 0xc7,
  NUM2BIN: 0xd7,
  CAT: 0x7e,
  SHA256: 0xa8,
  INSPECTINPUTVALUE: 0xc9,
  INSPECTINPUTSCRIPTPUBKEY: 0xca,
  DUP: 0x76,
  HASH256: 0xaa,
  INSPECTOUTPUTVALUE: 0xcf,
  LEFT: 0x80,
  BIN2NUM: 0xd8,
  SWAP: 0x7c,
  SUBSTR: 0x7f,
  EQUAL: 0x87,
  IF: 0x63,
  ELSE: 0x67,
  ADD: 0x93,
  ENDIF: 0x68,
  CHECKSIGFROMSTACK: 0xcc,
  VERIFY: 0x69,
} as const

const cs = (n: number): Uint8Array => (n < 253 ? Uint8Array.of(n) : Uint8Array.of(253, n & 255, n >> 8))
const tag = (s: string) => {
  const h = sha256(new TextEncoder().encode(s))
  return concat(h, h)
}
export function connectorApprovalWitness(
  script: Uint8Array,
  sigs: Uint8Array[] | undefined,
  recipient: Uint8Array,
  publicKey?: Uint8Array,
) {
  if (recipient.length > 34) throw Error('recipient length')
  const padded = new Uint8Array(35)
  padded[0] = recipient.length
  padded.set(recipient, 1)
  const encoded = sigs
    ? sigs.map((s) => {
        if (!publicKey) return s.slice(0, 64)
        return secp256k1.Signature.fromBytes(s.slice(0, -1), 'der').toBytes('compact')
      })
    : [new Uint8Array(64), new Uint8Array(64)]
  return [
    ...encoded,
    padded,
    ...(publicKey ? [publicKey] : []),
    ...Array.from({ length: Math.ceil(script.length / 500) }, (_, i) => script.slice(i * 500, (i + 1) * 500)),
  ]
}
// The witness repeats the program in bounded chunks because v0.0.7 cannot
// return a packet larger than 520 bytes through INSPECTPACKET. Its tagged hash
// binds those chunks to the executing program; streaming the canonical envelope
// binds the complete output without removing the packet/layout check.
export function buildConnectorApprovalProof(hardware: Uint8Array, extra: Uint8Array = new Uint8Array()): Uint8Array {
  const taproot = hardware.length === 34
  let len = 1000
  for (let round = 0; round < 20; round++) {
    const b: Uint8Array[] = []
    const op = (...x: number[]) => b.push(Uint8Array.from(x)),
      num = (n: number) => b.push(pushInt(n)),
      data = (d: Uint8Array) =>
        b.push(
          d.length === 1 && d[0] >= 1 && d[0] <= 16
            ? pushInt(d[0])
            : d.length === 1 && d[0] === 0x81
              ? pushInt(-1)
              : pushData(d),
        )
    const copy = (i: number) => {
      op(P.DEPTH)
      num(i + 1)
      op(P.SUB, P.PICK)
    }
    const chunks = Array.from({ length: Math.ceil(len / 500) }, (_, i) => Math.min(500, len - i * 500))
    const start = taproot ? 3 : 4
    const sizes = [64, 64, 35, ...(taproot ? [] : [33]), ...chunks]
    op(P.DEPTH)
    num(sizes.length)
    op(P.EQUALVERIFY)
    sizes.forEach((s, i) => {
      copy(i)
      op(P.SIZE)
      num(s)
      op(P.EQUALVERIFY, P.DROP)
    })
    // Commit the supplied script chunks to the actual executing program.
    data(tag('ArkScriptHash'))
    op(P.SHA256INITIALIZE)
    chunks.forEach((_, i) => {
      copy(i + start)
      op(P.SHA256UPDATE)
    })
    data(new Uint8Array())
    op(P.SHA256FINALIZE)
    num(2)
    op(P.INSPECTINPUTARKADESCRIPTHASH, P.EQUALVERIFY)
    // Independently reconstruct the entire canonical extension output, streamed below 520 bytes.
    data(concat(exactPacketOutputPrefix(len, sizes), Uint8Array.of(1, 2, 0), cs(len)))
    op(P.SHA256INITIALIZE)
    chunks.forEach((_, i) => {
      copy(i + start)
      op(P.SHA256UPDATE)
    })
    const wlen = cs(sizes.length).length + sizes.reduce((n, s) => n + cs(s).length + s, 0)
    data(concat(cs(wlen), cs(sizes.length)))
    op(P.SHA256UPDATE)
    sizes.forEach((s, i) => {
      data(cs(s))
      op(P.SHA256UPDATE)
      copy(i)
      op(P.SHA256UPDATE)
    })
    data(new Uint8Array())
    op(P.SHA256FINALIZE, P.INSPECTNUMOUTPUTS)
    num(1)
    op(P.SUB, P.INSPECTOUTPUTSCRIPTPUBKEY)
    num(-1)
    op(P.EQUALVERIFY, P.EQUALVERIFY)
    if (!taproot) {
      copy(3)
      op(P.HASH160)
      data(hardware.slice(2))
      op(P.EQUALVERIFY)
    }
    if (taproot) {
      // BIP341 keypath SINGLE preimage: tag, epoch, hash type, version, locktime.
      data(concat(tag('TapSighash'), hex.decode('00030200000000000000')))
      for (let i = 0; i < 3; i++) {
        num(i)
        op(P.INSPECTINPUTOUTPOINT)
        num(4)
        op(P.NUM2BIN, P.CAT)
        if (i > 0) op(P.CAT)
      }
      op(P.SHA256, P.CAT)
      data(hex.decode('f401000000000000f401000000000000'))
      num(2)
      op(P.INSPECTINPUTVALUE)
      num(8)
      op(P.NUM2BIN, P.CAT, P.SHA256, P.CAT)
      data(
        concat(
          Uint8Array.of(hardware.length),
          hardware,
          Uint8Array.of(hardware.length),
          hardware,
          hex.decode('225120'),
        ),
      )
      num(2)
      op(P.INSPECTINPUTSCRIPTPUBKEY)
      num(1)
      op(P.EQUALVERIFY, P.CAT, P.SHA256, P.CAT)
      data(sha256(hex.decode('fdfffffffdfffffffdffffff')))
      op(P.CAT)
    }
    for (let i = 0; i < 2; i++) {
      if (taproot) {
        op(P.DUP)
        data(Uint8Array.of(0, i, 0, 0, 0))
        op(P.CAT)
      } else {
        data(hex.decode('02000000'))
        for (let j = 0; j < 3; j++) {
          num(j)
          op(P.INSPECTINPUTOUTPOINT)
          num(4)
          op(P.NUM2BIN, P.CAT)
          if (j > 0) op(P.CAT)
        }
        op(P.HASH256, P.CAT)
        data(new Uint8Array(32))
        op(P.CAT)
        num(i)
        op(P.INSPECTINPUTOUTPOINT)
        num(4)
        op(P.NUM2BIN, P.CAT, P.CAT)
        data(concat(hex.decode('1976a914'), hardware.slice(2), hex.decode('88acf401000000000000fdffffff')))
        op(P.CAT)
      }
      num(i)
      op(P.INSPECTOUTPUTVALUE)
      num(8)
      op(P.NUM2BIN)
      if (i === 0) {
        copy(2)
        op(P.DUP)
        num(1)
        op(P.LEFT, P.BIN2NUM)
        num(1)
        op(P.SWAP, P.SUBSTR, P.DUP)
        num(0)
        op(P.INSPECTOUTPUTSCRIPTPUBKEY, P.DUP)
        num(-1)
        op(P.EQUAL, P.IF, P.DROP, P.SWAP, P.SHA256, P.EQUALVERIFY, P.ELSE)
        op(P.DUP)
        num(0)
        op(P.EQUAL, P.IF)
        num(1)
        op(P.NUM2BIN, P.ELSE)
        num(80)
        op(P.ADD)
        num(1)
        op(P.NUM2BIN, P.ENDIF, P.SWAP, P.SIZE)
        num(1)
        op(P.NUM2BIN, P.SWAP, P.CAT, P.CAT, P.EQUALVERIFY, P.ENDIF)
        op(P.SIZE)
        num(1)
        op(P.NUM2BIN, P.SWAP, P.CAT)
      } else {
        // Second approved output is either protected Taproot change or the native reserve.
        op(P.INSPECTNUMOUTPUTS)
        num(6)
        op(P.EQUAL, P.IF)
        data(hex.decode('225120'))
        num(1)
        op(P.INSPECTOUTPUTSCRIPTPUBKEY)
        num(1)
        op(P.EQUALVERIFY, P.CAT, P.ELSE)
        data(concat(Uint8Array.of(hardware.length), hardware))
        op(P.ENDIF)
      }
      op(P.CAT, taproot ? P.SHA256 : P.HASH256, P.CAT)
      if (!taproot) {
        data(hex.decode('0000000003000000'))
        op(P.CAT)
      }
      op(taproot ? P.SHA256 : P.HASH256)
      copy(i)
      op(P.SWAP)
      if (taproot) data(hardware.slice(2))
      else {
        num(16)
        copy(3)
        op(P.CAT)
      }
      op(P.CHECKSIGFROMSTACK, P.VERIFY)
    }
    if (taproot) op(P.DROP)
    sizes.forEach(() => op(P.DROP))
    b.push(extra)
    num(1)
    const result = concat(...b)
    if (result.length === len) return result
    len = result.length
  }
  throw Error('length convergence')
}
