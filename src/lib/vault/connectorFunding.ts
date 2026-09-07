import { base64, hex } from '@scure/base'
import { OutScript, Transaction, p2wpkh } from '@scure/btc-signer'
import { RawTx } from '@scure/btc-signer/script.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { connectorContract, connectorIdentity } from './connectorWithdrawal'
import { buildConnectorFamily, CONNECTOR_RESERVE_SATS } from './program/connector'
import { fetchAddressUtxos, fetchFeeEstimates, fetchTxHex, broadcastTx } from './esplora'
import { browserVaultLockManager, requireVaultLockManager } from './vtxo/lock'
import { readBounded } from './bounded'
import type { VaultStatus } from './types'

const OPTIONS = { allowUnknownOutputs: true } as const
const MAX_MONEY = 2_100_000_000_000_000n

function decode(text: string) {
  if (text.length > 2_000_000) throw new Error('Funding file is too large.')
  const compact = text.replace(/\s/g, '')
  return /^[0-9a-f]+$/i.test(compact) ? hex.decode(compact) : base64.decode(compact)
}

export interface FundingRequest {
  sourcePsbt: string
  parents: string[]
  savingsScript: string
  reserveScript: string
  addReserve: boolean
  feeRate: number
  feeCap: number
  feerateCap: number
}

