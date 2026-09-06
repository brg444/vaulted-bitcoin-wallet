import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { hex } from '@scure/base'
import {
  ArkAddress,
  VHTLCV2ContractHandler,
  type Contract,
  type ContractRepository,
  type VirtualTxRepository,
} from '@arkade-os/sdk'
import {
  rebuildRfqSwap,
  rfqSignerOf,
  isRfqSwapTerminal,
  type AssetSwapRepository,
  type RfqSwapRecord,
} from '@arkade-os/swap'
import { storedLightningProfile } from '../lightningLifecycle'
import { decodeVaultLightningInvoice } from '../lightningInvoice'
import { withVaultLightningLifecycleLock } from '../lightningLock'
import { networkPins } from '../networkPins'
import {
  captureExitArchive,
  validateExitArchive,
  exitArchiveProviders,
  type ExitArchive,
  type ExitArchiveBinding,
} from './exitArchive'

export interface LightningArchiveBinding {
  vaultId: string
  network: string
  phonePub: string
  descriptorHash: string
  spendingScript: string
}
export interface LightningRecoveryEntry {
  record: RfqSwapRecord
  contract: Contract
  exit: ExitArchive
}
/** Plain payload for the caller's authenticated encryption, never a public kit. */
export interface LightningRecoveryJournal {
  name: 'vaulted-lightning-recovery'
  version: 1
  binding: LightningArchiveBinding
  entries: LightningRecoveryEntry[]
}
const MAX_ENTRIES = 256
const MAX_JOURNAL_BYTES = 12_000_000
const encoder = new TextEncoder()
const isHex32 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  )
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
function requireBinding(binding: LightningArchiveBinding) {
  if (
    !binding ||
    typeof binding.vaultId !== 'string' ||
    !binding.vaultId ||
    binding.vaultId.length > 128 ||
    !['mainnet', 'mutinynet'].includes(binding.network) ||
    !isHex32(binding.descriptorHash) ||
    !/^5120[0-9a-f]{64}$/.test(binding.spendingScript) ||
    !/^(02|03)[0-9a-f]{64}$/.test(binding.phonePub)
  )
    throw new Error('Invalid Lightning archive enrollment')
  return networkPins(binding.network)
}
function contractIdentity(contract: Contract) {
  return canonical({ type: contract.type, params: contract.params, script: contract.script, address: contract.address })
}
function recordIdentity(record: RfqSwapRecord) {
  const profile = storedLightningProfile(record)
  return canonical({
    rfqId: record.rfqId,
    kind: record.kind,
    lockupAddress: record.lockupAddress,
    amount: record.amount,
    signer: rfqSignerOf(record),
    hashlock: record.profile.hashlock,
    quote: profile.quote,
    invoice: profile.invoice,
    network: profile.network,
    version: profile.version,
  })
}
function validateRecord(record: RfqSwapRecord, contract: Contract, binding: LightningArchiveBinding) {
  const pins = requireBinding(binding)
  if (
    !record ||
    !isHex32(record.rfqId) ||
    !['pending', 'needs_counterparty', 'settled', 'refunded', 'failed'].includes(record.state) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0 ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < record.createdAt ||
    encoder.encode(JSON.stringify(record)).length > 96 * 1024
  )
    throw new Error('Invalid Lightning recovery record')
  for (const txid of [record.fundingArkTxid, record.refundArkTxid, ...(record.lockupSpendArkTxids ?? [])])
    if (txid !== undefined && !isHex32(txid)) throw new Error('Invalid Lightning transaction reference')
  const profile = storedLightningProfile(record)
  const invoice = decodeVaultLightningInvoice(profile.invoice, profile.network, 0)
  if (
    profile.network !== pins.sdkNetwork ||
    rfqSignerOf(record)?.signingDescriptor !== `tr(${binding.phonePub.slice(2)})`
  )
    throw new Error('Lightning refund signer belongs to another wallet')
  if (
    !contract ||
    contract.type !== 'vhtlc-v2' ||
    !['active', 'inactive'].includes(contract.state) ||
    !Number.isSafeInteger(contract.createdAt) ||
    contract.createdAt < 0 ||
    (contract.watch !== undefined && !['watched', 'awaiting-funds', 'retained'].includes(contract.watch)) ||
    contract.metadata?.genericallySpendable !== false ||
    encoder.encode(JSON.stringify(contract)).length > 32 * 1024
  )
    throw new Error('Invalid Lightning recovery contract')
  const script = VHTLCV2ContractHandler.createScript(contract.params)
  const address = ArkAddress.decode(record.lockupAddress)
  if (
    canonical(VHTLCV2ContractHandler.serializeParams(script.options)) !== canonical(contract.params) ||
    contract.address !== record.lockupAddress ||
    hex.encode(script.pkScript) !== contract.script ||
    hex.encode(address.pkScript) !== contract.script ||
    address.hrp !== pins.arkHrp ||
    hex.encode(address.serverPubKey) !== pins.operatorSignerPub.slice(2) ||
    hex.encode(script.options.server) !== pins.operatorSignerPub.slice(2) ||
    hex.encode(script.options.sender) !== binding.phonePub.slice(2) ||
    hex.encode(script.options.receiver) !== profile.quote.solver_pubkey ||
    hex.encode(script.options.preimageHash) !== hex.encode(ripemd160(hex.decode(invoice.paymentHash))) ||
    profile.quote.profile?.lockup_address !== contract.address ||
    profile.quote.profile?.receiver_pk_script !==
      hex.encode(script.options.nonInteractiveClaim?.receiverPkScript ?? new Uint8Array()) ||
    !script.options.nonInteractiveRefund ||
    hex.encode(script.options.nonInteractiveRefund.senderPkScript) !== binding.spendingScript ||
    script.options.refundLocktime !== BigInt(profile.quote.refund_locktime!)
  )
    throw new Error('Lightning contract does not match its funded quote')
  if (
    profile.fundingProof &&
    (!/^[0-9a-f-]{16,}$/i.test(profile.fundingProof.operationId) ||
      !isHex32(profile.fundingProof.bundleDigest) ||
      (profile.fundingProof.fundingFeeSats !== undefined &&
        (!Number.isSafeInteger(profile.fundingProof.fundingFeeSats) || profile.fundingProof.fundingFeeSats < 0)))
  )
    throw new Error('Invalid Lightning funding proof')
  const rebuilt = rebuildRfqSwap(record, contract.params)
  if (rebuilt.kind !== 'lightning_send' || rebuilt.paymentHash !== invoice.paymentHash)
    throw new Error('Lightning hashlock changed')
  if (
    profile.fundingProof &&
    (profile.fundingProof.rfqId !== record.rfqId ||
      profile.fundingProof.address !== record.lockupAddress ||
      profile.fundingProof.amountSats !== record.amount)
  )
    throw new Error('Lightning funding proof changed')
  return script
}
export function lightningExitBinding(
  entry: Pick<LightningRecoveryEntry, 'record' | 'contract'>,
  binding: LightningArchiveBinding,
): ExitArchiveBinding {
  validateRecord(entry.record, entry.contract, binding)
  return {
    network: binding.network,
    scriptPubKey: entry.contract.script,
    descriptorHash: hex.encode(
      sha256(
        encoder.encode(
          canonical({
            name: 'vaulted-lightning-recovery',
            version: 1,
            binding,
            rfqId: entry.record.rfqId,
            contract: contractIdentity(entry.contract),
            signer: rfqSignerOf(entry.record),
          }),
        ),
      ),
    ),
  }
}
export function validateLightningRecoveryJournal(journal: LightningRecoveryJournal, binding: LightningArchiveBinding) {
  requireBinding(binding)
  if (
    !journal ||
    journal.name !== 'vaulted-lightning-recovery' ||
    journal.version !== 1 ||
    canonical(journal.binding) !== canonical(binding) ||
    !Array.isArray(journal.entries) ||
    journal.entries.length > MAX_ENTRIES ||
    encoder.encode(JSON.stringify(journal)).length > MAX_JOURNAL_BYTES
  )
    throw new Error('Invalid Lightning recovery journal')
  const ids = new Set<string>(),
    scripts = new Set<string>()
  for (const entry of journal.entries) {
    const exitBinding = lightningExitBinding(entry, binding)
    if (ids.has(entry.record.rfqId) || scripts.has(entry.contract.script))
      throw new Error('Duplicate Lightning recovery entry')
    ids.add(entry.record.rfqId)
    scripts.add(entry.contract.script)
    validateExitArchive(entry.exit, exitBinding)
  }
  return journal
}
function fundingEvidence(record: RfqSwapRecord) {
  const profile = storedLightningProfile(record)
  return Boolean(record.fundingArkTxid || profile.fundingState === 'funding' || profile.fundingProof)
}
/** Never downgrade known funding, nor overwrite a locally resolved/newer record. */
function retainedRecord(local: RfqSwapRecord, incoming: RfqSwapRecord): RfqSwapRecord {
  if (recordIdentity(local) !== recordIdentity(incoming)) throw new Error('Conflicting Lightning recovery record')
  const a = storedLightningProfile(local).fundingProof,
    b = storedLightningProfile(incoming).fundingProof
  if (
    (a && b && canonical(a) !== canonical(b)) ||
    (local.fundingArkTxid && incoming.fundingArkTxid && local.fundingArkTxid !== incoming.fundingArkTxid)
  )
    throw new Error('Conflicting Lightning funding evidence')
  if (isRfqSwapTerminal(local.state)) return local
  if (local.updatedAt >= incoming.updatedAt) {
    if (!fundingEvidence(local) && fundingEvidence(incoming))
      throw new Error('Newer local Lightning record is missing saved funding evidence')
    return local
  }
  if (fundingEvidence(local) && !fundingEvidence(incoming)) return local
  // A later record can add a resolution without repeating every funding field.
  // Keep the exact original proof/txid as evidence; never synthesize either.
  if ((a && !b) || (local.fundingArkTxid && !incoming.fundingArkTxid)) {
    const retained = copy(incoming)
    if (local.fundingArkTxid) retained.fundingArkTxid = local.fundingArkTxid
    if (a && !b) {
      const profile = retained.profile.vaultLightning as Record<string, unknown>
      profile.fundingProof = copy(a)
      profile.fundingState = 'funding'
    }
    return retained
  }
  return incoming
}

