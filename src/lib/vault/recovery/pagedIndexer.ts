import {
  createExitChainResolver,
  ChainedTxType,
  Transaction,
  type VirtualTxRepository,
  type ExitDataSource,
  type IndexerProvider,
  type PageResponse,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'

// Request a single public DAG snapshot where supported: separately requested
// pages can order shared ancestors differently. If a provider returns pagination,
// follow its cursor even when it caps a requested page below the requested size.
async function allPages<T>(
  fetchPage: (pageIndex: number | undefined) => Promise<{ values: T[]; page?: PageResponse }>,
): Promise<T[]> {
  const values: T[] = []
  let index: number | undefined
  const seen = new Set<number>()
  for (let count = 0; count < 64; count++) {
    const result = await fetchPage(index)
    values.push(...result.values)
    if (values.length > 4096) throw new Error('Recovery pagination limit exceeded')
    const page = result.page
    if (!page) return values
    if (
      !Number.isSafeInteger(page.current) ||
      page.current < 0 ||
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      !Number.isSafeInteger(page.next) ||
      page.next < 0 ||
      seen.has(page.current)
    )
      throw new Error('Invalid recovery pagination')
    seen.add(page.current)
    if (page.next === 0 || (page.current === page.total && page.next === page.current)) return values
    if (page.next <= page.current || page.next > page.total || !result.values.length)
      throw new Error('Recovery pagination did not advance')
    index = page.next
  }
  throw new Error('Recovery pagination limit exceeded')
}

/** Adapt recovery reads only. The SDK continues to own wallet state and transactions. */
export function pagedRecoveryIndexer(indexer: IndexerProvider): IndexerProvider {
  return new Proxy(indexer, {
    get(target, key) {
      if (key === 'getVtxoChain')
        return async (outpoint: Parameters<IndexerProvider['getVtxoChain']>[0]) => ({
          chain: await allPages(async (pageIndex) => {
            const result = await target.getVtxoChain(
              outpoint,
              pageIndex === undefined ? undefined : { pageIndex, pageSize: 100 },
            )
            return { values: result.chain, page: result.page }
          }),
        })
      if (key === 'getVirtualTxs')
        return async (ids: string[]) => ({
          txs: await allPages(async (pageIndex) => {
            const result = await target.getVirtualTxs(
              ids,
              pageIndex === undefined ? undefined : { pageIndex, pageSize: 100 },
            )
            return { values: result.txs, page: result.page }
          }),
        })
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Reuse the SDK resolver with complete public snapshots and eligible cached branches. */
export function recoveryChainResolver(
  indexer: IndexerProvider,
  repository: VirtualTxRepository,
  extraSources: ExitDataSource[] = [],
) {
  const completeBranches = new Proxy(repository, {
    get(target, key) {
      if (key === 'getBranch')
        return async (outpoint: Parameters<VirtualTxRepository['getBranch']>[0]) => {
          const branch = await target.getBranch(outpoint)
          // A truncated SDK page can already contain commitments. Every
          // noncommitment must have its exact PSBT and all of its parents before
          // this cache may take precedence over a complete indexer snapshot.
          if (
            !branch.length ||
            branch.length > 4096 ||
            !branch.some((node) => node.txid === outpoint.txid) ||
            !branch.some((node) => node.type === ChainedTxType.Commitment)
          )
            return []
          const ids = new Set(branch.map((node) => node.txid))
          try {
            for (const node of branch) {
              if (node.type === ChainedTxType.Commitment) continue
              if (node.type === ChainedTxType.Unspecified || !node.psbt || node.psbt.length > 1_000_000) return []
              const tx = Transaction.fromPSBT(base64.decode(node.psbt))
              if (tx.id !== node.txid || !tx.inputsLength) return []
              for (let i = 0; i < tx.inputsLength; i++) {
                const parent = tx.getInput(i).txid
                if (!parent || !ids.has(hex.encode(parent))) return []
              }
            }
          } catch {
            return []
          }
          return branch
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return createExitChainResolver({ indexer: pagedRecoveryIndexer(indexer), repository: completeBranches, extraSources })
}
