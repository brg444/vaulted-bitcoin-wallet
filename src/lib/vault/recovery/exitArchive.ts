import { pagedRecoveryIndexer } from './pagedIndexer'
import {
  Transaction,
  ChainTxType,
  ChainedTxType,
  type ArkInfo,
  type ChainTx,
  type VirtualCoin,
  type ArkProvider,
  type IndexerProvider,
  type ExitDataSource,
  RestArkProvider,
  RestIndexerProvider,
  createExitChainResolver,
  type VirtualTxRepository,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { networkPins } from '../networkPins'

export interface ExitArchiveBinding {
  descriptorHash: string
  scriptPubKey: string
  network: string
}
// Public transaction data only. An atomic snapshot keeps the previous complete
// set available if capture, storage, or a concurrent transaction interrupts it.
export interface ExitArchive {
  version: 1
  descriptorHash: string
  capturedAt: string
  info: string
  coins: string
  branches: Record<string, ChainTx[]>
  transactions: Record<string, string>
}
const maxArchiveBytes = 12_000_000
const outpoint = (v: { txid: string; vout: number }) => `${v.txid}:${v.vout}`
const canonicalId = (id: string) => /^[0-9a-f]{64}$/.test(id)
export function normalizeRecoveryChain(chain: ChainTx[]): ChainTx[] {
  if (chain.length > 4096) throw new Error('Recovery path limit exceeded')
  const unique = new Map<string, ChainTx>()
  for (const node of chain) {
    const spends = node.spends.map((reference) => {
      if (canonicalId(reference)) return reference
      // Checkpoint ancestry from stock arkd names an outpoint, while the SDK
      // graph uses transaction IDs. Transaction PSBTs retain the exact index.
      const match = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/.exec(reference)
      if (!match || Number(match[2]) > 0xffffffff) throw new Error('Invalid recovery ancestry reference')
      return match[1]
    })
    const normalized = {
      txid: node.txid,
      type: node.type,
      expiresAt: node.expiresAt,
      spends: [...new Set(spends)].sort(),
    }
    const existing = unique.get(node.txid)
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized))
      throw new Error('Recovery ancestry disagrees about a transaction')
    unique.set(node.txid, normalized)
  }
  return [...unique.values()]
}
export function packExitArchive(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? { lightBigInt: String(v) } : v))
}
function unpack(raw: string): unknown {
  return JSON.parse(raw, (_, v) => {
    if (v && typeof v === 'object' && Object.keys(v).length === 1 && 'lightBigInt' in v) {
      if (typeof v.lightBigInt !== 'string' || !/^-?[0-9]{1,20}$/.test(v.lightBigInt))
        throw new Error('Invalid saved recovery number')
      return BigInt(v.lightBigInt)
    }
    return v
  })
}
export function requireExitArchiveInfo(info: ArkInfo, d: ExitArchiveBinding) {
  const pins = networkPins(d.network)
  if (
    info.network !== pins.operatorGetInfoNetwork ||
    info.signerPubkey !== pins.operatorSignerPub ||
    info.checkpointTapscript !== pins.checkpointTapscript ||
    info.forfeitPubkey !== pins.checkpointForfeitPub
  )
    throw new Error('Recovery data does not match this release')
}
export function validateExitArchive(value: ExitArchive, d: ExitArchiveBinding) {
  if (
    !value ||
    JSON.stringify(value).length > maxArchiveBytes ||
    value.version !== 1 ||
    value.descriptorHash !== d.descriptorHash ||
    !Number.isFinite(Date.parse(value.capturedAt))
  )
    throw new Error('Recovery data does not match this wallet')
  const info = unpack(value.info) as ArkInfo
  requireExitArchiveInfo(info, d)
  const rawCoins = unpack(value.coins) as VirtualCoin[]
  if (!Array.isArray(rawCoins) || rawCoins.length > 512) throw new Error('Recovery output limit exceeded')
  const coins = rawCoins.map((coin) => ({
    ...coin,
    createdAt: new Date(coin.createdAt),
    ...(coin.expiresAt ? { expiresAt: new Date(coin.expiresAt) } : {}),
  }))
  const seen = new Set<string>()
  const transactions = new Map<string, Transaction>()
  if (!value.transactions || Object.keys(value.transactions).length > 4096)
    throw new Error('Recovery transaction limit exceeded')
  for (const [id, psbt] of Object.entries(value.transactions)) {
    if (!canonicalId(id) || typeof psbt !== 'string' || psbt.length > 1_000_000)
      throw new Error('Invalid saved recovery transaction')
    const tx = Transaction.fromPSBT(base64.decode(psbt))
    if (tx.id !== id) throw new Error('Recovery transaction changed')
    transactions.set(id, tx)
  }
  for (const coin of coins) {
    const key = outpoint(coin)
    if (
      !canonicalId(coin.txid) ||
      !Number.isSafeInteger(coin.vout) ||
      coin.vout < 0 ||
      coin.vout > 0xffffffff ||
      !Number.isSafeInteger(coin.value) ||
      coin.value <= 0 ||
      coin.value > 21e14 ||
      coin.script !== d.scriptPubKey ||
      coin.isSpent ||
      coin.spentBy ||
      seen.has(key)
    )
      throw new Error('Saved recovery output changed')
    seen.add(key)
    const chain = value.branches?.[key]
    if (
      !Array.isArray(chain) ||
      !chain.length ||
      chain.length > 4096 ||
      new Set(chain.map((node) => node.txid)).size !== chain.length ||
      !chain.some((node) => node.txid === coin.txid)
    )
      throw new Error('Recovery path is incomplete')
    for (const node of chain) {
      if (
        !canonicalId(node.txid) ||
        !Array.isArray(node.spends) ||
        node.spends.some((id) => !canonicalId(id)) ||
        !Object.values(ChainTxType).includes(node.type) ||
        node.type === ChainTxType.UNSPECIFIED ||
        (node.type !== ChainTxType.COMMITMENT && !transactions.has(node.txid))
      )
        throw new Error('Recovery path is incomplete')
    }
    const nodes = new Map(chain.map((node) => [node.txid, node]))
    if (!chain.some((node) => node.type === ChainTxType.COMMITMENT))
      throw new Error('Recovery path has no Bitcoin commitment')
    for (const node of chain) {
      if (node.type === ChainTxType.COMMITMENT) continue
      const tx = transactions.get(node.txid)!
      const physical = new Set<string>()
      for (let i = 0; i < tx.inputsLength; i++) {
        const id = tx.getInput(i).txid
        if (!id) throw new Error('Recovery transaction input is incomplete')
        physical.add(hex.encode(id))
      }
      if (
        !physical.size ||
        [...physical].some((id) => !nodes.has(id)) ||
        [...physical].sort().join('|') !== [...new Set(node.spends)].sort().join('|')
      )
        throw new Error('Recovery ancestry does not match its transaction inputs')
    }
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string) => {
      if (visited.has(id)) return
      if (visiting.has(id)) throw new Error('Recovery ancestry contains a cycle')
      visiting.add(id)
      const node = nodes.get(id)
      if (!node) throw new Error('Recovery ancestry is incomplete')
      if (node.type !== ChainTxType.COMMITMENT) node.spends.forEach(visit)
      visiting.delete(id)
      visited.add(id)
    }
    visit(coin.txid)
    const output = transactions.get(coin.txid)?.getOutput(coin.vout)
    if (!output || output.amount !== BigInt(coin.value) || hex.encode(output.script!) !== d.scriptPubKey)
      throw new Error('Recovery output does not match its transaction')
  }
  return { archive: value, info, coins }
}

