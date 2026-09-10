import { isConnectorTemplate } from './program/connector'
import { LIGHT_PROFILE } from './light/contract'
import { unlockLightOwnerKey } from './light/keyBackup'
import { requireLightStatus } from './light/status'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { bitcoinDustSats, scriptHexFromAddress } from './bitcoin'
import { zeroBytes } from './ceremony/directauth'
import { DUST_SATS } from './constants'
import type { EnrollmentSecrets } from './tenantEnrollment'
import { hexToBytes } from './hex'
import { loadAddressPin, requireStatusMatchesPin } from './pin'
import type { VaultStatus } from './types'
import { familyFromDescriptor } from './program/descriptor'
import { loadLocalKit } from './program/kitStore'
import { assertLiveKit } from './program/liveKit'
import { sameBip340Key } from './setupPlan'
import { deviceSigningOptions, prfExtension, prfFrom } from './webauthn'
import { requireMainnetWalletOrigin, requireMainnetWalletRpId } from './productionDomains'
import { requireExactDefaultTapscriptSignatures, tapscriptSignatureRecords } from './taprootSignatures'
import { validateLedgerSavingsEnrollmentSecrets } from './program/ledgerEnrollment'
import { unlockLedgerPhoneSeed } from './ledgerPhoneBackup'
import { LEDGER_NATIVE_TEMPLATE } from './program/ledgerNativeKeys'
import { decryptPhoneSecret } from './signIn'
import { secp256k1 } from '@noble/curves/secp256k1.js'

const PRF_SALT = new TextEncoder().encode('arkade-2fa-vault/prf/v1')
const TX_OPTS = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true } as const

export type SavingsLeaf = 'admin'

export interface SavingsCoin {
  txid: string
  vout: number
  value: number
  confirmedHeight?: number
}

export function buildSavingsPsbt(input: {
  status: VaultStatus
  phonePub: string
  destAddress: string
  amountSats: number
  feeSats: number
  coins: SavingsCoin[]
  leaf: SavingsLeaf
}): string {
  const pin = loadAddressPin(localStorage, input.status.vaultId)
  if (!pin) throw new Error('deposit address is not pinned locally')
  requireStatusMatchesPin(input.status, pin)
  if (pin.savingsAddress !== input.status.savingsAddress) throw new Error('savings address pin mismatch')
  const stored = loadLocalKit(input.status.vaultId)
  if (!stored) throw new Error('Savings needs the Recovery Kit saved on this device')
  const kit = assertLiveKit(stored, input.status)
  if (kit.version === 5) throw new Error('This wallet has no protected Savings contract')
  if (kit.version === 4) throw new Error('Use the Ledger Savings approval flow for this vault.')
  if (kit.descriptor.savings.address !== pin.savingsAddress) {
    throw new Error('Savings map does not match the pinned address')
  }
  if (!sameBip340Key(kit.descriptor.keys.phoneBip340, input.phonePub)) {
    throw new Error('Savings map does not match this device key')
  }
  if (
    input.status.externalOwnerWalletPub &&
    !sameBip340Key(kit.descriptor.keys.hardware, input.status.externalOwnerWalletPub)
  ) {
    throw new Error('Savings map does not match the hardware key')
  }
  if (isConnectorTemplate(kit.descriptor.templateVersion))
    throw new Error('Use the Savings connector approval flow for this vault.')
  const tree = familyFromDescriptor(kit.descriptor).savings
  return buildNativeSavingsPsbt({
    ...input,
    network: input.status.network,
    changeScript: tree.script,
    inputForCoin: () => ({
      witnessScript: tree.script,
      tapInternalKey: tree.tapInternalKey,
      tapLeafScript: [requireSavingsAdminLeaf(tree)],
    }),
  })
}

export function requireSavingsAdminLeaf(tree: {
  admin: Uint8Array
  tapLeafScript?: NonNullable<Parameters<Transaction['addInput']>[0]['tapLeafScript']>
}) {
  const leaf = tree.tapLeafScript?.find(([, script]) => hex.encode(script.slice(0, -1)) === hex.encode(tree.admin))
  if (!leaf) throw new Error('admin leaf is missing from the tree')
  return leaf
}