// The external wallet selects coins and change. Only its Savings output is
// split; all other outputs and input signing metadata retain their positions.
export function prepareFunding(request: FundingRequest) {
  if (typeof request.addReserve !== 'boolean') throw new Error('Invalid reserve funding decision.')
  const tx = Transaction.fromPSBT(decode(request.sourcePsbt), OPTIONS)
  if (tx.inputsLength < 1 || tx.inputsLength > 50 || tx.outputsLength < 1 || tx.outputsLength > 2)
    throw new Error('Use a payment with one Savings recipient and optional change, with at most 50 inputs.')
  if (request.parents.length !== tx.inputsLength) throw new Error('Funding parents are missing.')
  if (
    !Number.isFinite(request.feeRate) ||
    request.feeRate < 1 ||
    request.feeRate > request.feerateCap ||
    !Number.isFinite(request.feerateCap) ||
    request.feerateCap < 1 ||
    request.feerateCap > 100 ||
    !Number.isSafeInteger(request.feeCap) ||
    request.feeCap < 1 ||
    request.feeCap > 100000
  )
    throw new Error('Funding fee is outside the supported limits.')
  const scripts: Uint8Array[] = []
  const values: bigint[] = []
  const seen = new Set<string>()
  let witnessWeight = 2
  let minimumWitnessWeight = 2
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i)
    if (!input.txid || input.index === undefined) throw new Error('Funding outpoint is missing.')
    const id = hex.encode(input.txid)
    const outpoint = `${id}:${input.index}`
    if (seen.has(outpoint)) throw new Error('Duplicate funding input.')
    seen.add(outpoint)
    if (
      input.partialSig?.length ||
      input.tapKeySig ||
      input.tapScriptSig?.length ||
      input.finalScriptWitness?.length ||
      input.finalScriptSig?.length
    )
      throw new Error('Import an unsigned payment before approving it in your signing wallet.')
    const parent = Transaction.fromRaw(decode(request.parents[i]), OPTIONS)
    if (parent.id !== id) throw new Error('Funding parent hash mismatch.')
    const prevout = parent.getOutput(input.index)
    if (!prevout.script || prevout.amount === undefined || prevout.amount <= 0n || prevout.amount > MAX_MONEY)
      throw new Error('Invalid funding prevout.')
    const type = OutScript.decode(prevout.script).type
    if (!['wpkh', 'tr'].includes(type) || input.redeemScript || input.witnessScript || input.tapLeafScript?.length)
      throw new Error('Funding supports native SegWit and Taproot key-path inputs.')
    if (input.sighashType !== undefined && input.sighashType !== 1 && !(type === 'tr' && input.sighashType === 0))
      throw new Error('Funding signatures must approve all outputs.')
    if (
      input.witnessUtxo &&
      (input.witnessUtxo.amount !== prevout.amount ||
        hex.encode(input.witnessUtxo.script) !== hex.encode(prevout.script))
    )
      throw new Error('Funding prevout mismatch.')
    if (input.nonWitnessUtxo && Transaction.fromRaw(RawTx.encode(input.nonWitnessUtxo), OPTIONS).id !== id)
      throw new Error('Funding parent mismatch.')
    tx.updateInput(i, { witnessUtxo: { amount: prevout.amount, script: prevout.script } })
    scripts.push(prevout.script)
    values.push(prevout.amount)
    witnessWeight += type === 'tr' ? 67 : 109
    minimumWitnessWeight += type === 'tr' ? 66 : 45
  }
  const total = values.reduce((a, b) => a + b, 0n)
  if (total > MAX_MONEY) throw new Error('Funding value is too large.')
  let savingsIndex = -1
  let outputs = 0n
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)
    if (!out.script || out.amount === undefined || out.amount <= 0n || out.amount > MAX_MONEY)
      throw new Error('Invalid funding output.')
    const script = hex.encode(out.script)
    if (request.addReserve && script === request.reserveScript && out.amount === 1000n)
      throw new Error('Import a payment to Savings only; Vaulted adds the reserve.')
    if (script === request.savingsScript) {
      if (savingsIndex !== -1) throw new Error('Use exactly one Savings output.')
      savingsIndex = i
    } else if (!['wpkh', 'tr'].includes(OutScript.decode(out.script).type)) {
      throw new Error('Funding change must use native SegWit or Taproot.')
    }
    outputs += out.amount
  }
  if (savingsIndex === -1) throw new Error('The unsigned payment must pay this vault’s Savings address.')
  const oldFee = total - outputs
  if (oldFee < 0n || oldFee > BigInt(request.feeCap)) throw new Error('Funding fee exceeds the limit.')
  const reserve = request.addReserve ? CONNECTOR_RESERVE_SATS : 0
  if (reserve) tx.addOutput({ script: hex.decode(request.reserveScript), amount: BigInt(reserve) })
  const estimatedVbytes = Math.ceil((tx.unsignedTx.length * 4 + witnessWeight) / 4)
  const minimumVbytes = Math.ceil((tx.unsignedTx.length * 4 + minimumWitnessWeight) / 4)
  const maximumFee = Math.floor(minimumVbytes * request.feerateCap)
  if (oldFee > BigInt(maximumFee)) throw new Error('Funding fee rate exceeds the limit.')
  const fee = Math.min(maximumFee, Math.max(Number(oldFee), Math.ceil(estimatedVbytes * request.feeRate)))
  if (fee > request.feeCap) throw new Error('Funding fee exceeds the limit.')
  const savings = Number(tx.getOutput(savingsIndex).amount!) - reserve - (fee - Number(oldFee))
  if (!Number.isSafeInteger(savings) || savings < 330)
    throw new Error('Deposit is too small for Savings, its reserve and the network fee.')
  tx.updateOutput(savingsIndex, { amount: BigInt(savings) })
  const psbt = hex.encode(tx.toPSBT())
  const unsigned = hex.encode(tx.unsignedTx)
  return {
    psbt,
    savings,
    reserve,
    fee,
    txid: tx.id,
    accept(text: string) {
      const raw = decode(text)
      const response =
        hex.encode(raw.slice(0, 5)) === '70736274ff'
          ? Transaction.fromPSBT(raw, OPTIONS)
          : Transaction.fromRaw(raw, OPTIONS)
      if (hex.encode(response.unsignedTx) !== unsigned) throw new Error('Signer changed the funding transaction.')
      const result = Transaction.fromPSBT(hex.decode(psbt), OPTIONS)
      for (let i = 0; i < tx.inputsLength; i++) {
        const input = response.getInput(i)
        if (input.finalScriptSig?.length || input.tapScriptSig?.length)
          throw new Error('Unexpected funding signing path.')
        const type = OutScript.decode(scripts[i]).type
        let witness = input.finalScriptWitness
        if (type === 'tr') {
          const sig = witness?.[0] ?? input.tapKeySig
          if ((witness && witness.length !== 1) || !sig || (sig.length !== 64 && (sig.length !== 65 || sig[64] !== 1)))
            throw new Error('A Taproot signature approving all outputs is required.')
          const hashType = sig.length === 64 ? 0 : 1
          if (
            !schnorr.verify(sig.slice(0, 64), tx.preimageWitnessV1(i, scripts, hashType, values), scripts[i].slice(2))
          )
            throw new Error('Invalid funding signature.')
          witness = [sig]
        } else {
          if (!witness && input.partialSig?.length === 1) witness = [input.partialSig[0][1], input.partialSig[0][0]]
          if (!witness || witness.length !== 2) throw new Error('A native SegWit signature is required.')
          const [sig, pub] = witness
          if (
            sig.length < 9 ||
            sig.length > 73 ||
            sig[sig.length - 1] !== 1 ||
            hex.encode(p2wpkh(pub).script) !== hex.encode(scripts[i])
          )
            throw new Error('Invalid funding signature.')
          const scriptCode = new Uint8Array([0x76, 0xa9, 0x14, ...scripts[i].slice(2), 0x88, 0xac])
          if (
            !secp256k1.verify(sig.slice(0, -1), tx.preimageWitnessV0(i, scriptCode, 1, values[i]), pub, {
              format: 'der',
              prehash: false,
              lowS: true,
            })
          )
            throw new Error('Invalid funding signature.')
        }
        result.updateInput(i, { finalScriptWitness: witness })
      }
      if (fee > result.vsize * request.feerateCap) throw new Error('Signed funding fee rate exceeds the limit.')
      return { txHex: hex.encode(result.extract()), txid: result.id }
    },
  }
}

