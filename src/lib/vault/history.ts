import { TxType, type Activity, type ArkTransaction } from '@arkade-os/sdk'
import type { EsploraTx, EsploraUtxo } from './esplora'
import { RECENT_HISTORY_LIMIT } from './constants'

export type VaultHistoryKind = 'sent' | 'received'

export interface VaultHistoryItem {
  txid: string
  type: VaultHistoryKind
  amount: number
  confirmed: boolean
  blockTime?: number
  account: 'spend' | 'savings'
  activity?: 'boarding' | 'lightning' | 'savings-handoff' | 'savings-connector' | 'bitcoin'
  bitcoinOperationId?: string
  bitcoinStage?: string
  connectorStage?: 'approval' | 'signer' | 'broadcast'
  displayAmount?: number
  fee?: number
  lightningState?: string
  lightningRfqId?: string
}

export interface VaultHistoryGroup {
  key: string
  label: string
  items: VaultHistoryItem[]
}

export interface VaultActivityScope {
  /** Transaction ids proven by the script-filtered vault-policy-v1 snapshot. */
  vaultTxids: ReadonlySet<string>
  /** RFQ records read from this vault's isolated package repository. */
  lightningRfqIds: ReadonlySet<string>
}

export interface VaultLightningActivityRecord {
  type?: VaultHistoryKind
  rfqId: string
  fundingTxid: string
  state: string
  amount: number
  displayAmount: number
  fee: number
  createdAt: number
  terminal: boolean
}

function sdkTransactionId(transaction: ArkTransaction): string {
  return transaction.key.arkTxid || transaction.key.commitmentTxid || transaction.key.boardingTxid
}

/**
 * Project the SDK's logical activity feed without admitting the persistent
 * wallet's baseline default contract. Boarding stays on the existing explicit
 * reconciliation feed until that lifecycle is replaced deliberately.
 */
