import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { type VaultNetwork } from '../constants'
import { networkPins } from '../networkPins'

// Preparation only. No enrollment, worker, or signing route activates this candidate.

export function lightDelegateService(network: VaultNetwork) {
  const pins = networkPins(network)
  return { origin: pins.delegateOrigin, pubkey: pins.delegatePub }
}

/** Validate the current Fulmine wire response against the enrolled network pins. */
export function validateLightDelegateInfo(network: VaultNetwork, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid delegate info')
  const info = value as Record<string, unknown>
  const pins = networkPins(network)
  if (info.pubkey !== pins.delegatePub) throw new Error('Delegate key does not match the network pin')
  // Both live services currently advertise zero. A fee change needs a new bounded plan.
  if (info.fee !== '0') throw new Error('Delegate fee changed')
  const current = typeof info.delegateAddress === 'string' && info.delegateAddress ? info.delegateAddress : undefined
  const legacy = typeof info.delegatorAddress === 'string' && info.delegatorAddress ? info.delegatorAddress : undefined
  if (current && legacy && current !== legacy) throw new Error('Conflicting delegate addresses')
  const address = current ?? legacy
  if (!address) throw new Error('Missing delegate address')
  const decoded = ArkAddress.decode(address)
  if (decoded.hrp !== pins.arkHrp || hex.encode(decoded.serverPubKey) !== pins.operatorSignerPub.slice(2)) {
    throw new Error('Delegate address does not match the network and Operator')
  }
  return { pubkey: pins.delegatePub, fee: '0', delegateAddress: address }
}