interface FundingDraft {
  enrollmentDigest: string
  request: FundingRequest
  signed?: string
  submitted?: boolean
}
const storageKey = (status: VaultStatus) => `vaulted:connector-funding:${status.network}:${status.vaultId}`

export function loadFunding(status: VaultStatus) {
  const identity = connectorIdentity(status)
  const text = localStorage.getItem(storageKey(status))
  if (!text) return null
  const draft = JSON.parse(text) as FundingDraft
  const contract = connectorContract(status)
  const family = buildConnectorFamily(contract)
  if (
    draft.request.feeCap !== contract.absoluteFeeCapSats ||
    draft.request.feerateCap !== contract.feerateCapSatPerV ||
    draft.request.feeRate > contract.feerateCapSatPerV
  )
    throw new Error('Saved funding fee exceeds the vault limits.')
  if (
    draft.enrollmentDigest !== identity.enrollmentDigest ||
    draft.request.savingsScript !== hex.encode(family.savings.script) ||
    draft.request.reserveScript !== hex.encode(family.connector.script)
  )
    throw new Error('Funding enrollment does not match this vault.')
  return { draft, prepared: prepareFunding(draft.request) }
}

async function createFundingLocked(status: VaultStatus, sourcePsbt: string) {
  if (loadFunding(status)) throw new Error('Continue the saved deposit before preparing another.')
  const identity = connectorIdentity(status)
  const contract = connectorContract(status)
  const family = buildConnectorFamily(contract)
  const source = Transaction.fromPSBT(decode(sourcePsbt), OPTIONS)
  if (source.inputsLength < 1 || source.inputsLength > 50) throw new Error('Use between one and 50 funding inputs.')
  const [coins, estimates] = await Promise.all([fetchAddressUtxos(family.connector.address!), fetchFeeEstimates()])
  const reserves = coins.filter((c) => c.value === CONNECTOR_RESERVE_SATS)
  if (reserves.some((c) => !c.status.confirmed)) throw new Error('Wait for the pending signer reserve to confirm.')
  const feeRate = estimates['3'] ?? estimates['6']
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > contract.feerateCapSatPerV)
    throw new Error('A fee estimate within this vault’s limit is unavailable. Try again later.')
  const parents: string[] = []
  for (let i = 0; i < source.inputsLength; i++) {
    const input = source.getInput(i)
    if (!input.txid) throw new Error('Funding input is missing.')
    if (reserves.some((c) => c.txid === hex.encode(input.txid!) && c.vout === input.index))
      throw new Error('Keep the existing signer reserve out of the funding inputs.')
    parents.push(await fetchTxHex(hex.encode(input.txid)))
  }
  const request: FundingRequest = {
    sourcePsbt,
    parents,
    savingsScript: hex.encode(family.savings.script),
    reserveScript: hex.encode(family.connector.script),
    addReserve: reserves.length === 0,
    feeRate,
    feeCap: contract.absoluteFeeCapSats,
    feerateCap: contract.feerateCapSatPerV,
  }
  const prepared = prepareFunding(request)
  const draft: FundingDraft = { enrollmentDigest: identity.enrollmentDigest, request }
  localStorage.setItem(storageKey(status), JSON.stringify(draft))
  return { draft, prepared }
}