export function historyFromSdkActivities(
  activities: readonly Activity[],
  scope: VaultActivityScope,
  lightningRecords: readonly VaultLightningActivityRecord[] = [],
  options: { includeBoarding?: boolean } = {},
): VaultHistoryItem[] {
  const rows: VaultHistoryItem[] = []
  const groupedLightning = new Set<string>()
  const lightningByRfqId = new Map(lightningRecords.map((record) => [record.rfqId, record]))
  for (const activity of activities) {
    const boarding = activity.intent?.kind === 'boarding'
    const bitcoin = activity.intent?.kind === 'exit'
    if (boarding && !options.includeBoarding) continue
    const rfqId = typeof activity.intent?.metadata?.rfqId === 'string' ? activity.intent.metadata.rfqId : undefined
    const lightning =
      ['lightning_send', 'lightning_receive'].includes(String(activity.intent?.metadata?.swapKind)) &&
      Boolean(rfqId && scope.lightningRfqIds.has(rfqId))
    const scopedTransactions = activity.txs.filter((transaction) => scope.vaultTxids.has(sdkTransactionId(transaction)))
    if (!lightning && !boarding && scopedTransactions.length === 0) continue

    const lightningRecord = lightning && rfqId ? lightningByRfqId.get(rfqId) : undefined
    // Incoming swap accounting can net to zero between two registered contracts.
    // The persisted claim provides its direction and recipient amount.
    if (lightning && activity.intent?.metadata?.swapKind === 'lightning_receive' && !lightningRecord) continue
    if (
      !lightning &&
      scopedTransactions.some((tx) =>
        lightningRecords.some((r) => scope.lightningRfqIds.has(r.rfqId) && r.fundingTxid === sdkTransactionId(tx)),
      )
    )
      continue
    const incoming = lightningRecord?.type === 'received'
    const candidates = lightning || boarding ? activity.txs : scopedTransactions
    const sent = incoming ? false : activity.amount < 0
    const anchor =
      candidates.find((transaction) => transaction.type === (sent ? TxType.TxSent : TxType.TxReceived)) || candidates[0]
    if (!anchor) continue
    const txid = bitcoin ? anchor.key.commitmentTxid : sdkTransactionId(anchor)
    if (!txid) continue
    const amount = incoming ? lightningRecord.amount : Math.abs(activity.amount)
    if (!lightning && amount === 0) continue
    const lightningOutcome = incoming
      ? lightningRecord.state
      : activity.intent?.outcome || (activity.settled ? 'settled' : 'pending')
    const lightningFee = lightningRecord
      ? incoming
        ? lightningRecord.fee
        : lightningOutcome === 'refunded'
          ? amount
          : Math.max(lightningRecord.fee, amount - lightningRecord.displayAmount)
      : undefined
    rows.push({
      txid: lightningRecord?.fundingTxid || txid,
      type: sent ? 'sent' : 'received',
      amount,
      // Activity.settled means the batch is on-chain. Arkade VTXO payments are
      // already spendable, so they skip the Pending group. Boarding still
      // waits for settlement. Lightning stays Pending until the RFQ is
      // terminal because the funding tx can settle before pay/refund.
      confirmed: lightningRecord ? lightningRecord.terminal : boarding || bitcoin ? activity.settled : true,
      blockTime: unixSeconds(activity.createdAt),
      account: 'spend',
      ...(bitcoin
        ? { activity: 'bitcoin' as const }
        : boarding
          ? { activity: 'boarding' as const }
          : lightning
            ? {
                activity: 'lightning' as const,
                ...(lightningRecord ? { displayAmount: lightningRecord.displayAmount, fee: lightningFee } : {}),
                lightningState: lightningOutcome,
                lightningRfqId: rfqId,
              }
            : {}),
    })
    if (lightning && rfqId) groupedLightning.add(rfqId)
  }

  // A Lightning funding transaction can net to zero in SDK history because
  // its VHTLC is a wallet-registered contract. Preserve the package record's
  // pending row until a later claim/refund makes the resolver group visible.
  // Both forms use the same funding txid and RFQ id, so the real group replaces
  // this row instead of duplicating it.
  for (const record of lightningRecords) {
    if (!scope.lightningRfqIds.has(record.rfqId) || groupedLightning.has(record.rfqId)) continue
    if (!/^[0-9a-f]{64}$/.test(record.fundingTxid)) continue
    rows.push({
      txid: record.fundingTxid,
      type: record.type ?? 'sent',
      amount: record.amount,
      confirmed: record.terminal,
      blockTime: record.createdAt,
      account: 'spend',
      activity: 'lightning',
      displayAmount: record.displayAmount,
      fee: record.fee,
      lightningState: record.state,
      lightningRfqId: record.rfqId,
    })
  }
  return rows.sort(sortVaultHistory)
}

export function recentAccountHistory(
  items: VaultHistoryItem[],
  account: VaultHistoryItem['account'],
  limit = RECENT_HISTORY_LIMIT,
): VaultHistoryItem[] {
  return items
    .filter((item) => item.account === account)
    .sort(sortVaultHistory)
    .slice(0, Math.max(0, limit))
}

/** Groups history into the states and dates a wallet user needs to scan. */
export function groupVaultHistory(
  items: VaultHistoryItem[],
  nowSeconds = Math.floor(Date.now() / 1000),
): VaultHistoryGroup[] {
  const today = new Date(nowSeconds * 1000)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const groups: VaultHistoryGroup[] = []

  for (const item of [...items].sort(sortVaultHistory)) {
    const group = historyGroup(item, today, yesterday)
    const previous = groups.at(-1)
    if (previous?.key === group.key) previous.items.push(item)
    else groups.push({ ...group, items: [item] })
  }
  return groups
}

function historyGroup(item: VaultHistoryItem, today: Date, yesterday: Date): Pick<VaultHistoryGroup, 'key' | 'label'> {
  if (!item.confirmed) return { key: 'pending', label: 'Pending' }
  if (!item.blockTime) return { key: 'earlier', label: 'Earlier' }
  const date = new Date(item.blockTime * 1000)
  const key = localDateKey(date)
  if (key === localDateKey(today)) return { key, label: 'Today' }
  if (key === localDateKey(yesterday)) return { key, label: 'Yesterday' }
  return {
    key,
    label: new Intl.DateTimeFormat('en', {
      day: 'numeric',
      month: 'long',
      ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    }).format(date),
  }
}

