import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { createBoardingProgramScript, getNetwork } from '@arkade-os/sdk'
import { requireSupportedVaultNetwork, type VaultNetwork } from '../constants'
import { bytesToHex, encodeUtf8, hexToBytes, requireLowerHex } from '../hex'
import { networkPins } from '../networkPins'
import type { BoardingDescriptor, VaultStatus } from '../types'
import { vaultWalletNamespace } from './walletWorkerNames'

export const BOARDING_PROGRAM = 'vault-board-v1' as const
export const BOARDING_SCHEMA = 'arkade-vault/board-v1' as const
export const BOARDING_TEMPLATE = 'vault-board-v1-boarding-vault-and-operator' as const
export const BOARDING_EXIT_DELAY = networkPins('mutinynet').boardExitDelay
export const BOARDING_EXIT_DELAY_UNIT = 'seconds' as const
export const MUTINYNET_OPERATOR_SIGNER_PUB = networkPins('mutinynet').operatorSignerPub

export function boardingWorkerPins(activeNetwork: string, statusNetwork: string) {
  const active = requireSupportedVaultNetwork(activeNetwork)
  if (active !== requireSupportedVaultNetwork(statusNetwork)) {
    throw new Error('active vault-board-v1 key is bound to a different network')
  }
  return networkPins(active)
}

const BOARDING_KEY_DOMAIN = 'vault-board-v1/boarding-key'
const BOARDING_KEY_SALT = sha256(encodeUtf8('arkade-vault/vault-board-v1/boarding-key/hkdf-sha256-v1'))
const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const KEY_DATABASE_PREFIX = 'arkade-vault-board-v1-key'
const KEY_STORE = 'key'
const KEY_DB_VERSION = 1

export function boardingProgramDigestFor(network: VaultNetwork): string {
  const pins = networkPins(network)
  return bytesToHex(
    sha256(
      encodeUtf8(
        JSON.stringify({
          schema: BOARDING_SCHEMA,
          program: BOARDING_PROGRAM,
          template: BOARDING_TEMPLATE,
          exitDelay: pins.boardExitDelay,
          exitDelayUnit: BOARDING_EXIT_DELAY_UNIT,
        }),
      ),
    ),
  )
}

export const BOARDING_PROGRAM_DIGEST = boardingProgramDigestFor('mutinynet')

export interface BoardingKeyRecord {
  state: 'staged' | 'active'
  vaultId: string
  network: VaultNetwork
  programDigest: string
  descriptorHash: string
  boardingPub: string
  secret: Uint8Array
}

function appendLengthPrefixed(parts: Uint8Array[], value: string) {
  const bytes = encodeUtf8(value)
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, bytes.length, false)
  parts.push(length, bytes)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function scalarFromBigInt(value: bigint): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(32))
  let remaining = value
  for (let index = out.length - 1; index >= 0; index--) {
    out[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return out
}

function webCryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

/** Derive the deterministic, even-Y vault-wide worker key without retaining the phone scalar. */
export async function deriveBoardingKey(
  phoneSecret: Uint8Array,
  vaultId: string,
  network: string,
): Promise<{ secret: Uint8Array; boardingPub: string }> {
  const id = String(vaultId || '').trim()
  if (!id) throw new Error('vault id required for vault-board-v1 key')
  const pins = networkPins(network)
  const programDigest = boardingProgramDigestFor(pins.network)
  if (phoneSecret.length !== 32 || !secp256k1.utils.isValidSecretKey(phoneSecret)) {
    throw new Error('recovered phone key is invalid')
  }
  const key = await crypto.subtle.importKey('raw', webCryptoBuffer(phoneSecret), 'HKDF', false, ['deriveBits'])
  for (let counter = 0; counter <= 255; counter++) {
    const parts: Uint8Array[] = []
    appendLengthPrefixed(parts, BOARDING_KEY_DOMAIN)
    appendLengthPrefixed(parts, id)
    appendLengthPrefixed(parts, network)
    appendLengthPrefixed(parts, programDigest)
    const suffix = new Uint8Array(4)
    new DataView(suffix.buffer).setUint32(0, counter, false)
    parts.push(suffix)
    const info = concat(parts)
    let candidate = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: webCryptoBuffer(BOARDING_KEY_SALT),
          info: webCryptoBuffer(info),
        },
        key,
        256,
      ),
    )
    info.fill(0)
    if (!secp256k1.utils.isValidSecretKey(candidate)) {
      candidate.fill(0)
      continue
    }
    let pub = secp256k1.getPublicKey(candidate, true)
    if (pub[0] === 3) {
      const odd = candidate
      candidate = scalarFromBigInt(SECP256K1_ORDER - BigInt(`0x${hex.encode(odd)}`))
      odd.fill(0)
      pub = secp256k1.getPublicKey(candidate, true)
    }
    if (pub[0] !== 2) {
      candidate.fill(0)
      throw new Error('vault-board-v1 key did not normalize to even Y')
    }
    return { secret: candidate, boardingPub: hex.encode(pub) }
  }
  throw new Error('vault-board-v1 key derivation failed')
}

