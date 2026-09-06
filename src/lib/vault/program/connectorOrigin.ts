import { base58, hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { p2tr, p2wpkh } from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { vaultAddressNetwork } from '../addressNetwork'

// Strict import boundary for a conventional software signer's PUBLIC wallet
// descriptor. Accepted forms only:
//
//   wpkh([<fp>/<origin>]<xpub|tpub|zpub|vpub>/<suffix>)  -> p2wpkh leaf
//   tr([<fp>/<origin>]<xpub|tpub>/<suffix>)              -> p2tr key-path leaf
//   wpkh([<fp>/<full origin>]<33-byte compressed key>)   -> p2wpkh leaf
//   tr([<fp>/<full origin>]<33-byte compressed key>)     -> p2tr key-path leaf
//
// zpub/vpub already declare native SegWit, so tr requires xpub/tpub. The
// suffix resolves a receiving leaf: the familiar <0;1> multipath marker may
// appear at most once and only at the branch position (so <0;1>/* selects
// receive branch 0), while wildcard steps select the explicit index argument
// (default first index 0). The resolved full path must be a standard
// BIP84/BIP86 path with the network coin type, or — for wpkh only — a native
// Electrum SegWit m/0'/branch/index path. The extended key must agree with the
// origin (depth, child index, and, at depth 1, parent fingerprint). Nothing
// here touches private keys, mnemonics, the network, or the UI. Error messages
// never echo caller input.

export type ConnectorOriginNetwork = 'mainnet' | 'mutinynet'
export type ConnectorOriginType = 'p2wpkh' | 'p2tr'

export interface ImportedConnectorOrigin {
  type: ConnectorOriginType
  /** Lowercase compressed public-key hex; exact parity is preserved. */
  publicKey: string
  /** Master fingerprint as a uint32 (big-endian display form). */
  fingerprint: number
  /** Full raw BIP32 path; hardened steps carry the 0x80000000 flag. */
  path: number[]
  /** Receiving address for the leaf key on the requested network. */
  address: string
  /** Human-readable account of the selected path (receive vs change). */
  selectedPath: string
}

const HARDENED = 0x80000000
const PURPOSE_WPKH = 0x80000054
const PURPOSE_TR = 0x80000056
const MAX_DESCRIPTOR_LENGTH = 1024

// Native-SegWit extended-key versions only. Nested-SegWit (ypub/upub) and any
// other version prefix are rejected by construction. zpub/vpub already declare
// native SegWit and are only valid with wpkh; tr requires xpub/tpub.
const KEY_VERSIONS = [
  { versions: { private: 0x0488ade4, public: 0x0488b21e }, network: 'mainnet', native: false },
  { versions: { private: 0x04358394, public: 0x043587cf }, network: 'mutinynet', native: false },
  { versions: { private: 0x04b2430c, public: 0x04b24746 }, network: 'mainnet', native: true },
  { versions: { private: 0x045f18bc, public: 0x045f1cf6 }, network: 'mutinynet', native: true },
] as const

// Known private extended-key version prefixes. Checked from the raw Base58
// payload before any private HD node is constructed.
const PRIVATE_VERSIONS = new Set([0x0488ade4, 0x04358394, 0x04b2430c, 0x045f18bc, 0x049d7878, 0x044a4e28])

const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const CHECKSUM_GENERATORS = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn]
const CHECKSUM_INPUT_CHARSET =
  '0123456789()[],\'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#"\\ '

function checksumPolyMod(c: bigint, value: bigint): bigint {
  const head = c >> 35n
  c = ((c & 0x7ffffffffn) << 5n) ^ value
  if (head & 1n) c ^= CHECKSUM_GENERATORS[0]
  if (head & 2n) c ^= CHECKSUM_GENERATORS[1]
  if (head & 4n) c ^= CHECKSUM_GENERATORS[2]
  if (head & 8n) c ^= CHECKSUM_GENERATORS[3]
  if (head & 16n) c ^= CHECKSUM_GENERATORS[4]
  return c
}

// Compact Bitcoin Core descriptor-checksum implementation. Returns '' when the
// payload contains characters outside the descriptor alphabet.
function descriptorChecksum(payload: string): string {
  let c = 1n
  let cls = 0n
  let clscount = 0n
  for (const ch of payload) {
    const pos = BigInt(CHECKSUM_INPUT_CHARSET.indexOf(ch))
    if (pos < 0n) return ''
    c = checksumPolyMod(c, pos & 31n)
    cls = cls * 3n + (pos >> 5n)
    if (++clscount === 3n) {
      c = checksumPolyMod(c, cls)
      cls = 0n
      clscount = 0n
    }
  }
  if (clscount > 0n) c = checksumPolyMod(c, cls)
  for (let j = 0; j < 8; j++) c = checksumPolyMod(c, 0n)
  c ^= 1n
  let out = ''
  for (let j = 0; j < 8; j++) out += CHECKSUM_CHARSET[Number((c >> (5n * BigInt(7 - j))) & 31n)]
  return out
}

function fail(message: string): never {
  throw new Error(message)
}

