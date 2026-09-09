import { Transaction } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import type { BoardingFinalRequest } from '../cosignerClient'
import type { BoardingDescriptor } from '../types'
import { recoveryFileStore } from '../recovery/fileStore'

/** Exact pre-dispatch evidence, never an instruction to sign or broadcast. */
export interface BoardingTranscript {
  requestHash: string
  request: BoardingFinalRequest
}

const LIMIT = 24_000_000
const fingerprint = (request: BoardingFinalRequest) =>
  hex.encode(sha256(new TextEncoder().encode(JSON.stringify(request))))

export function validateBoardingTranscripts(records: BoardingTranscript[], descriptor: BoardingDescriptor) {
  if (!Array.isArray(records) || records.length > 1024 || JSON.stringify(records).length > LIMIT)
    throw new Error('Boarding recovery evidence exceeds its storage limit')
  const seen = new Set<string>()
  for (const record of records) {
    if (
      !record?.request ||
      typeof record.requestHash !== 'string' ||
      record.requestHash !== fingerprint(record.request) ||
      seen.has(record.requestHash)
    )
      throw new Error('Boarding recovery evidence changed')
    seen.add(record.requestHash)
    const { request } = record
    const batch = request.validatedBatch
    if (
      typeof request.handle !== 'string' ||
      !request.handle ||
      typeof request.psbt !== 'string' ||
      !Array.isArray(request.signedForfeits) ||
      request.signedForfeits.length ||
      !Array.isArray(request.inputIndexes) ||
      request.inputIndexes.length !== 1 ||
      !batch ||
      typeof batch.batchId !== 'string' ||
      !batch.batchId ||
      !Number.isSafeInteger(batch.batchExpiry) ||
      batch.batchExpiry <= 0 ||
      batch.batchExpiry > 0xffffffff ||
      typeof batch.unsignedCommitmentTx !== 'string' ||
      !Array.isArray(batch.vtxoTree) ||
      batch.vtxoTree.length === 0 ||
      !Array.isArray(batch.expectedRecipients) ||
      batch.expectedRecipients.length !== 1 ||
      !batch.expectedRecipients[0] ||
      typeof batch.expectedRecipients[0].address !== 'string' ||
      !batch.expectedRecipients[0].address ||
      !Number.isSafeInteger(batch.expectedRecipients[0].amountSats) ||
      batch.expectedRecipients[0].amountSats <= 0
    )
      throw new Error('Invalid boarding recovery request')
    const tx = Transaction.fromPSBT(base64.decode(request.psbt), { allowUnknown: true })
    const unsigned = Transaction.fromPSBT(base64.decode(request.validatedBatch.unsignedCommitmentTx), {
      allowUnknown: true,
    })
    const index = request.inputIndexes[0]
    if (!Number.isSafeInteger(index) || index < 0 || index >= tx.inputsLength || tx.id !== unsigned.id)
      throw new Error('Boarding recovery commitment changed')
    const script = tx.getInput(index).witnessUtxo?.script
    if (!script || hex.encode(script) !== descriptor.script)
      throw new Error('Boarding recovery belongs to a different deposit script')
    // Structural evidence checks only. Guardian independently validates and
    // authorizes the complete transaction graph before releasing its signature.
    const nodeIds = new Set<string>()
    for (const node of batch.vtxoTree) {
      if (
        !node ||
        typeof node.txid !== 'string' ||
        !/^[0-9a-f]{64}$/.test(node.txid) ||
        nodeIds.has(node.txid) ||
        typeof node.tx !== 'string' ||
        !node.children ||
        typeof node.children !== 'object' ||
        Array.isArray(node.children) ||
        Object.entries(node.children).some(
          ([index, child]) =>
            !/^(0|[1-9][0-9]*)$/.test(index) ||
            !Number.isSafeInteger(Number(index)) ||
            typeof child !== 'string' ||
            !/^[0-9a-f]{64}$/.test(child),
        )
      )
        throw new Error('Invalid boarding recovery tree')
      nodeIds.add(node.txid)
      const treeTx = Transaction.fromPSBT(base64.decode(node.tx), { allowUnknown: true })
      if (treeTx.id !== node.txid || treeTx.inputsLength !== 1 || treeTx.getInput(0).tapKeySig?.length !== 64)
        throw new Error('Boarding recovery tree is not signed')
    }
    if (batch.vtxoTree.some((node) => Object.values(node.children).some((child) => !nodeIds.has(child))))
      throw new Error('Boarding recovery tree is incomplete')
  }
  return records
}

function storageKey(vaultId: string, descriptor: BoardingDescriptor) {
  return `boarding-transcripts:${vaultId}:${descriptor.network}:${descriptor.script}`
}

export async function loadBoardingTranscripts(vaultId: string, descriptor: BoardingDescriptor) {
  return validateBoardingTranscripts(
    (await recoveryFileStore<BoardingTranscript[]>(storageKey(vaultId, descriptor))) ?? [],
    descriptor,
  )
}

export function mergeBoardingTranscripts(descriptor: BoardingDescriptor, ...groups: BoardingTranscript[][]) {
  const records = new Map<string, BoardingTranscript>()
  for (const group of groups)
    for (const record of validateBoardingTranscripts(group, descriptor)) records.set(record.requestHash, record)
  return validateBoardingTranscripts([...records.values()], descriptor)
}

export async function storeBoardingTranscripts(
  vaultId: string,
  descriptor: BoardingDescriptor,
  records: BoardingTranscript[],
) {
  if (!navigator.locks) throw new Error('Web Locks required to preserve boarding recovery evidence')
  const key = storageKey(vaultId, descriptor)
  return navigator.locks.request(key, async () => {
    const next = mergeBoardingTranscripts(descriptor, await loadBoardingTranscripts(vaultId, descriptor), records)
    await recoveryFileStore(key, next)
    return next
  })
}

export async function persistBoardingTranscript(
  vaultId: string,
  descriptor: BoardingDescriptor,
  request: BoardingFinalRequest,
) {
  const serialized = JSON.stringify(request)
  if (serialized.length > LIMIT) throw new Error('Boarding recovery evidence exceeds its storage limit')
  const exact = JSON.parse(serialized) as BoardingFinalRequest
  await storeBoardingTranscripts(vaultId, descriptor, [{ requestHash: fingerprint(exact), request: exact }])
}