function requireCompressedKey(value: string, name: string): string {
  const key = requireLowerHex(value, name, 33)
  const bytes = hexToBytes(key)
  if ((bytes[0] !== 2 && bytes[0] !== 3) || !secp256k1.utils.isValidPublicKey(bytes, true)) {
    throw new Error(`${name} is not a compressed secp256k1 key`)
  }
  return key
}

export function requireBoardingDescriptor(
  raw: unknown,
  expected: { vaultId: string; phonePub: string; boardingPub: string; network: string },
): BoardingDescriptor {
  if (!raw || typeof raw !== 'object') throw new Error('vault-board-v1 descriptor required')
  const pins = networkPins(expected.network)
  const descriptor = raw as BoardingDescriptor
  if (
    descriptor.schema !== BOARDING_SCHEMA ||
    descriptor.program !== BOARDING_PROGRAM ||
    descriptor.template !== BOARDING_TEMPLATE ||
    descriptor.network !== expected.network ||
    descriptor.exitDelay !== pins.boardExitDelay ||
    descriptor.exitDelayUnit !== BOARDING_EXIT_DELAY_UNIT
  ) {
    throw new Error('vault-board-v1 descriptor does not match this release')
  }
  const boardingPub = requireCompressedKey(descriptor.boardingPub, 'boardingPub')
  const recoveryPub = requireCompressedKey(descriptor.recoveryPhonePub, 'recoveryPhonePub')
  const cosignerPub = requireCompressedKey(descriptor.vaultBoardCosignerPub, 'vaultBoardCosignerPub')
  const operatorPub = requireCompressedKey(descriptor.operatorPub, 'operatorPub')
  if (operatorPub !== pins.operatorSignerPub) {
    throw new Error('vault-board-v1 Operator does not match this release')
  }
  if (
    boardingPub !== expected.boardingPub ||
    recoveryPub !== requireCompressedKey(expected.phonePub, 'phoneBip340Pub')
  ) {
    throw new Error('vault-board-v1 descriptor keys do not match this wallet')
  }
  const xOnly = [boardingPub, recoveryPub, cosignerPub, operatorPub].map((key) => key.slice(2))
  if (new Set(xOnly).size !== xOnly.length) throw new Error('vault-board-v1 roles must use distinct keys')
  const program = createBoardingProgramScript(
    {
      name: BOARDING_PROGRAM,
      boardingPubKey: hexToBytes(boardingPub).slice(1),
      cosignerPubKey: hexToBytes(cosignerPub).slice(1),
      recoveryPubKey: hexToBytes(recoveryPub).slice(1),
    },
    hexToBytes(pins.operatorSignerPub).slice(1),
    { type: 'seconds', value: BigInt(pins.boardExitDelay) },
  )
  const script = requireLowerHex(descriptor.script, 'vault-board-v1 script', 34)
  const address = program.onchainAddress(getNetwork(pins.sdkNetwork))
  if (hex.encode(program.pkScript) !== script || descriptor.address !== address) {
    throw new Error('vault-board-v1 script or address does not match its exact program')
  }
  return descriptor
}