type NativeInputMetadata = Pick<
  Parameters<Transaction['addInput']>[0],
  'tapInternalKey' | 'tapLeafScript' | 'tapBip32Derivation' | 'nonWitnessUtxo'
> & { witnessScript: Uint8Array }
type NativeChangeMetadata = Pick<
  Parameters<Transaction['addOutput']>[0],
  'tapInternalKey' | 'tapTree' | 'tapBip32Derivation'
>

/** Shared native construction. Callers must reconstruct and verify the enrolled
 * contract before supplying input origins; this function does not trust a server quote. */
export function buildNativeSavingsPsbt<Coin extends SavingsCoin>(input: {
  network: string
  destAddress: string
  amountSats: number
  feeSats: number
  coins: Coin[]
  changeScript: Uint8Array
  inputForCoin: (coin: Coin) => NativeInputMetadata
  changeMetadata?: NativeChangeMetadata
}): string {
  const recipientDustSats = bitcoinDustSats(input.destAddress, input.network)
  if (!Number.isSafeInteger(input.amountSats) || input.amountSats < recipientDustSats) {
    throw new Error(`at least ₿${recipientDustSats}`)
  }
  if (!Number.isSafeInteger(input.feeSats) || input.feeSats < 0) throw new Error('fee required')
  const total = input.amountSats + input.feeSats
  if (!Number.isSafeInteger(total)) throw new Error('invalid Savings total')
  if (input.coins.length === 0) throw new Error('confirmed Savings coins required')
  const coins = [...input.coins].sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout)
  const seen = new Set<string>()
  let inputValue = 0
  for (const coin of coins) {
    if (!/^[0-9a-f]{64}$/.test(coin.txid) || !Number.isInteger(coin.vout) || coin.vout < 0 || coin.vout > 0xffffffff) {
      throw new Error('invalid Savings outpoint')
    }
    if (!Number.isSafeInteger(coin.value) || coin.value <= 0) throw new Error('invalid Savings coin value')
    const outpoint = `${coin.txid}:${coin.vout}`
    if (seen.has(outpoint)) throw new Error('duplicate Savings outpoint')
    seen.add(outpoint)
    inputValue += coin.value
  }
  if (!Number.isSafeInteger(inputValue) || inputValue < total) throw new Error('not enough confirmed Savings')
  const change = inputValue - total
  if (change > 0 && change < DUST_SATS) throw new Error('leave ₿330 of change, or send the rest')

  const tx = new Transaction(TX_OPTS)
  for (const coin of coins) {
    const { witnessScript, ...metadata } = input.inputForCoin(coin)
    tx.addInput({
      ...metadata,
      txid: hex.decode(coin.txid),
      index: coin.vout,
      witnessUtxo: { script: witnessScript, amount: BigInt(coin.value) },
      sequence: 0xffffffff,
    })
  }
  tx.addOutput({
    script: hex.decode(scriptHexFromAddress(input.destAddress, input.network)),
    amount: BigInt(input.amountSats),
  })
  if (change >= DUST_SATS) tx.addOutput({ ...input.changeMetadata, script: input.changeScript, amount: BigInt(change) })
  return hex.encode(tx.toPSBT())
}

