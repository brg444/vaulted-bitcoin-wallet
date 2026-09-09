import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { EsploraProvider, Transaction } from '@arkade-os/sdk'
import { isLedgerRecoveryKit, parseRecoveryKit, type RecoveryKit } from '../program/kit'
import { kitFromFacts } from '../program/kitBackup'
import {
  packExitArchive,
  captureExitArchive,
  validateExitArchive,
  exitArchiveProviders,
  type ExitArchive,
} from '../recovery/exitArchive'
import type { VaultStatus } from '../types'
import { requireBoardingStatus } from './board'
import { vaultPolicyV1ScriptFromStatus } from './spend'
import { vaultExitRepository } from './exitRepository'
import { vaultWalletDatabase } from './walletWorkerNames'
import { networkPins } from '../networkPins'
import { readBounded } from '../bounded'
import { isConnectorTemplate } from '../program/connector'
import { connectorPinFromVerifiedStatus } from '../program/connectorEnroll'
import { hashBoardingEnrollmentDescriptor } from '../program/enroll'

export interface VaultRecoveryArchive {
  name: 'vaulted-program-recovery-data'
  version: 1
  kit: RecoveryKit
  status: VaultStatus
  spending: ExitArchive
  onchain: { txid: string; vout: number; value: number; script: string; parentHex: string }[]
}

export function vaultRecoveryBinding(kit: RecoveryKit, status: VaultStatus) {
  const valid = parseRecoveryKit(kit)
  const rebuilt = kitFromFacts({ status })
  if (!rebuilt || rebuilt.descriptorHash !== valid.descriptorHash || status.vaultId !== valid.descriptor.vaultId)
    throw new Error('Recovery status does not match the saved vault descriptor')
  const script = vaultPolicyV1ScriptFromStatus(status)
  if (hex.encode(script.params.arkdServerPub) !== networkPins(status.network).operatorSignerPub.slice(2))
    throw new Error('Recovery Operator does not match this release')
  const boarding = requireBoardingStatus(status, String(status.vtxoBoardingDescriptor?.boardingPub || ''))
  if (isConnectorTemplate(status.templateVersion)) connectorPinFromVerifiedStatus(status)
  else if (isLedgerRecoveryKit(valid)) {
    if (valid.descriptor.enrollmentDescriptorHash !== status.ledgerSavings?.descriptorHash)
      throw new Error('Ledger recovery enrollment composite changed')
  } else if (
    hashBoardingEnrollmentDescriptor({
      schema: 'arkade-vault/enrollment-with-board-v1',
      vaultId: status.vaultId,
      savings: valid.descriptor,
      boarding,
    }) !== status.vtxoBoardingDescriptorHash
  )
    throw new Error('Recovery enrollment composite changed')
  const descriptorHash = hex.encode(
    sha256(
      new TextEncoder().encode(
        JSON.stringify({
          name: 'vaulted-program-recovery-data',
          version: 1,
          kitHash: valid.descriptorHash,
          spendingScript: hex.encode(script.pkScript),
          boarding,
        }),
      ),
    ),
  )
  return { descriptorHash, scriptPubKey: hex.encode(script.pkScript), network: valid.descriptor.network }
}

export function validateVaultRecoveryArchive(value: VaultRecoveryArchive) {
  if (!value || value.name !== 'vaulted-program-recovery-data' || value.version !== 1)
    throw new Error('Invalid program recovery data')
  const binding = vaultRecoveryBinding(value.kit, value.status)
  validateExitArchive(value.spending, binding)
  if (!Array.isArray(value.onchain) || value.onchain.length > 1024 || JSON.stringify(value).length > 24_000_000)
    throw new Error('Onchain recovery data exceeds the archive limit')
  const scripts = new Set(archiveAddresses(value.kit, value.status).map((tree) => tree.script))
  const seen = new Set<string>()
  for (const coin of value.onchain) {
    const outpoint = `${coin.txid}:${coin.vout}`
    if (
      !/^[0-9a-f]{64}$/.test(coin.txid) ||
      !Number.isSafeInteger(coin.vout) ||
      coin.vout < 0 ||
      !Number.isSafeInteger(coin.value) ||
      coin.value <= 0 ||
      !scripts.has(coin.script) ||
      seen.has(outpoint) ||
      typeof coin.parentHex !== 'string' ||
      coin.parentHex.length > 8_000_000
    )
      throw new Error('Invalid onchain recovery output')
    seen.add(outpoint)
    const parent = Transaction.fromRaw(hex.decode(coin.parentHex), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    })
    const output = parent.getOutput(coin.vout)
    if (parent.id !== coin.txid || output.amount !== BigInt(coin.value) || hex.encode(output.script!) !== coin.script)
      throw new Error('Onchain recovery parent changed')
  }
  return value
}

function archiveAddresses(kit: RecoveryKit, status: VaultStatus) {
  return [
    kit.descriptor.savings,
    ...(isLedgerRecoveryKit(kit) ? [kit.descriptor.savingsChange] : []),
    ...Object.values(kit.descriptor.pending),
    ...Object.values(kit.descriptor.quarantine),
    requireBoardingStatus(status, status.vtxoBoardingDescriptor!.boardingPub),
  ]
}