function parseStep(text: string, hardenedAllowed: boolean): number {
  const match = /^(\d+)(['h]?)$/.exec(text)
  if (!match || match[1].length > 10) fail('invalid descriptor origin path')
  const index = Number(match[1])
  if (!Number.isSafeInteger(index) || index >= HARDENED) fail('invalid descriptor origin path')
  const hardened = match[2] !== ''
  if (hardened && !hardenedAllowed) fail('hardened derivation step outside origin')
  return hardened ? index + HARDENED : index
}

function parseOrigin(text: string): { fingerprint: number; steps: number[] } {
  const match = /^\[([0-9a-fA-F]{8})((?:\/\d+['h]?)*)\]$/.exec(text)
  if (!match) fail('descriptor origin fingerprint and path required')
  const fingerprint = parseInt(match[1], 16)
  if (!Number.isSafeInteger(fingerprint) || fingerprint > 0xffffffff) fail('descriptor origin fingerprint required')
  const steps =
    match[2] === ''
      ? []
      : match[2]
          .slice(1)
          .split('/')
          .map((step) => parseStep(step, true))
  if (steps.length < 1 || steps.length > 32) fail('descriptor origin path required')
  return { fingerprint, steps }
}

function isStandardPath(path: number[], type: ConnectorOriginType, network: ConnectorOriginNetwork): boolean {
  const coin = network === 'mainnet' ? HARDENED : HARDENED + 1
  const purpose = type === 'p2wpkh' ? PURPOSE_WPKH : PURPOSE_TR
  if (
    path.length === 5 &&
    path[0] === purpose &&
    path[1] === coin &&
    path[2] >= HARDENED &&
    path[3] <= 1 &&
    path[4] < HARDENED
  ) {
    return true
  }
  // Native Electrum SegWit wallets derive receive/change leaves as
  // m/0'/branch/index. Runtime KeyOrigin.Kind supports that native origin for
  // P2WPKH only, so tr never matches here.
  if (type === 'p2wpkh' && path.length === 3 && path[0] === HARDENED && path[1] <= 1 && path[2] < HARDENED) return true
  return false
}

function extendedKeyVersion(key: string): number {
  let raw: Uint8Array
  try {
    raw = base58.decode(key)
  } catch {
    fail('unsupported descriptor key')
  }
  if (raw.length !== 82) fail('unsupported descriptor key')
  return new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, false)
}

function decodeExtendedKey(key: string, network: ConnectorOriginNetwork, type: ConnectorOriginType): HDKey {
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,200}$/.test(key)) fail('unsupported descriptor key')
  if (PRIVATE_VERSIONS.has(extendedKeyVersion(key))) fail('private extended keys are not accepted')
  for (const candidate of KEY_VERSIONS) {
    let node: HDKey
    try {
      node = HDKey.fromExtendedKey(key, { ...candidate.versions })
    } catch {
      continue
    }
    if (node.privateKey !== null) {
      try {
        node.wipePrivateData()
      } catch {
        // Wiping is best-effort; the rejection below is what matters.
      }
      fail('private extended keys are not accepted')
    }
    if (candidate.network !== network) fail('extended key network mismatch')
    if (candidate.native && type !== 'p2wpkh') fail('native SegWit versions require wpkh')
    return node
  }
  fail('unsupported descriptor key')
}

function decodeConcreteKey(key: string): Uint8Array {
  if (!/^[0-9a-fA-F]{66}$/.test(key)) fail('unsupported descriptor key')
  const bytes = hex.decode(key.toLowerCase())
  if ((bytes[0] !== 2 && bytes[0] !== 3) || !secp256k1.utils.isValidPublicKey(bytes, true))
    fail('invalid compressed public key')
  return bytes
}

interface ResolvedSuffix {
  steps: number[]
  multipath: boolean
  wildcard: boolean
}

// Only the familiar receive/change multipath marker at the branch position
// plus plain unhardened steps are understood. <0;1> may appear at most once,
// as the second-to-last suffix step, and deliberately selects receive branch
// 0; a wildcard selects the explicit index argument (default first index 0).
function resolveSuffix(suffix: string, index: number): ResolvedSuffix {
  if (suffix === '' || !suffix.startsWith('/')) fail('derivation suffix required')
  const parts = suffix.slice(1).split('/')
  const steps: number[] = []
  let multipath = false
  let multipathCount = 0
  let multipathPosition = -1
  let wildcard = false
  parts.forEach((part, position) => {
    const last = position === parts.length - 1
    if (part === '<0;1>') {
      multipath = true
      multipathCount += 1
      multipathPosition = position
      steps.push(0)
      return
    }
    if (part === '*') {
      if (!last) fail('unsupported descriptor derivation')
      wildcard = true
      steps.push(index)
      return
    }
    if (!/^\d{1,10}$/.test(part)) fail('unsupported descriptor derivation')
    const value = Number(part)
    if (!Number.isSafeInteger(value) || value >= HARDENED) fail('derivation index out of range')
    steps.push(value)
  })
  if (!wildcard && index !== 0) fail('derivation index requires a wildcard step')
  if (multipathCount > 1 || (multipathCount === 1 && multipathPosition !== parts.length - 2))
    fail('unsupported descriptor derivation')
  return { steps, multipath, wildcard }
}

function formatPath(path: number[]): string {
  return `m/${path.map((step) => (step >= HARDENED ? `${step - HARDENED}'` : `${step}`)).join('/')}`
}

function describeSelection(path: number[], multipath: boolean, wildcard: boolean, index: number): string {
  const branch = path.length >= 2 ? path[path.length - 2] : -1
  const branchNote = branch === 0 ? 'receive branch 0' : branch === 1 ? 'change branch 1 (explicitly stated)' : ''
  const how = multipath
    ? 'multipath <0;1> resolved to receive branch 0'
    : wildcard
      ? `wildcard * resolved to index ${index}`
      : 'explicitly stated steps'
  return `${formatPath(path)} (${how}${branchNote ? `; ${branchNote}` : ''})`
}

export function importConnectorOrigin(
  descriptor: string,
  network: ConnectorOriginNetwork,
  index = 0,
): ImportedConnectorOrigin {
  if (typeof descriptor !== 'string' || descriptor.length < 1 || descriptor.length > MAX_DESCRIPTOR_LENGTH)
    fail('invalid descriptor')
  if (network !== 'mainnet' && network !== 'mutinynet') fail('unsupported network')
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) fail('derivation index out of range')

  let payload = descriptor
  const hashAt = descriptor.indexOf('#')
  if (hashAt >= 0) {
    const given = descriptor.slice(hashAt + 1)
    if (hashAt < 1 || given.length !== 8 || descriptor.indexOf('#', hashAt + 1) >= 0)
      fail('invalid descriptor checksum')
    for (const ch of given) if (!CHECKSUM_CHARSET.includes(ch)) fail('invalid descriptor checksum')
    payload = descriptor.slice(0, hashAt)
    if (descriptorChecksum(payload) !== given) fail('invalid descriptor checksum')
  }

  let type: ConnectorOriginType
  let inner: string
  if (payload.startsWith('wpkh(') && payload.endsWith(')')) {
    type = 'p2wpkh'
    inner = payload.slice(5, -1)
  } else if (payload.startsWith('tr(') && payload.endsWith(')')) {
    type = 'p2tr'
    inner = payload.slice(3, -1)
  } else {
    fail('only wpkh and key-path tr descriptors are supported')
  }
  if (inner.length < 1) fail('invalid descriptor')

  // Key-path-only tr: anything beyond origin + key + suffix (tap trees,
  // multisig second keys, unknown wrappers) fails the parses below.
  if (!inner.startsWith('[')) fail('descriptor origin fingerprint and path required')
  const originEnd = inner.indexOf(']')
  if (originEnd < 0) fail('descriptor origin fingerprint and path required')
  const { fingerprint, steps: origin } = parseOrigin(inner.slice(0, originEnd + 1))
  const rest = inner.slice(originEnd + 1)
  if (rest.length < 1) fail('unsupported descriptor key')

  let leaf: Uint8Array
  let path: number[]
  let multipath = false
  let wildcard = false
  const slashAt = rest.indexOf('/')
  const keyText = slashAt < 0 ? rest : rest.slice(0, slashAt)
  const suffix = slashAt < 0 ? '' : rest.slice(slashAt)
  if (/^[0-9a-fA-F]{66}$/.test(keyText)) {
    // Concrete compressed key: the origin must already be complete and no
    // derivation suffix may follow. (A valid extended key is never 66 chars.)
    if (suffix !== '') fail('concrete keys take no derivation suffix')
    leaf = decodeConcreteKey(keyText)
    path = origin
  } else {
    const node = decodeExtendedKey(keyText, network, type)
    if (node.depth !== origin.length) fail('origin depth does not match key depth')
    // The key must be the child the origin claims: same child index, and at
    // depth 1 the parent fingerprint is directly knowable, so it must equal
    // the claimed master fingerprint. Deeper ancestors are inherently
    // supplied by the descriptor and stay the signer's responsibility.
    if (node.index !== origin[origin.length - 1]) fail('origin does not match key')
    if (node.depth === 1 && node.parentFingerprint !== fingerprint) fail('origin does not match key')
    const resolved = resolveSuffix(suffix, index)
    multipath = resolved.multipath
    wildcard = resolved.wildcard
    path = [...origin, ...resolved.steps]
    let derived = node
    for (const step of resolved.steps) derived = derived.deriveChild(step)
    const pub = derived.publicKey
    if (!pub || pub.length !== 33) fail('key derivation failed')
    leaf = pub
  }

  if (!isStandardPath(path, type, network)) fail('non-standard origin path')
  const publicKey = hex.encode(leaf)
  const address =
    type === 'p2wpkh'
      ? p2wpkh(leaf, vaultAddressNetwork(network)).address!
      : p2tr(leaf.slice(1), undefined, vaultAddressNetwork(network)).address!
  return {
    type,
    publicKey,
    fingerprint,
    path,
    address,
    selectedPath: describeSelection(path, multipath, wildcard, index),
  }
}