async function unlockVaultPrf(rec: EnrollmentSecrets, status: VaultStatus): Promise<Uint8Array<ArrayBuffer>> {
  const rpId = String(status.rpId || '').toLowerCase()
  if (!rpId || rpId !== location.hostname.toLowerCase()) {
    throw new Error('deployment RP ID does not match this signing client host')
  }
  if (status.clientOrigin !== location.origin) {
    throw new Error('deployment origin does not match this signing client origin')
  }
  if (status.network === 'mainnet') {
    requireMainnetWalletOrigin(status.clientOrigin)
    requireMainnetWalletRpId(rpId)
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const credentialId = hexToBytes(rec.credId)
  const get = (await navigator.credentials.get({
    publicKey: deviceSigningOptions(
      {
        challenge,
        rpId,
        userVerification: 'required',
        extensions: prfExtension(PRF_SALT, credentialId),
      },
      credentialId,
    ),
  })) as PublicKeyCredential | null
  if (!get) throw new Error('The operation was aborted.')
  if (hex.encode(new Uint8Array(get.rawId)) !== hex.encode(credentialId))
    throw new Error('passkey credential does not match this vault')
  const prf = prfFrom(get)
  if (!prf || prf.length !== 32) throw new Error('authenticator did not return PRF')
  return prf
}

async function spendingPhoneFromPrf(rec: EnrollmentSecrets, status: VaultStatus, prf: Uint8Array<ArrayBuffer>) {
  if (status.templateVersion === LIGHT_PROFILE) {
    const valid = requireLightStatus(status)
    if (rec.vaultId !== valid.vaultId || rec.phoneBip340Pub !== valid.phoneBip340Pub)
      throw new Error('Light enrollment does not match this vault')
    return unlockLightOwnerKey(rec.lightKeyBackup, prf, 'passkey-prf', valid.lightDescriptor!)
  }
  return decryptPhoneSecret(prf, rec.nonce, rec.ciphertext)
}

function ledgerEnrollmentForUnlock(rec: EnrollmentSecrets, status: VaultStatus) {
  if (
    status.templateVersion !== LEDGER_NATIVE_TEMPLATE ||
    !status.ledgerSavings ||
    !rec.vaultId ||
    rec.vaultId !== status.vaultId ||
    rec.vaultId !== status.ledgerSavings.context.vaultId ||
    rec.phoneDirectP256 !== status.ledgerSavings.context.phoneDirectP256 ||
    rec.phoneBip340Pub !== status.phoneBip340Pub ||
    status.network !== status.ledgerSavings.context.network
  )
    throw new Error('Ledger Savings enrollment does not match this vault')
  return validateLedgerSavingsEnrollmentSecrets(rec.ledgerSavings, {
    context: status.ledgerSavings.context,
    spendingPolicy: status.ledgerSavings.spendingPolicy,
  })
}

export async function unlockPhoneBip340(rec: EnrollmentSecrets, status: VaultStatus): Promise<Uint8Array> {
  rec = structuredClone(rec)
  status = structuredClone(status)
  const prf = await unlockVaultPrf(rec, status)
  try {
    return await spendingPhoneFromPrf(rec, status, prf)
  } finally {
    zeroBytes(prf)
  }
}

/** The caller wipes the returned seed. This never reinterprets the Spending scalar. */
export async function unlockLedgerSavingsSeed(rec: EnrollmentSecrets, status: VaultStatus): Promise<Uint8Array> {
  rec = structuredClone(rec)
  status = structuredClone(status)
  const enrolled = ledgerEnrollmentForUnlock(rec, status)
  const prf = await unlockVaultPrf(rec, status)
  try {
    return await unlockLedgerPhoneSeed(enrolled.phoneSeedBackup, prf, 'passkey-prf', enrolled.contract.context)
  } finally {
    zeroBytes(prf)
  }
}

/** Unlock both distinct phone identities with one passkey prompt. Failure returns neither key. */
export async function unlockVaultPhoneKeys(
  rec: EnrollmentSecrets,
  status: VaultStatus,
): Promise<{
  spendingPhone: Uint8Array
  ledgerSavingsSeed?: Uint8Array
}> {
  rec = structuredClone(rec)
  status = structuredClone(status)
  const enrolled =
    status.templateVersion === LEDGER_NATIVE_TEMPLATE ? ledgerEnrollmentForUnlock(rec, status) : undefined
  if (!enrolled && rec.ledgerSavings) throw new Error('Ledger Savings backup does not match this vault')
  const prf = await unlockVaultPrf(rec, status)
  let spendingPhone: Uint8Array | undefined
  try {
    spendingPhone = await spendingPhoneFromPrf(rec, status, prf)
    if (
      enrolled &&
      (hex.encode(secp256k1.getPublicKey(spendingPhone, true)) !== rec.phoneBip340Pub ||
        rec.phoneBip340Pub !== status.phoneBip340Pub)
    )
      throw new Error('Recovered Spending phone does not match its enrollment')
    const ledgerSavingsSeed = enrolled
      ? await unlockLedgerPhoneSeed(enrolled.phoneSeedBackup, prf, 'passkey-prf', enrolled.contract.context)
      : undefined
    return { spendingPhone, ...(ledgerSavingsSeed ? { ledgerSavingsSeed } : {}) }
  } catch (error) {
    spendingPhone?.fill(0)
    throw error
  } finally {
    zeroBytes(prf)
  }
}

export function signSavingsPsbt(psbtHex: string, priv: Uint8Array): string {
  if (priv.length !== 32) throw new Error('private key must be 32 bytes')
  const tx = Transaction.fromPSBT(hex.decode(psbtHex), TX_OPTS)
  if (tx.inputsLength < 1) throw new Error('Savings spend needs an input')
  tx.sign(priv)
  return hex.encode(tx.toPSBT())
}

export function psbtHexToBase64(psbtHex: string): string {
  const bytes = hex.decode(parseIncomingPsbt(psbtHex))
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function psbtFile(psbtHex: string, name = 'arkade-savings.psbt'): File {
  const bytes = hex.decode(parseIncomingPsbt(psbtHex))
  return new File([bytes as BlobPart], name, { type: 'application/octet-stream' })
}

export async function readPsbtFile(file: Blob, maxBytes = 1_000_000): Promise<string> {
  if (file.size < 1 || file.size > maxBytes) throw new Error('PSBT file must be smaller than 1 MB')
  const body =
    typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(new Error('could not read PSBT file'))
          reader.onload = () =>
            reader.result instanceof ArrayBuffer
              ? resolve(reader.result)
              : reject(new Error('could not read PSBT file'))
          reader.readAsArrayBuffer(file)
        })
  const psbt = parseIncomingPsbt(hex.encode(new Uint8Array(body)))
  inspectSavingsPsbt(psbt)
  return psbt
}