type SwapReader = Pick<AssetSwapRepository, 'getAllRfqSwaps'>
type ContractReader = Pick<ContractRepository, 'getContracts'>
export async function captureLightningRecoveryJournal(input: {
  binding: LightningArchiveBinding
  swaps: SwapReader
  contracts: ContractReader
  virtualTxRepository: VirtualTxRepository
  previous?: LightningRecoveryJournal | null
}): Promise<LightningRecoveryJournal> {
  return withVaultLightningLifecycleLock(input.binding.vaultId, async () => {
    const binding = copy(input.binding)
    requireBinding(binding)
    const previous = input.previous ? copy(validateLightningRecoveryJournal(input.previous, binding)) : null
    const entries = new Map(previous?.entries.map((entry) => [entry.record.rfqId, entry]))
    const records = await input.swaps.getAllRfqSwaps()
    if (records.length > MAX_ENTRIES) throw new Error('Lightning recovery journal limit exceeded')
    const seen = new Set<string>()
    for (const current of records) {
      if (seen.has(current.rfqId)) throw new Error('Duplicate local Lightning record')
      seen.add(current.rfqId)
      const old = entries.get(current.rfqId)
      const scriptHex = hex.encode(ArkAddress.decode(current.lockupAddress).pkScript)
      const contracts = await input.contracts.getContracts({ script: scriptHex })
      if (contracts.length !== 1) throw new Error('Lightning contract is missing or ambiguous')
      const contract = copy(contracts[0])
      validateRecord(current, contract, binding)
      if (old && contractIdentity(old.contract) !== contractIdentity(contract))
        throw new Error('Conflicting Lightning recovery contract')
      const record = copy(old ? retainedRecord(current, old.record) : current)
      const partial = { record, contract }
      // captureExitArchive refuses missing earlier outputs without positive spend
      // evidence. Any incomplete fetch rejects the capture; previous stays intact.
      const exit = await captureExitArchive(
        lightningExitBinding(partial, binding),
        input.virtualTxRepository,
        old?.exit ?? null,
      )
      entries.set(record.rfqId, { ...partial, exit })
      if (entries.size > MAX_ENTRIES) throw new Error('Lightning recovery journal limit exceeded')
    }
    return validateLightningRecoveryJournal(
      {
        name: 'vaulted-lightning-recovery',
        version: 1,
        binding,
        entries: [...entries.values()].sort((a, b) => a.record.rfqId.localeCompare(b.record.rfqId)),
      },
      binding,
    )
  })
}

