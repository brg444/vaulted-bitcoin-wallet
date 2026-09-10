import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArkAddress, Transaction } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { ledgerBip32Versions, type LedgerSavingsKeyContext } from '../program/ledgerNativeKeys'
import vectors from '../program/ledger-family-vectors.json'
import { scalarSecret } from '../program/fixtures'
import { buildLedgerRecoveryDescriptor, LEDGER_ENROLLMENT_SCHEMA } from '../program/ledgerRecoveryDescriptor'
import { networkPins } from '../networkPins'
import { recoveryFixture } from '../recovery/testdata/helpers'
import { requireExactDefaultTapscriptSignatures, tapscriptSignatureRecords } from '../taprootSignatures'
import { VaultPolicyV1Script } from './script'
import {
  buildLedgerSpendingRecoveryPsbt,
  inspectLedgerSpendingRecovery,
  signLedgerSpendingRecoveryWithSeed,
  type LedgerSpendingRecoveryRequest,
} from './ledgerSpendingRecovery'

const seed = new Uint8Array(64).fill(0x44) // Public disposable BIP39-seed-sized fixture only.
const recoverySeed = new Uint8Array(64).fill(0x46)

function fixture(advanced: boolean, network: 'mainnet' | 'mutinynet') {
  const source = vectors.find((v) => v.input.network === network && Boolean(v.input.recovery) === advanced)!
  const context = structuredClone(source.input) as LedgerSavingsKeyContext
  const nodes: HDKey[] = []
  let hardware: string
  let recovery: string | undefined
  let counterpart = scalarSecret(3)
  try {
    let key = HDKey.fromMasterSeed(seed, ledgerBip32Versions(network))
    nodes.push(key)
    const fingerprint = key.fingerprint.toString(16).padStart(8, '0')
    for (const index of context.hardware.path) {
      key = key.deriveChild(index)
      nodes.push(key)
    }
    context.hardware = { ...context.hardware, fingerprint, xpub: key.publicExtendedKey }
    for (const index of [12, 0]) {
      key = key.deriveChild(index)
      nodes.push(key)
    }
    hardware = '02' + hex.encode(key.publicKey!.slice(1))
    if (advanced) {
      key = HDKey.fromMasterSeed(recoverySeed, ledgerBip32Versions(network))
      nodes.push(key)
      const recoveryFingerprint = key.fingerprint.toString(16).padStart(8, '0')
      for (const index of context.recovery!.path) {
        key = key.deriveChild(index)
        nodes.push(key)
      }
      context.recovery = { ...context.recovery!, xpub: key.publicExtendedKey, fingerprint: recoveryFingerprint }
      for (const index of [12, 0]) {
        key = key.deriveChild(index)
        nodes.push(key)
      }
      recovery = '02' + hex.encode(key.publicKey!.slice(1))
      counterpart.fill(0)
      counterpart = Uint8Array.from(key.privateKey!)
    }
  } finally {
    for (const key of nodes) key.wipePrivateData()
  }
  const { status, board } = recoveryFixture(advanced, network)
  const pins = networkPins(network)
  const a = {
    phoneBip340Pub: status.phoneBip340Pub!,
    externalOwnerWalletPub: hardware!,
    recoveryKeyPub: recovery || '',
    vaultCosignerBasePub: status.vaultCosignerBasePub!,
    arkadeCosignerBasePub: status.arkadeCosignerBasePub!,
    phoneDirectP256: status.phoneDirectP256!,
    vtxoVaultCosignerPub: status.vtxoVaultCosignerPub!,
    operatorPub: pins.operatorSignerPub,
    vtxoDelegatePub: pins.delegatePub,
    vtxoExitDelay: pins.policyExitDelay,
    vtxoExitDelayUnit: 'seconds',
    spendingArkAddress: '',
    spendingArkScript: '',
  }
  // Savings and Spending keep separate phone identities; only authentication is shared.
  context.phoneDirectP256 = a.phoneDirectP256
  const xonly = (pub: string) => hex.decode(pub.slice(2))
  const spending = new VaultPolicyV1Script({
    userPub: xonly(a.phoneBip340Pub),
    exitDevicePub: xonly(a.phoneBip340Pub),
    exitHardwarePub: xonly(a.externalOwnerWalletPub),
    ...(advanced ? { exitRecoveryPub: xonly(a.recoveryKeyPub) } : {}),
    vtxoVaultCosignerPub: xonly(a.vtxoVaultCosignerPub),
    arkdServerPub: xonly(a.operatorPub),
    delegatePub: xonly(a.vtxoDelegatePub),
    exitDelay: BigInt(a.vtxoExitDelay),
    exitDelayUnit: 'seconds',
    network,
  })
  a.spendingArkAddress = new ArkAddress(xonly(a.operatorPub), spending.tweakedPublicKey, pins.arkHrp).encode()
  a.spendingArkScript = hex.encode(spending.pkScript)
  const descriptor = buildLedgerRecoveryDescriptor({
    schema: LEDGER_ENROLLMENT_SCHEMA,
    vaultId: context.vaultId,
    savings: {
      context,
      spendingPolicy:
        source.spendingPolicy as LedgerSpendingRecoveryRequest['descriptor']['ledgerSavings']['spendingPolicy'],
    },
    spendingAuthorities: a,
    boarding: { ...status.vtxoBoardingDescriptor!, script: hex.encode(board.pkScript) },
  })
  const parent = new Transaction({ version: 2 })
  parent.addInput({ txid: '42'.repeat(32), index: 0 })
  parent.addOutput({ amount: 40_000n, script: spending.pkScript })
  const request: LedgerSpendingRecoveryRequest = {
    descriptor,
    coin: { txid: parent.id, vout: 0, value: 40_000, parentTxHex: hex.encode(parent.toBytes(true, true)) },
    destination: descriptor.savings.address,
    feeSats: 1000,
  }
  return { request, spending, counterpart }
}