/** Unspent boarding outputs belong to Spending, but are not VTXOs yet. */
export function historyFromBoardingUtxos(utxos: EsploraUtxo[]): VaultHistoryItem[] {
  const unique = new Map<string, EsploraUtxo>()
  for (const utxo of utxos) unique.set(`${utxo.txid}:${utxo.vout}`, utxo)

  const byTransaction = new Map<string, number>()
  for (const utxo of unique.values()) {
    if (!Number.isSafeInteger(utxo.value) || utxo.value <= 0) continue
    byTransaction.set(utxo.txid, (byTransaction.get(utxo.txid) || 0) + utxo.value)
  }

  return [...byTransaction]
    .map(([txid, amount]) => ({
      txid,
      type: 'received' as const,
      amount,
      // Pending describes the Spending lifecycle, even after the Bitcoin
      // transaction confirms. It becomes settled only after VTXO issuance.
      confirmed: false,
      account: 'spend' as const,
      activity: 'boarding' as const,
    }))
    .sort(sortVaultHistory)
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

export function classifyAddressTx(tx: EsploraTx, address: string): Omit<VaultHistoryItem, 'account'> | null {
  if (!address) return null
  const spent = tx.vin.reduce(
    (sum, vin) => sum + (vin.prevout?.scriptpubkey_address === address ? Number(vin.prevout.value || 0) : 0),
    0,
  )
  const received = tx.vout.reduce(
    (sum, out) => sum + (out.scriptpubkey_address === address ? Number(out.value || 0) : 0),
    0,
  )
  if (spent === 0 && received === 0) return null
  const sent = spent > received
  const amount = sent ? spent - received : received - spent
  if (amount <= 0) return null
  return {
    txid: tx.txid,
    type: sent ? 'sent' : 'received',
    amount,
    confirmed: Boolean(tx.status.confirmed),
    blockTime: tx.status.block_time,
  }
}

export function historyFromTxs(txs: EsploraTx[], address: string, account: 'spend' | 'savings'): VaultHistoryItem[] {
  const byTxid = new Map<string, VaultHistoryItem>()
  for (const tx of txs) {
    const item = classifyAddressTx(tx, address)
    if (!item) continue
    const next = { ...item, account }
    const previous = byTxid.get(item.txid)
    if (!previous || (!previous.confirmed && next.confirmed)) byTxid.set(item.txid, next)
  }
  return [...byTxid.values()].sort(sortVaultHistory)
}

/** One row per account/txid/type. Unsettled boarding wins over a confirmed Esplora clone. */
export function mergeVaultHistory(...layers: readonly (readonly VaultHistoryItem[])[]): VaultHistoryItem[] {
  const byKey = new Map<string, VaultHistoryItem>()
  for (const layer of layers) {
    for (const item of layer) {
      const key = `${item.account}:${item.txid}:${item.type}`
      const previous = byKey.get(key)
      if (!previous) {
        byKey.set(key, item)
        continue
      }
      if (item.activity === 'boarding' && !item.confirmed) {
        byKey.set(key, item)
        continue
      }
      if (previous.activity === 'boarding' && !previous.confirmed) continue
      if (previous.confirmed && !item.confirmed) byKey.set(key, item)
    }
  }
  return [...byKey.values()].sort(sortVaultHistory)
}

function unixSeconds(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.floor(ms / 1000)
}

function sortVaultHistory(a: VaultHistoryItem, b: VaultHistoryItem): number {
  if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1
  return (
    (b.blockTime || 0) - (a.blockTime || 0) ||
    a.account.localeCompare(b.account) ||
    a.txid.localeCompare(b.txid) ||
    a.type.localeCompare(b.type) ||
    a.amount - b.amount
  )
}
