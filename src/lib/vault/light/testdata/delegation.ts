import { getNetwork, type ArkInfo, type VirtualCoin } from '@arkade-os/sdk'
import { p2tr } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { networkPins } from '../../networkPins'
import { testDescriptor } from './helpers'
import { lightDelegationAddress, type GuardianDelegateInfo } from '../delegationRequest'
export function delegationFixture(d = testDescriptor, now = Date.now()) {
  const pins = networkPins(d.network)
  const coin = {
    txid: '11'.repeat(32),
    vout: 0,
    value: 10000,
    script: d.scriptPubKey,
    createdAt: new Date(now - 86400000),
    expiresAt: new Date(now + 7 * 86400000),
    commitmentTxIds: ['22'.repeat(32)],
    isSpent: false,
    isSwept: false,
    isPreconfirmed: false,
  } as VirtualCoin
  const info = {
    network: pins.operatorGetInfoNetwork,
    signerPubkey: pins.operatorSignerPub,
    forfeitPubkey: pins.checkpointForfeitPub,
    checkpointTapscript: pins.checkpointTapscript,
    dust: 330n,
    forfeitAddress: p2tr(hex.decode(pins.checkpointForfeitPub).slice(1), undefined, getNetwork(pins.sdkNetwork))
      .address!,
    fees: {
      intentFee: { offchainInput: '0.0', offchainOutput: '0.0', onchainInput: '0.0', onchainOutput: '0.0' },
      txFeeRate: '1',
    },
  } as ArkInfo
  const capability: GuardianDelegateInfo = {
    enabled: true,
    version: 1,
    maxInputs: 1,
    maxScheduleSeconds: 2592000,
    pubkey: '02' + d.cosignerPub,
    fee: '0',
    delegateAddress: lightDelegationAddress(d),
  }
  return { d, coin, info, capability }
}