function mutate(psbt: string, fn: (tx: Transaction) => void): string {
  const tx = Transaction.fromPSBT(hex.decode(psbt))
  fn(tx)
  return hex.encode(tx.toPSBT())
}

afterEach(() => vi.restoreAllMocks())

describe('offline Ledger seed recovery for the unchanged Spending exit', () => {
  for (const network of ['mainnet', 'mutinynet'] as const)
    for (const advanced of [false, true]) {
      it(`${network} ${advanced ? 'Advanced H+R' : 'Standard P+H'} requires both original authorities and no services`, () => {
        const { request, spending, counterpart } = fixture(advanced, network)
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline recovery'))
        const unsigned = buildLedgerSpendingRecoveryPsbt(request)
        const before = Uint8Array.from(seed)
        const hardwareOnly = signLedgerSpendingRecoveryWithSeed(request, seed, unsigned)
        expect(seed).toEqual(before)
        const tx = Transaction.fromPSBT(hex.decode(hardwareOnly))
        requireExactDefaultTapscriptSignatures(tx, 0, [request.descriptor.keys.hardware])
        expect(() =>
          requireExactDefaultTapscriptSignatures(tx, 0, [
            request.descriptor.keys.hardware,
            advanced ? request.descriptor.keys.recovery! : request.descriptor.keys.phoneBip340,
          ]),
        ).toThrow('signer set')
        tx.signIdx(counterpart, 0)
        const facts = inspectLedgerSpendingRecovery(request)
        expect(facts.requiredKeys.map((key) => key.role)).toEqual(
          advanced ? ['hardware', 'recovery'] : ['phone', 'hardware'],
        )
        requireExactDefaultTapscriptSignatures(
          tx,
          0,
          facts.requiredKeys.map((key) => key.publicKey),
        )
        expect(tx.getInput(0).tapLeafScript).toEqual([spending.exit()])
        expect(hex.encode(tx.getInput(0).witnessUtxo!.script)).toBe(
          request.descriptor.spendingAuthorities.spendingArkScript,
        )
        expect(tx.getInput(0).sequence).toBe((1 << 22) + networkPins(network).policyExitDelay / 512)
        expect(tx.getInput(0).tapScriptSig!.every(([, sig]) => sig.length === 64)).toBe(true)
        tx.finalize()
        expect(tx.vsize).toBe(facts.vsize)
        expect(tx.getOutput(0).amount).toBe(39_000n)
        expect(fetch).not.toHaveBeenCalled()
        counterpart.fill(0)
      })
    }

  it('preserves an already approved counterpart signature and adds only the hardware signature', () => {
    const { request, counterpart } = fixture(true, 'mainnet')
    const approved = Transaction.fromPSBT(hex.decode(buildLedgerSpendingRecoveryPsbt(request)))
    approved.signIdx(counterpart, 0)
    const retained = tapscriptSignatureRecords(approved, 0)
    const signed = Transaction.fromPSBT(
      hex.decode(signLedgerSpendingRecoveryWithSeed(request, seed, hex.encode(approved.toPSBT()))),
    )
    expect(tapscriptSignatureRecords(signed, 0)).toEqual(expect.arrayContaining(retained))
    expect(signed.getInput(0).tapScriptSig).toHaveLength(2)
    expect(hex.encode(signed.unsignedTx)).toBe(hex.encode(approved.unsignedTx))
  })

  it.each(['mainnet', 'mutinynet'] as const)(
    'completes Advanced recovery with both separate seed authorities on %s',
    (network) => {
      const { request } = fixture(true, network)
      const unsigned = buildLedgerSpendingRecoveryPsbt(request)
      const r = signLedgerSpendingRecoveryWithSeed(request, recoverySeed, unsigned, 'recovery')
      const rh = signLedgerSpendingRecoveryWithSeed(request, seed, r)
      const h = signLedgerSpendingRecoveryWithSeed(request, seed, unsigned)
      const hr = signLedgerSpendingRecoveryWithSeed(request, recoverySeed, h, 'recovery')
      for (const psbt of [rh, hr]) {
        const tx = Transaction.fromPSBT(hex.decode(psbt))
        requireExactDefaultTapscriptSignatures(tx, 0, [
          request.descriptor.keys.hardware,
          request.descriptor.keys.recovery!,
        ])
        tx.finalize()
        expect(tx.vsize).toBe(inspectLedgerSpendingRecovery(request).vsize)
      }
      expect(() => signLedgerSpendingRecoveryWithSeed(request, seed, unsigned, 'recovery')).toThrow('seed')
      expect(() => signLedgerSpendingRecoveryWithSeed(request, recoverySeed, unsigned)).toThrow('seed')
      const standard = fixture(false, network).request
      expect(() =>
        signLedgerSpendingRecoveryWithSeed(
          standard,
          recoverySeed,
          buildLedgerSpendingRecoveryPsbt(standard),
          'recovery',
        ),
      ).toThrow('not enrolled')
      expect(() => signLedgerSpendingRecoveryWithSeed(request, seed, unsigned, 'phone' as 'hardware')).toThrow(
        'Unknown',
      )
    },
  )

  it('rejects the wrong seed, invalid seed sizes, fingerprint, xpub and account path', () => {
    const { request } = fixture(false, 'mutinynet')
    const psbt = buildLedgerSpendingRecoveryPsbt(request)
    for (const wrong of [new Uint8Array(64).fill(0x45), new Uint8Array(32), new Uint8Array(), new Uint8Array(65)])
      expect(() => signLedgerSpendingRecoveryWithSeed(request, wrong, psbt)).toThrow(/seed|BIP39/)
    for (const change of [
      (r: LedgerSpendingRecoveryRequest) => {
        r.descriptor.ledgerSavings.context.hardware.fingerprint = '00000000'
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.descriptor.ledgerSavings.context.hardware.xpub = r.descriptor.ledgerSavings.context.phone.xpub
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.descriptor.ledgerSavings.context.hardware.path[2]++
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.descriptor.ledgerSavings.context.hardware.path.push(12, 0)
      },
    ]) {
      const changed = structuredClone(request)
      change(changed)
      expect(() => signLedgerSpendingRecoveryWithSeed(changed, seed, psbt)).toThrow()
    }
  })

  const changes: [string, (tx: Transaction) => void][] = [
    ['amount', (tx) => tx.updateOutput(0, { amount: 38_999n })],
    ['destination', (tx) => tx.updateOutput(0, { script: hex.decode('5120' + '45'.repeat(32)) })],
    ['additional output', (tx) => tx.addOutput({ amount: 330n, script: hex.decode('5120' + '45'.repeat(32)) })],
    ['outpoint', (tx) => tx.updateInput(0, { txid: '43'.repeat(32) })],
    ['output index', (tx) => tx.updateInput(0, { index: 1 })],
    ['CSV sequence', (tx) => tx.updateInput(0, { sequence: 0xffffffff })],
    ['input value', (tx) => tx.updateInput(0, { witnessUtxo: { ...tx.getInput(0).witnessUtxo!, amount: 40_001n } })],
    [
      'input script',
      (tx) =>
        tx.updateInput(0, {
          witnessUtxo: { ...tx.getInput(0).witnessUtxo!, script: hex.decode('5120' + '45'.repeat(32)) },
        }),
    ],
    ['sighash', (tx) => tx.updateInput(0, { sighashType: 1 })],
    [
      'unknown input metadata',
      (tx) => tx.updateInput(0, { unknown: [[{ type: 222, key: new Uint8Array([7]) }, new Uint8Array([8])]] }),
    ],
    ['key-path signature', (tx) => tx.updateInput(0, { tapKeySig: new Uint8Array(64) })],
    ['final witness', (tx) => tx.updateInput(0, { finalScriptWitness: [new Uint8Array(64)] })],
    [
      'additional tapleaf',
      (tx) =>
        tx.updateInput(0, {
          tapLeafScript: [
            ...tx.getInput(0).tapLeafScript!,
            [{ ...tx.getInput(0).tapLeafScript![0][0], merklePath: [] }, new Uint8Array([0x51, 0xc0])],
          ],
        }),
    ],
  ]
  it.each(changes)('rejects modified %s before deriving private keys', (_name, change) => {
    const { request } = fixture(false, 'mutinynet')
    const altered = mutate(buildLedgerSpendingRecoveryPsbt(request), change)
    const derive = vi.spyOn(HDKey, 'fromMasterSeed')
    expect(() => signLedgerSpendingRecoveryWithSeed(request, seed, altered)).toThrow()
    expect(derive).not.toHaveBeenCalled()
  })

  it('rejects changed parent, value, network, branch and fee bounds', () => {
    const { request } = fixture(false, 'mutinynet')
    const psbt = buildLedgerSpendingRecoveryPsbt(request)
    for (const change of [
      (r: LedgerSpendingRecoveryRequest) => {
        r.coin.parentTxHex = r.coin.parentTxHex.slice(0, -2)
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.coin.txid = '66'.repeat(32)
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.coin.vout = 1
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.coin.value++
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.coin.value = Number.MAX_SAFE_INTEGER
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.descriptor.network = 'mainnet'
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.descriptor.spendingAuthorities.externalOwnerWalletPub = r.descriptor.keys.phoneBip340
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.feeSats = 0
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.feeSats = -1
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.feeSats = 1.5
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.feeSats = 5001
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.feeSats = 4999
      },
      (r: LedgerSpendingRecoveryRequest) => {
        r.destination = fixture(false, 'mainnet').request.destination
      },
    ]) {
      const changed = structuredClone(request)
      change(changed)
      expect(() => signLedgerSpendingRecoveryWithSeed(changed, seed, psbt)).toThrow()
    }
  })

  it('measures the complete two-signature witness for exact fee and dust bounds', () => {
    const { request } = fixture(false, 'mutinynet')
    const cap = inspectLedgerSpendingRecovery(request).vsize * request.descriptor.policy.feerateCapSatVb
    expect(() => buildLedgerSpendingRecoveryPsbt({ ...request, feeSats: cap })).not.toThrow()
    expect(() => buildLedgerSpendingRecoveryPsbt({ ...request, feeSats: cap + 1 })).toThrow('feerate cap')
    const small = structuredClone(request)
    const parent = Transaction.fromRaw(hex.decode(small.coin.parentTxHex))
    parent.updateOutput(0, { amount: 331n })
    small.coin = { txid: parent.id, vout: 0, value: 331, parentTxHex: hex.encode(parent.toBytes(true, true)) }
    small.feeSats = 1
    expect(inspectLedgerSpendingRecovery(small).amountSats).toBe(330)
    expect(() => buildLedgerSpendingRecoveryPsbt({ ...small, feeSats: 2 })).toThrow('below dust')
  })

  it('rejects altered transaction version, locktime, and extra inputs', () => {
    const { request } = fixture(false, 'mutinynet')
    const original = Transaction.fromPSBT(hex.decode(buildLedgerSpendingRecoveryPsbt(request)))
    for (const options of [
      { version: 1, lockTime: 0 },
      { version: 2, lockTime: 1 },
    ]) {
      const changed = new Transaction(options)
      changed.addInput(original.getInput(0))
      changed.addOutput(original.getOutput(0))
      expect(() => signLedgerSpendingRecoveryWithSeed(request, seed, hex.encode(changed.toPSBT()))).toThrow(
        'transaction changed',
      )
    }
    original.addInput({ txid: 'ab'.repeat(32), index: 0 })
    expect(() => signLedgerSpendingRecoveryWithSeed(request, seed, hex.encode(original.toPSBT()))).toThrow(
      'transaction changed',
    )
  })

  it('rejects foreign, duplicate, invalid, non-DEFAULT and already present hardware signatures', () => {
    const { request, counterpart } = fixture(true, 'mutinynet')
    const approved = Transaction.fromPSBT(hex.decode(buildLedgerSpendingRecoveryPsbt(request)))
    approved.signIdx(counterpart, 0)
    const [key, signature] = approved.getInput(0).tapScriptSig![0]
    for (const signatures of [
      [[{ ...key, pubKey: hex.decode(request.descriptor.keys.phoneBip340.slice(2)) }, signature]],
      [[key, new Uint8Array(64)]],
      [[key, new Uint8Array([...signature, 1])]],
      [[{ ...key, leafHash: new Uint8Array(32) }, signature]],
    ]) {
      const bad = Transaction.fromPSBT(hex.decode(buildLedgerSpendingRecoveryPsbt(request)))
      bad.updateInput(0, {
        tapScriptSig: signatures as [typeof key, Uint8Array][],
      })
      expect(() => signLedgerSpendingRecoveryWithSeed(request, seed, hex.encode(bad.toPSBT()))).toThrow()
    }
    const signed = signLedgerSpendingRecoveryWithSeed(request, seed, hex.encode(approved.toPSBT()))
    expect(() => signLedgerSpendingRecoveryWithSeed(request, seed, signed)).toThrow('unexpected')
  })

  it('wipes every owned private derivation and its seed copy on success and failure', () => {
    const { request } = fixture(false, 'mainnet')
    const psbt = buildLedgerSpendingRecoveryPsbt(request)
    const real = HDKey.fromMasterSeed
    const captured: HDKey[] = []
    const copies: Uint8Array[] = []
    const derive = HDKey.prototype.deriveChild
    vi.spyOn(HDKey, 'fromMasterSeed').mockImplementation((bytes, versions) => {
      copies.push(bytes)
      const key = real(bytes, versions)
      captured.push(key)
      return key
    })
    vi.spyOn(HDKey.prototype, 'deriveChild').mockImplementation(function (this: HDKey, index: number) {
      const key = derive.call(this, index)
      if (key.privateKey) captured.push(key)
      return key
    })
    signLedgerSpendingRecoveryWithSeed(request, seed, psbt)
    expect(captured.length).toBe(6)
    expect(captured.every((key) => key.privateKey === null)).toBe(true)
    expect(copies.every((bytes) => bytes.every((n) => n === 0))).toBe(true)
    captured.length = 0
    expect(() => signLedgerSpendingRecoveryWithSeed(request, new Uint8Array(64).fill(9), psbt)).toThrow('seed')
    expect(captured.every((key) => key.privateKey === null)).toBe(true)
    expect(copies.every((bytes) => bytes.every((n) => n === 0))).toBe(true)
    expect(seed.every((n) => n === 0x44)).toBe(true)
  })

  it('wipes account and rejected child secrets when BIP32 would skip the enrolled coordinate', () => {
    const { request } = fixture(false, 'mainnet')
    const psbt = buildLedgerSpendingRecoveryPsbt(request)
    const derive = HDKey.prototype.deriveChild
    const captured: HDKey[] = []
    vi.spyOn(HDKey.prototype, 'deriveChild').mockImplementation(function (this: HDKey, index: number) {
      const child = derive.call(this, index)
      if (child.privateKey) {
        captured.push(child)
        if (index === 12) Object.defineProperty(child, 'index', { value: 13 })
      }
      return child
    })
    expect(() => signLedgerSpendingRecoveryWithSeed(request, seed, psbt)).toThrow('derivation')
    expect(captured.length).toBeGreaterThan(0)
    expect(captured.every((key) => key.privateKey === null)).toBe(true)
  })
})
