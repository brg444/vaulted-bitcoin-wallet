import {
  ChainTxType,
  Transaction,
  createExitChainResolver,
  type ArkInfo,
  type VirtualCoin,
  type IndexerProvider,
} from '@arkade-os/sdk'
import { base64 } from '@scure/base'
import { normalizeRecoveryChain, packExitArchive, validateExitArchive } from '../recovery/exitArchive'
import { lightDescriptorDigest, type LightDescriptor } from './contract'
import { lightExitRepository } from './exitRepository'
import type { VaultNetwork } from '../constants'

/** A preconfirmed receipt is eligible once its complete committed ancestry exists. */
export async function requireGuardianInputAncestry(
  d: LightDescriptor,
  coin: VirtualCoin,
  info: ArkInfo,
  indexer: IndexerProvider,
) {
  return requireDelegationInputAncestryForBinding(
    {
      network: d.network,
      descriptorHash: lightDescriptorDigest(d),
      scriptPubKey: d.scriptPubKey,
    },
    coin,
    info,
    indexer,
    () => lightExitRepository(d),
  )
}

export async function requireDelegationInputAncestryForBinding(
  binding: { network: VaultNetwork; descriptorHash: string; scriptPubKey: string },
  coin: VirtualCoin,
  info: ArkInfo,
  indexer: IndexerProvider,
  createRepository: () => ReturnType<typeof lightExitRepository>,
) {
  const repository = createRepository()
  try {
    const resolver = createExitChainResolver({ indexer, repository })
    const chain = normalizeRecoveryChain(await resolver.getVtxoChain(coin))
    if (
      !coin.commitmentTxIds?.length ||
      coin.commitmentTxIds.some((id) => !chain.some((node) => node.txid === id && node.type === ChainTxType.COMMITMENT))
    )
      throw new Error('Output commitment ancestry is incomplete')
    const ids = chain.filter((node) => node.type !== ChainTxType.COMMITMENT).map((node) => node.txid)
    const transactions: Record<string, string> = {}
    for (let i = 0; i < ids.length; i += 100) {
      for (const psbt of await resolver.getVirtualTxs(ids.slice(i, i + 100))) {
        if (psbt.length > 1_000_000) throw new Error('Recovery transaction limit exceeded')
        transactions[Transaction.fromPSBT(base64.decode(psbt)).id] = psbt
      }
    }
    validateExitArchive(
      {
        version: 1,
        descriptorHash: binding.descriptorHash,
        capturedAt: new Date().toISOString(),
        info: packExitArchive(info),
        coins: packExitArchive([coin]),
        branches: { [`${coin.txid}:${coin.vout}`]: chain },
        transactions,
      },
      binding,
    )
  } finally {
    await repository[Symbol.asyncDispose]()
  }
}