export function requireBoardingStatus(status: VaultStatus, expectedBoardingPub: string): BoardingDescriptor {
  if (status.vtxoBoardingProgram !== BOARDING_PROGRAM || !status.vtxoBoardingActive) {
    throw new Error('vault is not enrolled for vault-board-v1')
  }
  const descriptor = requireBoardingDescriptor(status.vtxoBoardingDescriptor, {
    vaultId: status.vaultId,
    phonePub: String(status.phoneBip340Pub || ''),
    boardingPub: expectedBoardingPub,
    network: status.network,
  })
  if (
    descriptor.script !== String(status.vtxoBoardingScript || '').toLowerCase() ||
    descriptor.address !== status.vtxoBoardingAddress ||
    descriptor.exitDelay !== status.vtxoBoardingExitDelay ||
    descriptor.exitDelayUnit !== status.vtxoBoardingExitDelayUnit
  ) {
    throw new Error('vault-board-v1 status descriptor changed')
  }
  if (!status.vtxoBoardingDescriptorHash || !/^[0-9a-f]{64}$/.test(status.vtxoBoardingDescriptorHash)) {
    throw new Error('vault-board-v1 descriptor hash required')
  }
  return descriptor
}

function databaseName(vaultId: string) {
  const id = String(vaultId || '').trim()
  if (!id) throw new Error('vault id required')
  return databaseNameForNamespace(vaultWalletNamespace(id))
}

function databaseNameForNamespace(namespace: string) {
  if (!/^[0-9a-f]{32}$/.test(namespace)) throw new Error('vault-board-v1 namespace is invalid')
  return `${KEY_DATABASE_PREFIX}:${namespace}`
}

function openKeyDatabaseForName(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, KEY_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('vault-board-v1 key database unavailable'))
  })
}

function openKeyDatabase(vaultId: string): Promise<IDBDatabase> {
  return openKeyDatabaseForName(databaseName(vaultId))
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('vault-board-v1 key operation failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error || new Error('vault-board-v1 key transaction aborted'))
    transaction.onerror = () => reject(transaction.error || new Error('vault-board-v1 key transaction failed'))
  })
}

export async function stageBoardingKey(input: {
  vaultId: string
  phoneSecret: Uint8Array
  network: string
  descriptorHash?: string
}): Promise<Omit<BoardingKeyRecord, 'state'>> {
  const derived = await deriveBoardingKey(input.phoneSecret, input.vaultId, input.network)
  const pins = networkPins(input.network)
  const record: Omit<BoardingKeyRecord, 'state'> = {
    vaultId: input.vaultId,
    network: pins.network,
    programDigest: boardingProgramDigestFor(pins.network),
    descriptorHash: String(input.descriptorHash || ''),
    boardingPub: derived.boardingPub,
    secret: derived.secret,
  }
  const db = await openKeyDatabase(input.vaultId)
  try {
    const transaction = db.transaction(KEY_STORE, 'readwrite')
    transaction.objectStore(KEY_STORE).put({ ...record, state: 'staged' } satisfies BoardingKeyRecord, 'staged')
    await transactionDone(transaction)
  } finally {
    db.close()
    derived.secret.fill(0)
  }
  return { ...record, secret: new Uint8Array(0) }
}

export async function activateBoardingKey(input: {
  vaultId: string
  descriptorHash: string
  expectedBoardingPub: string
}): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(input.descriptorHash)) throw new Error('vault-board-v1 descriptor hash required')
  const db = await openKeyDatabase(input.vaultId)
  let staged: BoardingKeyRecord | undefined
  let active: BoardingKeyRecord | undefined
  try {
    const transaction = db.transaction(KEY_STORE, 'readwrite')
    const store = transaction.objectStore(KEY_STORE)
    staged = (await requestResult(store.get('staged'))) as BoardingKeyRecord | undefined
    if (!staged) {
      active = (await requestResult(store.get('active'))) as BoardingKeyRecord | undefined
      try {
        requireStoredBoardingKey(active, 'active', input, false)
      } catch (error) {
        transaction.abort()
        throw error
      }
      await transactionDone(transaction)
      return
    }
    try {
      requireStoredBoardingKey(staged, 'staged', input, true)
    } catch (error) {
      transaction.abort()
      throw error
    }
    store.put({ ...staged, state: 'active', descriptorHash: input.descriptorHash }, 'active')
    store.delete('staged')
    await transactionDone(transaction)
  } finally {
    if (ArrayBuffer.isView(staged?.secret)) staged.secret.fill(0)
    if (ArrayBuffer.isView(active?.secret)) active.secret.fill(0)
    db.close()
  }
}