export function parseIncomingPsbt(raw: string): string {
  const compact = String(raw || '')
    .trim()
    .replace(/\s+/g, '')
  if (!compact) throw new Error('psbt required')
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0) return compact.toLowerCase()
  try {
    const bin = atob(compact)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return hex.encode(out)
  } catch {
    throw new Error('not a PSBT')
  }
}

export function finalizeSavingsPsbt(psbtHex: string): { txHex: string; txid: string } {
  const tx = Transaction.fromPSBT(hex.decode(psbtHex), TX_OPTS)
  tx.finalize()
  const raw = tx.extract()
  return { txHex: hex.encode(raw), txid: tx.id }
}

export function inspectSavingsPsbt(psbtHex: string) {
  const tx = Transaction.fromPSBT(hex.decode(psbtHex), TX_OPTS)
  if (tx.inputsLength < 1) throw new Error('Savings spend needs an input')
  if (tx.outputsLength < 1 || tx.outputsLength > 2) throw new Error('unexpected savings outputs')
  const inputs = Array.from({ length: tx.inputsLength }, (_, index) => {
    const current = tx.getInput(index)
    if (!current.txid || current.index === undefined || !current.witnessUtxo) {
      throw new Error('incomplete Savings input')
    }
    return {
      txid: hex.encode(current.txid),
      vout: current.index,
      value: Number(current.witnessUtxo.amount),
      script: hex.encode(current.witnessUtxo.script),
      tapInternalKey: current.tapInternalKey ? hex.encode(current.tapInternalKey) : '',
      tapLeafScript: (current.tapLeafScript || []).map(([control, script]) => ({
        version: control.version,
        internalKey: hex.encode(control.internalKey),
        merklePath: control.merklePath.map((node) => hex.encode(node)),
        script: hex.encode(script),
      })),
      sequence: current.sequence,
      sigs: (current.tapScriptSig || []).length,
    }
  })
  const outputs = Array.from({ length: tx.outputsLength }, (_, index) => {
    const current = tx.getOutput(index)
    if (current.amount === undefined || !current.script) throw new Error('incomplete Savings output')
    return { amount: Number(current.amount), script: hex.encode(current.script) }
  })
  return {
    inputs,
    outputs,
    fee:
      inputs.reduce((sum, current) => sum + current.value, 0) -
      outputs.reduce((sum, current) => sum + current.amount, 0),
  }
}