// Explicit local provider surfaces. Any unexpected SDK call fails without
// attempting network access. Bitcoin queries still use the ordinary Esplora provider.
export function exitArchiveProviders(archive: ExitArchive, d: ExitArchiveBinding) {
  const { info, coins } = validateExitArchive(archive, d)
  const source: ExitDataSource = {
    name: 'vaulted-device-archive',
    getVtxoChain: async (coin) => archive.branches[outpoint(coin)] ?? null,
    getVirtualTxs: async (ids) =>
      new Map(ids.flatMap((id) => (archive.transactions[id] ? [[id, archive.transactions[id]]] : []))),
  }
  function localOnly<T extends object>(methods: object): T {
    return new Proxy(methods, {
      get(target, key) {
        if (key === 'then') return undefined
        if (key in target) return Reflect.get(target, key)
        return () => {
          throw new Error(`Saved recovery data cannot supply ${String(key)}`)
        }
      },
    }) as T
  }
  const arkProvider = localOnly<ArkProvider>({
    getInfo: async () => info,
    // This immutable snapshot cannot announce a live signer rotation.
    onServerInfoChanged: () => () => {},
  })
  const indexerProvider = localOnly<IndexerProvider>({
    subscribeForScripts: async () => 'saved-vault-recovery',
    unsubscribeForScripts: async () => {},
    getSubscription: async function* (_id: string, signal: AbortSignal) {
      // Immutable data has no stream updates. Keep the SDK watcher local and
      // let its regular reads resolve against the saved output set.
      if (!signal.aborted)
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
    getVtxos: async (options: Parameters<IndexerProvider['getVtxos']>[0]) => ({
      vtxos: coins.filter(
        (coin) =>
          options?.outpoints?.some((v) => outpoint(v) === outpoint(coin)) || options?.scripts?.includes(coin.script),
      ),
    }),
    getVtxoChain: async (coin: { txid: string; vout: number }) => ({ chain: archive.branches[outpoint(coin)] ?? [] }),
    getVirtualTxs: async (ids: string[]) => ({
      txs: ids.flatMap((id) => (archive.transactions[id] ? [archive.transactions[id]] : [])),
    }),
  })
  return { arkProvider, indexerProvider, source, coins }
}

export async function captureExitArchive(
  d: ExitArchiveBinding,
  repository: VirtualTxRepository,
  previous: ExitArchive | null,
) {
  const url = networkPins(d.network).operatorOrigin
  const indexer = new RestIndexerProvider(url)
  const info = await new RestArkProvider(url).getInfo()
  requireExitArchiveInfo(info, d)
  const getCoins = async () => (await indexer.getVtxos({ scripts: [d.scriptPubKey] })).vtxos.filter((v) => !v.isSpent)
  const coins = await getCoins()
  const archive = await captureExitArchiveForCoins(d, repository, previous, coins, info, indexer)
  const fingerprint = (values: VirtualCoin[]) =>
    values
      .map((v) => `${outpoint(v)}:${v.value}:${v.script}`)
      .sort()
      .join('|')
  if (fingerprint(coins) !== fingerprint(await getCoins()))
    throw new Error('Your balance changed while saving recovery data')
  return archive
}

/** Capture the exact repository update while the caller holds its lifecycle lock. */
export async function captureExitArchiveForCoins(
  d: ExitArchiveBinding,
  repository: VirtualTxRepository,
  previous: ExitArchive | null,
  coins: VirtualCoin[],
  info: ArkInfo,
  indexer: IndexerProvider,
) {
  requireExitArchiveInfo(info, d)
  if (coins.length > 512) throw new Error('Recovery output limit exceeded')
  const previousCoins = previous ? validateExitArchive(previous, d).coins : []
  const removed = previousCoins.filter((old) => !coins.some((coin) => outpoint(coin) === outpoint(old)))
  if (removed.length) {
    const resolved = (await indexer.getVtxos({ outpoints: removed })).vtxos
    if (removed.some((old) => !resolved.some((coin) => outpoint(coin) === outpoint(old) && coin.isSpent)))
      throw new Error('An earlier output is missing. Previous recovery data has been retained.')
  }
  // Older SDK captures may have cached only the first indexer page. A branch
  // without a commitment cannot supply a complete exit; allow the resolver to
  // fetch its remaining ancestry instead of repeatedly choosing that cache.
  const completeBranches = new Proxy(repository, {
    get(target, key) {
      if (key === 'getBranch')
        return async (outpoint: Parameters<VirtualTxRepository['getBranch']>[0]) => {
          const branch = await target.getBranch(outpoint)
          return branch.some((node) => node.type === ChainedTxType.Commitment) ? branch : []
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const resolver = createExitChainResolver({
    indexer: pagedRecoveryIndexer(indexer),
    repository: completeBranches,
    extraSources: previous ? [exitArchiveProviders(previous, d).source] : [],
  })
  const branches: ExitArchive['branches'] = {}
  const wanted = new Set<string>()
  for (const coin of coins) {
    // Shared ancestors appear repeatedly in the public indexer's DAG walk.
    const prior = previousCoins.find((old) => outpoint(old) === outpoint(coin) && old.value === coin.value)
    const chain = prior ? previous!.branches[outpoint(coin)] : normalizeRecoveryChain(await resolver.getVtxoChain(coin))
    branches[outpoint(coin)] = chain
    for (const node of chain) if (node.type !== ChainTxType.COMMITMENT) wanted.add(node.txid)
    if (wanted.size > 4096) throw new Error('Recovery transaction limit exceeded')
  }
  const transactions: Record<string, string> = {}
  for (const id of wanted) if (previous?.transactions[id]) transactions[id] = previous.transactions[id]
  const ids = [...wanted].filter((id) => !transactions[id])
  for (let i = 0; i < ids.length; i += 100) {
    for (const psbt of await resolver.getVirtualTxs(ids.slice(i, i + 100))) {
      if (psbt.length > 1_000_000) throw new Error('Recovery transaction limit exceeded')
      transactions[Transaction.fromPSBT(base64.decode(psbt)).id] = psbt
    }
  }
  const archive: ExitArchive = {
    version: 1,
    descriptorHash: d.descriptorHash,
    capturedAt: new Date().toISOString(),
    info: packExitArchive(info),
    coins: packExitArchive(coins),
    branches,
    transactions,
  }
  validateExitArchive(archive, d)
  return archive
}