/** Caller has independently verified the enrollment binding before this import. */
export async function restoreLightningRecoveryJournal(
  journal: LightningRecoveryJournal,
  binding: LightningArchiveBinding,
  stores: {
    swaps: Pick<AssetSwapRepository, 'getAllRfqSwaps' | 'getRfqSwap' | 'saveRfqSwap'>
    contracts: Pick<ContractRepository, 'getContracts' | 'saveContract'>
  },
) {
  const valid = copy(validateLightningRecoveryJournal(journal, binding))
  return withVaultLightningLifecycleLock(binding.vaultId, async () => {
    const localRecords = await stores.swaps.getAllRfqSwaps()
    const writes: { entry: LightningRecoveryEntry; contractMissing: boolean; record?: RfqSwapRecord }[] = []
    // Validate all conflicts before the first mutation. There is no cross-store
    // transaction: a crash may leave an orphan contract, making retry idempotent.
    for (const entry of valid.entries) {
      if (
        localRecords.some(
          (record) => record.rfqId !== entry.record.rfqId && record.lockupAddress === entry.record.lockupAddress,
        )
      )
        throw new Error('Conflicting local Lightning lockup owner')
      const contracts = await stores.contracts.getContracts({ script: entry.contract.script })
      if (contracts.length > 1 || (contracts[0] && contractIdentity(contracts[0]) !== contractIdentity(entry.contract)))
        throw new Error('Conflicting local Lightning contract')
      if (contracts[0]) validateRecord(entry.record, contracts[0], binding)
      const local = await stores.swaps.getRfqSwap(entry.record.rfqId)
      if (local) validateRecord(local, contracts[0] ?? entry.contract, binding)
      const record = local ? retainedRecord(local, entry.record) : entry.record
      const observed = validateExitArchive(entry.exit, lightningExitBinding(entry, binding)).coins.length > 0
      if (observed && !fundingEvidence(record) && !isRfqSwapTerminal(record.state))
        throw new Error('Funded Lightning output has no funding journal; use its saved onchain recovery data')
      writes.push({ entry, contractMissing: !contracts.length, ...(record !== local ? { record } : {}) })
    }
    let restored = 0
    for (const write of writes) {
      if (write.contractMissing) await stores.contracts.saveContract(copy(write.entry.contract))
      if (write.record) {
        await stores.swaps.saveRfqSwap(copy(write.record))
        restored++
      }
    }
    return { restored, retained: valid.entries.length - restored }
  })
}

/** Exact vhtlc-v2 config and local graph providers for SDK sender-only exits. */
export function lightningArchiveProviders(entry: LightningRecoveryEntry, binding: LightningArchiveBinding) {
  const exitBinding = lightningExitBinding(entry, binding)
  return {
    ...exitArchiveProviders(entry.exit, exitBinding),
    contract: copy(entry.contract),
    signingDescriptor: rfqSignerOf(entry.record)!.signingDescriptor,
    binding: exitBinding,
  }
}