function requireStoredBoardingKey(
  record: BoardingKeyRecord | undefined,
  state: BoardingKeyRecord['state'],
  input: { vaultId: string; descriptorHash: string; expectedBoardingPub: string },
  allowEmptyDescriptorHash: boolean,
): asserts record is BoardingKeyRecord {
  const mismatch = (field: string) => new Error(`${state} vault-board-v1 key does not match descriptor (${field})`)
  if (!record || record.state !== state) throw mismatch('state')
  if (
    record.vaultId !== input.vaultId ||
    record.programDigest !== boardingProgramDigestFor(requireSupportedVaultNetwork(record.network)) ||
    record.boardingPub !== input.expectedBoardingPub
  ) {
    throw mismatch('binding')
  }
  if (
    (!allowEmptyDescriptorHash && record.descriptorHash !== input.descriptorHash) ||
    (allowEmptyDescriptorHash && record.descriptorHash !== '' && record.descriptorHash !== input.descriptorHash)
  ) {
    throw mismatch('descriptor')
  }
  if (!ArrayBuffer.isView(record.secret) || record.secret.BYTES_PER_ELEMENT !== 1 || record.secret.length !== 32) {
    throw mismatch('secret')
  }
  const secret = Uint8Array.from(record.secret)
  let storedPub: string
  try {
    storedPub = hex.encode(secp256k1.getPublicKey(secret, true))
  } catch {
    throw mismatch('secret')
  } finally {
    secret.fill(0)
  }
  if (storedPub !== input.expectedBoardingPub) throw mismatch('public key')
}

export async function provisionBoardingKey(phoneSecret: Uint8Array, status: VaultStatus): Promise<void> {
  if (status.vtxoBoardingProgram !== BOARDING_PROGRAM) {
    throw new Error('vault service does not use the required boarding program')
  }
  const staged = await stageBoardingKey({
    vaultId: status.vaultId,
    phoneSecret,
    network: status.network,
    descriptorHash: status.vtxoBoardingDescriptorHash,
  })
  requireBoardingStatus(status, staged.boardingPub)
  await activateBoardingKey({
    vaultId: status.vaultId,
    descriptorHash: String(status.vtxoBoardingDescriptorHash || ''),
    expectedBoardingPub: staged.boardingPub,
  })
}

export async function loadActiveBoardingKey(vaultId: string): Promise<BoardingKeyRecord> {
  return loadActiveBoardingKeyFromDatabase(await openKeyDatabase(vaultId), vaultId)
}

export async function loadActiveBoardingKeyForNamespace(namespace: string): Promise<BoardingKeyRecord> {
  return loadActiveBoardingKeyFromDatabase(await openKeyDatabaseForName(databaseNameForNamespace(namespace)))
}

async function loadActiveBoardingKeyFromDatabase(
  db: IDBDatabase,
  expectedVaultId?: string,
): Promise<BoardingKeyRecord> {
  try {
    const transaction = db.transaction(KEY_STORE, 'readonly')
    const record = (await requestResult(transaction.objectStore(KEY_STORE).get('active'))) as
      | BoardingKeyRecord
      | undefined
    await transactionDone(transaction)
    if (
      !record ||
      record.state !== 'active' ||
      (expectedVaultId && record.vaultId !== expectedVaultId) ||
      record.secret.length !== 32
    ) {
      throw new Error('active vault-board-v1 key required')
    }
    return { ...record, secret: record.secret.slice() }
  } finally {
    db.close()
  }
}

/** Revoke worker access while retaining the exact key needed to resume staged enrollment. */
export async function suspendBoardingKey(vaultId: string): Promise<void> {
  const db = await openKeyDatabase(vaultId)
  let active: BoardingKeyRecord | undefined
  try {
    const transaction = db.transaction(KEY_STORE, 'readwrite')
    const store = transaction.objectStore(KEY_STORE)
    active = (await requestResult(store.get('active'))) as BoardingKeyRecord | undefined
    if (active) {
      const staged = await requestResult(store.getKey('staged'))
      if (staged === undefined) store.put({ ...active, state: 'staged' }, 'staged')
      store.delete('active')
    }
    await transactionDone(transaction)
  } finally {
    active?.secret?.fill(0)
    db.close()
  }
}

export async function deleteBoardingKey(vaultId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName(vaultId))
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('vault-board-v1 key deletion failed'))
    request.onblocked = () => reject(new Error('vault-board-v1 key deletion was blocked'))
  })
}
