import {
  RestArkProvider,
  RestIndexerProvider,
  Transaction,
  createExitChainResolver,
  ChainTxType,
  type ArkInfo,
  type ArkProvider,
  type IndexerProvider,
  type ChainTx,
  type VirtualCoin,
  type ExitDataSource,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { lightDescriptorDigest, validateLightDescriptor, type LightDescriptor } from './contract'
import { networkPins } from '../networkPins'

// Public transaction data only. An atomic snapshot keeps the previous complete
// set available if capture, storage, or a concurrent transaction interrupts it.
export interface LightRecoveryArchive {
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
export function normalizeLightRecoveryChain(chain: ChainTx[]): ChainTx[] {
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
function pack(value: unknown): string {
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
function requireInfo(info: ArkInfo, d: LightDescriptor) {
  const pins = networkPins(d.network)
  if (
    info.network !== pins.operatorGetInfoNetwork ||
    info.signerPubkey !== pins.operatorSignerPub ||
    info.checkpointTapscript !== pins.checkpointTapscript ||
    info.forfeitPubkey !== pins.checkpointForfeitPub
  )
    throw new Error('Recovery data does not match this release')
}
export function validateLightRecoveryArchive(value: LightRecoveryArchive, descriptor: LightDescriptor) {
  const d = validateLightDescriptor(descriptor)
  if (
    !value ||
    JSON.stringify(value).length > maxArchiveBytes ||
    value.version !== 1 ||
    value.descriptorHash !== lightDescriptorDigest(d) ||
    !Number.isFinite(Date.parse(value.capturedAt))
  )
    throw new Error('Recovery data does not match this wallet')
  const info = unpack(value.info) as ArkInfo
  requireInfo(info, d)
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
    const output = transactions.get(coin.txid)?.getOutput(coin.vout)
    if (!output || output.amount !== BigInt(coin.value) || hex.encode(output.script!) !== d.scriptPubKey)
      throw new Error('Recovery output does not match its transaction')
  }
  return { archive: value, info, coins }
}

function database(d: LightDescriptor): Promise<IDBDatabase> {
  validateLightDescriptor(d)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`vaulted-light:${d.vaultId}:recovery`, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('archive')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function loadLightRecoveryArchive(d: LightDescriptor): Promise<LightRecoveryArchive | null> {
  const db = await database(d)
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('archive').objectStore('archive').get('current')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        try {
          resolve(request.result ? validateLightRecoveryArchive(request.result, d).archive : null)
        } catch (error) {
          reject(error)
        }
      }
    })
  } finally {
    db.close()
  }
}
async function storeArchive(archive: LightRecoveryArchive, d: LightDescriptor) {
  validateLightRecoveryArchive(archive, d)
  const db = await database(d)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('archive', 'readwrite')
      tx.objectStore('archive').put(archive, 'current')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
const activeCaptures = new Map<string, Promise<LightRecoveryArchive>>()
export function captureLightRecoveryArchive(d: LightDescriptor): Promise<LightRecoveryArchive> {
  validateLightDescriptor(d)
  const hash = lightDescriptorDigest(d)
  const active = activeCaptures.get(hash)
  if (active) return active
  const pending = capture(d).finally(() => activeCaptures.delete(hash))
  activeCaptures.set(hash, pending)
  return pending
}
async function capture(d: LightDescriptor): Promise<LightRecoveryArchive> {
  const url = networkPins(d.network).operatorOrigin
  const indexer = new RestIndexerProvider(url)
  const info = await new RestArkProvider(url).getInfo()
  requireInfo(info, d)
  const getCoins = async () => (await indexer.getVtxos({ scripts: [d.scriptPubKey] })).vtxos.filter((v) => !v.isSpent)
  const coins = await getCoins()
  if (coins.length > 512) throw new Error('Recovery output limit exceeded')
  const previous = await loadLightRecoveryArchive(d).catch(() => null)
  const previousCoins = previous ? validateLightRecoveryArchive(previous, d).coins : []
  const removed = previousCoins.filter((old) => !coins.some((coin) => outpoint(coin) === outpoint(old)))
  if (removed.length) {
    const resolved = (await indexer.getVtxos({ outpoints: removed })).vtxos
    if (removed.some((old) => !resolved.some((coin) => outpoint(coin) === outpoint(old) && coin.isSpent)))
      throw new Error('An earlier output is missing. Previous recovery data has been retained.')
  }
  const resolver = createExitChainResolver({ indexer })
  const branches: LightRecoveryArchive['branches'] = {}
  const wanted = new Set<string>()
  for (const coin of coins) {
    // Shared ancestors appear repeatedly in the public indexer's DAG walk.
    const prior = previousCoins.find((old) => outpoint(old) === outpoint(coin) && old.value === coin.value)
    const chain = prior
      ? previous!.branches[outpoint(coin)]
      : normalizeLightRecoveryChain(await resolver.getVtxoChain(coin))
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
  const fingerprint = (values: VirtualCoin[]) =>
    values
      .map((v) => `${outpoint(v)}:${v.value}:${v.script}`)
      .sort()
      .join('|')
  if (fingerprint(coins) !== fingerprint(await getCoins()))
    throw new Error('Your balance changed while saving recovery data')
  const archive: LightRecoveryArchive = {
    version: 1,
    descriptorHash: lightDescriptorDigest(d),
    capturedAt: new Date().toISOString(),
    info: pack(info),
    coins: pack(coins),
    branches,
    transactions,
  }
  await storeArchive(archive, d)
  return archive
}

// Explicit local provider surfaces. Any unexpected SDK call fails without
// attempting network access. Bitcoin queries still use the ordinary Esplora provider.
export function lightArchiveProviders(archive: LightRecoveryArchive, d: LightDescriptor) {
  const { info, coins } = validateLightRecoveryArchive(archive, d)
  const source: ExitDataSource = {
    name: 'vaulted-light-device-archive',
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
    subscribeForScripts: async () => 'saved-light-recovery',
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
