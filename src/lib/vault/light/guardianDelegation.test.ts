import {
  ArkAddress,
  DelegateManagerImpl,
  DelegateVtxo,
  SingleKey,
  Transaction,
  type ArkInfo,
  type ContractVtxo,
  type DelegateProvider,
  type Intent,
  type SignedIntent,
} from '@arkade-os/sdk'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { base64, hex } from '@scure/base'
import { p2tr, TEST_NETWORK, SigHash } from '@scure/btc-signer'
import { describe, expect, it } from 'vitest'
import { LightScript } from './contract'
import { networkPins } from '../networkPins'

// Compatibility probe only. No runtime route, key export, or network request.
describe('Guardian as delegate on the existing Light contract', () => {
  it.each(['mainnet', 'mutinynet'] as const)(
    'uses the existing %s collaborative leaf without changing the tree',
    (network) => {
      const pins = networkPins(network)
      const owner = schnorr.getPublicKey(new Uint8Array(32).fill(1))
      const guardian = schnorr.getPublicKey(new Uint8Array(32).fill(2))
      const light = new LightScript({
        network,
        ownerPub: hex.encode(owner),
        cosignerPub: hex.encode(guardian),
        operatorPub: pins.operatorSignerPub.slice(2),
        exitDelaySeconds: pins.policyExitDelay,
      })
      const stock = new DelegateVtxo.Script({
        pubKey: owner,
        delegatePubKey: guardian,
        serverPubKey: hex.decode(pins.operatorSignerPub.slice(2)),
        csvTimelock: { type: 'seconds', value: BigInt(pins.policyExitDelay) },
      })
      expect(light.spendScript).toBe(stock.delegateScript)
      expect(light.scripts).toHaveLength(2)
      expect(light.exitScript).toBe(stock.defaultVtxo.exitScript)
    },
  )

  it('lets the pinned SDK preauthorize a known Light output for Guardian to renew later', async () => {
    const pins = networkPins('mutinynet')
    const secret = new Uint8Array(32).fill(1)
    const guardianPub = secp256k1.getPublicKey(new Uint8Array(32).fill(2))
    const owner = SingleKey.fromPrivateKey(secret)
    const script = new LightScript({
      network: 'mutinynet',
      ownerPub: hex.encode(schnorr.getPublicKey(secret)),
      cosignerPub: hex.encode(guardianPub.slice(1)),
      operatorPub: pins.operatorSignerPub.slice(2),
      exitDelaySeconds: pins.policyExitDelay,
    })
    const destination = new ArkAddress(
      hex.decode(script.params.operatorPub),
      script.tweakedPublicKey,
      pins.arkHrp,
    ).encode()
    const info = {
      network: 'mutinynet',
      dust: 330n,
      forfeitAddress: p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(3)), undefined, TEST_NETWORK).address!,
      fees: {
        intentFee: { offchainInput: '0.0', offchainOutput: '0.0', onchainInput: '0.0', onchainOutput: '0.0' },
        txFeeRate: '1',
      },
    } as ArkInfo
    const received: { intent: SignedIntent<Intent.RegisterMessage>; forfeits: string[] }[] = []
    const provider: DelegateProvider = {
      getDelegateInfo: async () => ({ pubkey: hex.encode(guardianPub), fee: '0', delegateAddress: destination }),
      delegate: async (intent, forfeits) => {
        received.push({ intent, forfeits })
      },
    }
    const coin: ContractVtxo = {
      txid: '11'.repeat(32),
      vout: 0,
      value: 10_000,
      script: hex.encode(script.pkScript),
      contractScript: hex.encode(script.pkScript),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400_000),
      status: { confirmed: true },
      virtualStatus: { state: 'settled' },
      isSpent: false,
      isSwept: false,
      isUnrolled: false,
      isPreconfirmed: false,
      commitmentTxIds: ['22'.repeat(32)],
      tapTree: script.encode(),
      forfeitTapLeafScript: script.forfeit(),
      intentTapLeafScript: script.forfeit(),
    }
    const dispatch = new Date(Date.now() + 3600_000)
    const manager = new DelegateManagerImpl(provider, { getInfo: async () => info }, owner)
    const result = await manager.delegate([coin], destination, dispatch)
    if (result.failed.length) throw result.failed[0].error
    expect(result.failed).toEqual([])
    expect(result.delegated).toHaveLength(1)
    expect(received).toHaveLength(1)
    const { intent, forfeits } = received[0]
    expect(intent.message.cosigners_public_keys).toEqual([hex.encode(guardianPub)])
    expect(intent.message.valid_at).toBe(Math.floor(dispatch.getTime() / 1000))
    expect(intent.message.expire_at).toBe(0)
    expect(intent.message.onchain_output_indexes).toEqual([])
    const proof = Transaction.fromPSBT(base64.decode(intent.proof))
    expect(proof.inputsLength).toBe(2)
    expect(proof.outputsLength).toBe(1)
    expect(proof.getInput(1).txid).toEqual(hex.decode(coin.txid))
    expect(proof.getOutput(0).script).toEqual(script.pkScript)
    expect(proof.getOutput(0).amount).toBe(10_000n)
    expect(forfeits).toHaveLength(1)
    const forfeit = Transaction.fromPSBT(base64.decode(forfeits[0]))
    expect(forfeit.inputsLength).toBe(1)
    expect(forfeit.getInput(0).sighashType).toBe(SigHash.ALL_ANYONECANPAY)
    expect(forfeit.getInput(0).tapScriptSig).toHaveLength(1)
    const sig = forfeit.getInput(0).tapScriptSig![0][1].slice(0, 64)
    const hash = forfeit.preimageWitnessV1(
      0,
      [script.pkScript],
      SigHash.ALL_ANYONECANPAY,
      [10_000n],
      undefined,
      hex.decode(script.spendScript),
    )
    expect(schnorr.verify(sig, hash, hex.decode(script.params.ownerPub))).toBe(true)
    const leaf = forfeit.getInput(0).tapLeafScript![0][1]
    expect(hex.encode(leaf.slice(0, -1))).toBe(script.spendScript)
    secret.fill(0)
  })
})