async function captureOnchain(kit: RecoveryKit, status: VaultStatus, previous: VaultRecoveryArchive | null) {
  const base = networkPins(status.network).esploraApiUrl
  const provider = new EsploraProvider(base)
  // Retain earlier outputs as evidence; a missing indexer entry is not proof of a spend.
  const retained = new Map((previous?.onchain ?? []).map((coin) => [`${coin.txid}:${coin.vout}`, coin]))
  for (const tree of archiveAddresses(kit, status)) {
    for (const coin of await provider.getCoins(tree.address)) {
      const key = `${coin.txid}:${coin.vout}`
      if (retained.has(key)) continue
      if (!/^[0-9a-f]{64}$/.test(coin.txid)) throw new Error('Invalid onchain output reference')
      const response = await fetch(`${base}/tx/${coin.txid}/hex`, { cache: 'no-store', redirect: 'error' })
      if (!response.ok) throw new Error('Onchain recovery parent is unavailable')
      const parentHex = (await readBounded(response, 8_000_000)).trim()
      retained.set(key, { txid: coin.txid, vout: coin.vout, value: coin.value, script: tree.script, parentHex })
      if (retained.size > 1024) throw new Error('Onchain recovery output limit exceeded')
    }
  }
  return [...retained.values()]
}

export function vaultArchiveProviders(value: VaultRecoveryArchive) {
  const valid = validateVaultRecoveryArchive(value)
  return exitArchiveProviders(valid.spending, vaultRecoveryBinding(valid.kit, valid.status))
}

async function archiveDatabase(vaultId: string, network: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`${vaultWalletDatabase(vaultId)}:${network}:recovery-archive`, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('archive')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadVaultRecoveryArchive(kit: RecoveryKit, status: VaultStatus) {
  const binding = vaultRecoveryBinding(kit, status)
  const db = await archiveDatabase(status.vaultId, binding.network)
  try {
    return await new Promise<VaultRecoveryArchive | null>((resolve, reject) => {
      const request = db.transaction('archive').objectStore('archive').get('current')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        try {
          if (!request.result) return resolve(null)
          const valid = validateVaultRecoveryArchive(request.result)
          if (valid.spending.descriptorHash !== binding.descriptorHash)
            throw new Error('Saved recovery identity changed')
          resolve(valid)
        } catch (error) {
          reject(error)
        }
      }
    })
  } finally {
    db.close()
  }
}

/** Failed or incomplete capture leaves the last complete snapshot untouched. */
export async function captureVaultRecoveryArchive(kit: RecoveryKit, status: VaultStatus) {
  const savedKit = parseRecoveryKit(kit)
  const savedStatus = JSON.parse(JSON.stringify(status)) as VaultStatus
  const binding = vaultRecoveryBinding(savedKit, savedStatus)
  const run = async () => {
    const previous = await loadVaultRecoveryArchive(savedKit, savedStatus)
    const repository = vaultExitRepository(savedStatus.vaultId, binding.network)
    try {
      const spending = await captureExitArchive(binding, repository, previous?.spending ?? null)
      const onchain = await captureOnchain(savedKit, savedStatus, previous)
      const archive = validateVaultRecoveryArchive({
        name: 'vaulted-program-recovery-data',
        version: 1,
        kit: savedKit,
        status: savedStatus,
        spending,
        onchain,
      })
      const db = await archiveDatabase(savedStatus.vaultId, binding.network)
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
      return archive
    } finally {
      await repository[Symbol.asyncDispose]()
    }
  }
  if (!navigator.locks) throw new Error('Web Locks required to capture recovery data')
  return navigator.locks.request(`vaulted:archive:${binding.descriptorHash}`, run)
}

/** Import complete evidence before the next refresh; older files cannot erase local paths. */
export async function storeVaultRecoveryArchive(value: VaultRecoveryArchive) {
  const incoming = validateVaultRecoveryArchive(value)
  const binding = vaultRecoveryBinding(incoming.kit, incoming.status)
  if (!navigator.locks) throw new Error('Web Locks required to restore recovery data')
  return navigator.locks.request(`vaulted:archive:${binding.descriptorHash}`, async () => {
    const previous = await loadVaultRecoveryArchive(incoming.kit, incoming.status)
    let archive = incoming
    if (previous) {
      const left = validateExitArchive(previous.spending, binding)
      const right = validateExitArchive(incoming.spending, binding)
      const transactions = { ...incoming.spending.transactions, ...previous.spending.transactions }
      for (const [id, raw] of Object.entries(incoming.spending.transactions))
        if (previous.spending.transactions[id] && previous.spending.transactions[id] !== raw)
          throw new Error('Conflicting saved recovery transaction evidence')
      const coins = [
        ...new Map([...right.coins, ...left.coins].map((coin) => [`${coin.txid}:${coin.vout}`, coin])).values(),
      ]
      const onchain = [
        ...new Map(
          [...incoming.onchain, ...previous.onchain].map((coin) => [`${coin.txid}:${coin.vout}`, coin]),
        ).values(),
      ]
      archive = validateVaultRecoveryArchive({
        ...previous,
        onchain,
        spending: {
          ...previous.spending,
          coins: packExitArchive(coins),
          branches: { ...incoming.spending.branches, ...previous.spending.branches },
          transactions,
        },
      })
    }
    const db = await archiveDatabase(archive.status.vaultId, binding.network)
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
    return archive
  })
}