export function requireSavingsPsbtIntent(
  psbtHex: string,
  destAddress: string,
  amountSats: number,
  feeSats: number,
  network: string,
  minimumSignatures = 1,
) {
  const inspected = inspectSavingsPsbt(psbtHex)
  const destination = inspected.outputs[0]
  if (destination.amount !== amountSats) throw new Error('signed amount does not match')
  if (destination.script !== scriptHexFromAddress(destAddress, network)) {
    throw new Error('signed destination does not match')
  }
  if (inspected.fee !== feeSats || inspected.fee < 0) throw new Error('signed fee does not match')
  if (inspected.inputs.some((current) => current.sigs < minimumSignatures)) {
    throw new Error('this device did not sign every Savings input')
  }
}

export function requireSameSavingsIntent(
  unsignedHex: string,
  signedHex: string,
  destAddress: string,
  amountSats: number,
  network: string,
  phonePub: string,
  hardwarePub: string,
) {
  return requireSameNativeSavingsIntent(unsignedHex, signedHex, destAddress, amountSats, network, () => ({
    phonePub,
    hardwarePub,
  }))
}

export function requireSameNativeSavingsIntent(
  unsignedHex: string,
  signedHex: string,
  destAddress: string,
  amountSats: number,
  network: string,
  signersForInput: (inputIndex: number) => { phonePub: string; hardwarePub: string },
) {
  const beforeTx = Transaction.fromPSBT(hex.decode(unsignedHex), TX_OPTS)
  const afterTx = Transaction.fromPSBT(hex.decode(signedHex), TX_OPTS)
  if (hex.encode(beforeTx.unsignedTx) !== hex.encode(afterTx.unsignedTx)) {
    throw new Error('signed PSBT changed the unsigned Savings transaction')
  }
  const before = inspectSavingsPsbt(unsignedHex)
  const after = inspectSavingsPsbt(signedHex)
  const unsignedInputs = before.inputs.map((current) => ({ ...current, sigs: 0 }))
  const signedInputs = after.inputs.map((current) => ({ ...current, sigs: 0 }))
  if (JSON.stringify(unsignedInputs) !== JSON.stringify(signedInputs)) {
    throw new Error('signed PSBT changed a Savings input')
  }
  if (JSON.stringify(before.outputs) !== JSON.stringify(after.outputs) || before.fee !== after.fee || after.fee < 0) {
    throw new Error('signed PSBT changed an output or fee')
  }
  const destination = after.outputs[0]
  if (destination.amount !== amountSats) throw new Error('signed amount does not match')
  const want = scriptHexFromAddress(destAddress, network)
  if (destination.script !== want) throw new Error('signed destination does not match')
  for (let index = 0; index < afterTx.inputsLength; index++) {
    const { phonePub, hardwarePub } = signersForInput(index)
    requireExactDefaultTapscriptSignatures(beforeTx, index, [phonePub])
    requireExactDefaultTapscriptSignatures(afterTx, index, [phonePub, hardwarePub])
    const returned = new Set(tapscriptSignatureRecords(afterTx, index))
    if (tapscriptSignatureRecords(beforeTx, index).some((record) => !returned.has(record))) {
      throw new Error('hardware changed the phone Savings signature')
    }
  }
}
