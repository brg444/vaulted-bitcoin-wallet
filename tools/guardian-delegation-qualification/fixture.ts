// Public test keys and synthetic outputs only. No network or wallet access.
import { writeFileSync } from 'node:fs'
import {
  ArkAddress,
  DelegateManagerImpl,
  SingleKey,
  Intent,
  Transaction,
  type ArkInfo,
  type ContractVtxo,
  type DelegateProvider,
  type SignedIntent,
} from '@arkade-os/sdk'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64, hex } from '@scure/base'
import { p2wpkh, NETWORK, TEST_NETWORK } from '@scure/btc-signer'
import { buildLightDescriptor, defaultLightPolicy, LightScript } from '../../src/lib/vault/light/contract'
import { networkPins } from '../../src/lib/vault/networkPins'

const output = process.argv[2]
if (!output) throw new Error('Provide the public fixture output path')
globalThis.fetch = async () => {
  throw new Error('This fixture generator forbids network access')
}
const now = 1_788_700_000
const validAt = now + 3_600
const expiresAt = validAt + 3_600
const fixtures = []
for (const [network, operatorFee] of [
  ['mainnet', 0],
  ['mainnet', 150],
  ['mutinynet', 0],
  ['mutinynet', 150],
] as const) {
  const pins = networkPins(network)
  const secret = new Uint8Array(32).fill(1)
  const guardian = secp256k1.getPublicKey(new Uint8Array(32).fill(2))
  const descriptor = buildLightDescriptor({
    network,
    vaultId: 'aa'.repeat(32),
    ownerPub: hex.encode(schnorr.getPublicKey(secret)),
    cosignerPub: hex.encode(guardian.slice(1)),
    operatorPub: pins.operatorSignerPub.slice(2),
    exitDelaySeconds: pins.policyExitDelay,
    spendingPolicy: defaultLightPolicy(network),
  })
  const script = new LightScript(descriptor)
  const destination = new ArkAddress(hex.decode(descriptor.operatorPub), script.tweakedPublicKey, pins.arkHrp).encode()
  const forfeitAddress = p2wpkh(
    hex.decode(pins.checkpointForfeitPub),
    network === 'mainnet' ? NETWORK : TEST_NETWORK,
  ).address!
  const info = {
    network: pins.sdkNetwork,
    dust: 330n,
    forfeitAddress,
    fees: {
      intentFee: {
        offchainInput: operatorFee ? '100.0' : '0.0',
        offchainOutput: operatorFee ? '50.0' : '0.0',
        onchainInput: '0.0',
        onchainOutput: '0.0',
      },
      txFeeRate: '1',
    },
  } as ArkInfo
  const captured: { intent: SignedIntent<Intent.RegisterMessage>; forfeitTxs: string[] }[] = []
  const provider: DelegateProvider = {
    getDelegateInfo: async () => ({ pubkey: hex.encode(guardian), fee: '0', delegateAddress: destination }),
    delegate: async (intent, forfeitTxs) => {
      captured.push({ intent, forfeitTxs })
    },
  }
  // Future expiry keeps the fixture on the committed VTXO path independent of wall clock.
  const coin: ContractVtxo = {
    txid: '11'.repeat(32),
    vout: 0,
    value: 10_000,
    script: descriptor.scriptPubKey,
    contractScript: descriptor.scriptPubKey,
    createdAt: new Date(now * 1000),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    status: { confirmed: operatorFee === 0 },
    virtualStatus: { state: operatorFee ? 'preconfirmed' : 'settled' },
    isSpent: false,
    isSwept: false,
    isUnrolled: false,
    isPreconfirmed: operatorFee !== 0,
    commitmentTxIds: ['22'.repeat(32)],
    tapTree: script.encode(),
    forfeitTapLeafScript: script.forfeit(),
    intentTapLeafScript: script.forfeit(),
  }
  const result = await new DelegateManagerImpl(
    provider,
    { getInfo: async () => info },
    SingleKey.fromPrivateKey(secret),
  ).delegate([coin], destination, new Date(validAt * 1000))
  if (result.failed.length || result.delegated.length !== 1 || captured.length !== 1)
    throw new Error('SDK did not produce exactly one successful delegation')
  const signed = captured[0]
  // Native renewal bounds registration lifetime using the public SDK primitive.
  // Re-sign before persistence; the SDK partial forfeit remains byte-identical.
  const stockProof = Transaction.fromPSBT(base64.decode(signed.intent.proof))
  const message = { ...signed.intent.message, expire_at: expiresAt }
  const boundedProof = Intent.create(message, [coin], [stockProof.getOutput(0)])
  const bounded = await SingleKey.fromPrivateKey(secret).sign(boundedProof)
  const payload = {
    vaultId: descriptor.vaultId,
    operationId: '33'.repeat(16),
    intent: { proof: base64.encode(bounded.toPSBT()), message: JSON.stringify(message) },
    forfeitTxs: signed.forfeitTxs,
    expiresAt,
  }
  const digest = sha256(new TextEncoder().encode('vaulted-light/delegate-schedule/v1:' + JSON.stringify(payload)))
  const request = { ...payload, ownerSignature: hex.encode(schnorr.sign(digest, secret, new Uint8Array(32))) }
  fixtures.push({
    network,
    // The pinned SDK omits the 50-sat output fee before adding its receiver.
    operatorFee: operatorFee ? 100 : 0,
    quotedOperatorFee: operatorFee,
    isPreconfirmed: coin.isPreconfirmed,
    now,
    validAt,
    coinExpiresAt: now + 86_400,
    descriptor,
    forfeitAddress,
    request,
  })
  secret.fill(0)
}
writeFileSync(
  output,
  JSON.stringify({ source: 'Vaulted vendored SDK DelegateManagerImpl plus bounded Intent.create', fixtures }, null, 2) +
    '\n',
)