async function submitFundingLocked(status: VaultStatus, signed: string) {
  const saved = loadFunding(status)
  if (!saved) throw new Error('Prepare the Savings deposit first.')
  const accepted = saved.prepared.accept(saved.draft.signed || signed)
  // Retain the exact signed transaction before broadcast, including on timeout.
  localStorage.setItem(storageKey(status), JSON.stringify({ ...saved.draft, signed: accepted.txHex }))
  const txid = await broadcastTx(accepted.txHex)
  localStorage.setItem(storageKey(status), JSON.stringify({ ...saved.draft, signed: accepted.txHex, submitted: true }))
  return txid
}

export function createFunding(status: VaultStatus, sourcePsbt: string) {
  return requireVaultLockManager(browserVaultLockManager()).request(storageKey(status), { mode: 'exclusive' }, () =>
    createFundingLocked(status, sourcePsbt),
  )
}

export function submitFunding(status: VaultStatus, signed: string) {
  return requireVaultLockManager(browserVaultLockManager()).request(storageKey(status), { mode: 'exclusive' }, () =>
    submitFundingLocked(status, signed),
  )
}

export function finishFunding(status: VaultStatus) {
  return requireVaultLockManager(browserVaultLockManager()).request(
    storageKey(status),
    { mode: 'exclusive' },
    async () => {
      const saved = loadFunding(status)
      if (!saved) throw new Error('No saved deposit.')
      const txid = saved.prepared.txid
      const response = await fetch(`/esplora/tx/${txid}/status`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Deposit is not confirmed yet. Keep the saved transaction.')
      const state = JSON.parse(await readBounded(response))
      if (state.confirmed !== true) throw new Error('Wait for Bitcoin confirmation before preparing another deposit.')
      localStorage.removeItem(storageKey(status))
      return txid
    },
  )
}

// Abandoning the local handoff cannot revoke an externally signed transaction.
// Retain its evidence before allowing a new deposit to be prepared.
export function abandonFunding(status: VaultStatus) {
  return requireVaultLockManager(browserVaultLockManager()).request(
    storageKey(status),
    { mode: 'exclusive' },
    async () => {
      connectorIdentity(status)
      const key = storageKey(status)
      const previous = localStorage.getItem(key)
      if (previous) {
        localStorage.setItem(`${key}:abandoned:${crypto.randomUUID()}`, previous)
        localStorage.removeItem(key)
      }
    },
  )
}
