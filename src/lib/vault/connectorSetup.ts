import { connectorContract, reconcileConnectorWithdrawal } from './connectorWithdrawal'
import { loadFunding } from './connectorFunding'
import { fetchAddressUtxos } from './esplora'
import { buildConnectorFamily, CONNECTOR_RESERVE_SATS, DUAL_CONNECTOR_TEMPLATE } from './program/connector'
import type { VaultStatus } from './types'

export async function checkConnectorSetup(status: VaultStatus) {
  // Derive the destination only from the locally verified enrollment.
  const contract = connectorContract(status)
  const address = buildConnectorFamily(contract).connector.address!
  const amount = contract.templateVersion === DUAL_CONNECTOR_TEMPLATE ? 500 : CONNECTOR_RESERVE_SATS
  const required = contract.templateVersion === DUAL_CONNECTOR_TEMPLATE ? 2 : 1
  // A saved deposit may already create the outputs; an unresolved withdrawal
  // may temporarily consume them. Neither is a reason to fund them again.
  if (loadFunding(status)) return { state: 'deposit' as const }
  if (await reconcileConnectorWithdrawal(status)) return { state: 'withdrawal' as const }
  const coins = await fetchAddressUtxos(address)
  if (!Array.isArray(coins)) throw new Error('Could not check signer setup.')
  const seen = new Set<string>()
  let confirmed = 0
  let pending = 0
  for (const coin of coins) {
    if (
      !coin ||
      !/^[a-f0-9]{64}$/i.test(coin.txid) ||
      !Number.isSafeInteger(coin.vout) ||
      coin.vout < 0 ||
      !Number.isSafeInteger(coin.value) ||
      coin.value < 0 ||
      typeof coin.status?.confirmed !== 'boolean'
    )
      throw new Error('Could not check signer setup.')
    const id = `${coin.txid.toLowerCase()}:${coin.vout}`
    if (seen.has(id)) throw new Error('Could not check signer setup.')
    seen.add(id)
    if (coin.value !== amount) continue
    if (coin.status.confirmed) confirmed++
    else pending++
  }
  return {
    state: 'checked' as const,
    address,
    amount,
    required,
    confirmed,
    pending,
    missing: Math.max(0, required - confirmed - pending),
  }
}
