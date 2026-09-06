import { extractRecoveryKitJson } from '../offline-recovery/src/lib/vault/program/kitBundle'
import {
  getNetwork,
  Transaction,
  SingleKey,
  OnchainWallet,
  EsploraProvider,
  ReadonlySingleKey,
  type Identity,
} from '@arkade-os/sdk'
import { p2tr } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  parseRecoveryKit as parsePublicKit,
  kitHasUnlock,
  type RecoveryKit as PublicKit,
} from '../offline-recovery/src/lib/vault/program/kit'
import { buildRecoveryKit, type RecoveryKit } from '../../src/lib/vault/program/kit'
import {
  openLocalRecoveryBackup,
  validateVaultRecoveryFile,
  type VaultRecoveryFile,
} from '../../src/lib/vault/recovery/backupCodec'
import { openLocalLightBackup, parseLightEncryptedBackup } from '../../src/lib/vault/light/backupCodec'
import { lightRecoveryStatus } from '../../src/lib/vault/light/status'
import {
  prepareLightRecoveryWithOwner,
  validateLightRecoveryFile,
  executeLightRecoveryWithOwner,
  requireConfirmedLightRecovery,
  type LightRecoveryFile,
} from '../../src/lib/vault/light/recovery'
import { unlockLightWithPasskey } from '../../src/lib/vault/light/passkey'
import { unlockPhoneBip340 } from '../../src/lib/vault/savingsSpend'
import {
  prepareSavingsRecovery,
  validateSavingsRecovery,
  executeSavingsRecovery,
  type SavingsRecoveryFile,
  type SavingsRecoveryPath,
  type SavingsRecoveryChain,
} from '../../src/lib/vault/program/onchainRecovery'
import {
  prepareVaultSpendingRecovery,
  validateSpendingRecoveryPackage,
  executeVaultSpendingRecovery,
  type SpendingRecoveryPackage,
} from '../../src/lib/vault/vtxo/spendingRecovery'
import {
  prepareBoardingRecoveryFile,
  validateBoardingRecoveryFile,
  executeBoardingRecoveryFile,
  type BoardingRecoveryFile,
  type BoardingRecoverySource,
} from '../../src/lib/vault/vtxo/boardingRecoveryFile'
import {
  validateConnectorRecoveryFile,
  connectorRecoveryHandoff,
  acceptConnectorRecoverySignature,
  executeConnectorRecovery,
  type ConnectorRecoveryFile,
} from '../../src/lib/vault/program/connectorRecovery'
import {
  prepareLightningRecovery,
  validateLightningRecoveryPackage,
  executeLightningRecovery,
  type LightningRecoveryPackage,
} from '../../src/lib/vault/recovery/lightningRecovery'
import { recoveryLightningBinding } from '../../src/lib/vault/recovery/journals'
import {
  acceptRecoveryPsbtSignatures,
  recoveryPsbtBytes,
  recoveryPsbtHasAllSignatures,
} from '../../src/lib/vault/recovery/signatureImport'
import { familyFromDescriptor } from '../../src/lib/vault/program/descriptor'
import { CONNECTOR_TEMPLATE } from '../../src/lib/vault/program/connector'
import { requireReleaseNetwork } from '../../src/lib/vault/releaseNetwork'
import { networkPins } from '../../src/lib/vault/networkPins'
import { readBounded } from '../../src/lib/vault/bounded'
import { allowPasskey, passkeyGetOptions, prfExtension, prfFrom } from '../../src/lib/vault/webauthn'
import { PRF_SALT, unwrapPhoneSecret } from '../../src/lib/vault/prfEnvelope'

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const value = (id: string) => el<HTMLInputElement>(id).value.trim()
const bitcoin = new EsploraProvider('/esplora')
type Source = { full?: VaultRecoveryFile; light?: LightRecoveryFile; publicKit?: PublicKit; originalKit?: unknown }
type Prepared =
  | SavingsRecoveryFile
  | SpendingRecoveryPackage
  | BoardingRecoveryFile
  | ConnectorRecoveryFile
  | LightningRecoveryPackage
  | LightRecoveryFile
type Draft = {
  name: 'vaulted-recovery-signing'
  version: 1
  source: Source
  program: string
  destination: string
  feeSats: number
  feeRate: number
  coin?: Coin
  signatures: Record<string, string>
}
type Coin = { txid: string; vout: number; value: number; script: string; parentHex: string }
let source: Source = {},
  raw: unknown,
  prepared: Prepared | undefined,
  draft: Draft | undefined,
  coins: Coin[] = [],
  controller: AbortController | undefined
let request:
  | { psbt: string; keys: { role: string; publicKey: string }[]; resolve: (psbt: string) => void; key: string }
  | undefined
let busy = false
function error(err: unknown) {
  el('error').textContent = err instanceof Error ? err.message : String(err)
}
async function run(work: () => Promise<void>) {
  if (busy) return
  busy = true
  el('error').textContent = ''
  document
    .querySelectorAll<HTMLButtonElement>('button:not(.sign-control):not(#stop)')
    .forEach((b) => (b.disabled = true))
  try {
    await work()
  } catch (err) {
    error(err)
  } finally {
    busy = false
    document.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = false))
  }
}
function save(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: 'application/json' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function status() {
  return source.full?.header.status || (source.light ? lightRecoveryStatus(source.light.descriptor) : undefined)
}
function kit(): RecoveryKit {
  const d = source.full?.header.kit.descriptor || source.publicKit?.descriptor
  if (!d) throw new Error('This path needs the saved Savings descriptor')
  return buildRecoveryKit(d)
}
function network() {
  const n = status()?.network || source.publicKit?.descriptor.network
  if (!n) throw new Error('Open a recovery file first')
  requireReleaseNetwork(n)
  return n
}
function keys() {
  if (source.light) return [{ role: 'phone', publicKey: `02${source.light.descriptor.ownerPub}` }]
  const k = kit().descriptor.keys
  return [
    { role: 'phone', publicKey: k.phoneBip340 },
    { role: 'hardware', publicKey: k.hardware },
    ...(k.recovery ? [{ role: 'recovery', publicKey: k.recovery }] : []),
  ]
}
function feeLimits() {
  if (source.light) {
    const p = source.light.descriptor.spendingPolicy
    return { absoluteFeeCapSats: p.absoluteFeeCapSats, feerateCapSatVb: p.feerateCapSatPerV }
  }
  return kit().descriptor.policy
}
async function phone(): Promise<Uint8Array> {
  if (source.full) return unlockPhoneBip340(source.full.header.enrollment, source.full.header.status)
  if (source.light) return unlockLightWithPasskey(source.light)
  const saved = source.publicKit
  if (!saved || !kitHasUnlock(saved) || !saved.unlock)
    throw new Error('This public kit has no passkey envelope; use an encrypted archive or a version 4 kit')
  if (location.origin !== saved.clientOrigin || location.hostname !== saved.rpId)
    throw new Error(`Open this page at ${saved.clientOrigin} for the original passkey`)
  const id = Uint8Array.from(hex.decode(saved.unlock.credId))
  const credential = (await navigator.credentials.get({
    publicKey: passkeyGetOptions({
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: saved.rpId,
      userVerification: 'required',
      allowCredentials: [allowPasskey(id)],
      extensions: prfExtension(PRF_SALT, id),
    }),
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey cancelled')
  const prf = prfFrom(credential)
  if (!prf) throw new Error('Original passkey PRF required')
  try {
    const key = await unwrapPhoneSecret(prf, saved.unlock.nonce, saved.unlock.ciphertext)
    if (hex.encode(schnorr.getPublicKey(key)) !== saved.descriptor.keys.phoneBip340.slice(2)) {
      key.fill(0)
      throw new Error('Passkey key differs from the kit')
    }
    return key
  } finally {
    prf.fill(0)
  }
}
function select(id: string, options: { value: string; label: string }[]) {
  const node = el<HTMLSelectElement>(id)
  node.replaceChildren(
    ...options.map((o) => {
      const x = document.createElement('option')
      x.value = o.value
      x.textContent = o.label
      return x
    }),
  )
}
function review() {
  network()
  el('review').hidden = false
  el('prepared').hidden = !prepared
  const k = source.full?.header.kit || source.publicKit
  el('facts').textContent =
    `${source.light ? 'Light' : k?.protectionTier} · ${network()} · ${status()?.vaultId || k?.descriptor.vaultId}`
  el('coverage').textContent = source.full
    ? `Saved ${source.full.archive.spending.capturedAt}. Includes Spending, boarding, Savings states and saved payment journals.`
    : source.light
      ? `Saved ${source.light.createdAt}. The archive covers its saved Spending and Lightning lockup paths.`
      : `${(source.originalKit as { name?: string })?.name === 'arkade-connector-enrollment' ? 'Connector enrollment kit' : `Recovery Kit version ${(source.originalKit as { version?: number })?.version || k?.version}`}. Public transaction scripts are verified independently; offchain Spending needs a complete archive. ${k && kitHasUnlock(k as PublicKit) ? 'This file can unlock the phone key with its original passkey.' : ''}`
  const options: { value: string; label: string }[] = []
  if (source.full || source.light) options.push({ value: 'spending', label: 'Spending — unilateral Bitcoin exit' })
  if (source.full || source.publicKit?.boarding)
    options.push({ value: 'boarding', label: 'Boarding — phone recovery after its delay' })
  if (k) {
    if (k.descriptor.templateVersion !== CONNECTOR_TEMPLATE)
      options.push({ value: 'savings-admin', label: 'Savings — phone and hardware' })
    for (const claimant of ['phone', 'hardware', 'recovery'] as const)
      if (k.descriptor.pending[`savings-${claimant}`]) {
        options.push(
          { value: `pending-claim:${claimant}`, label: `Pending ${claimant} recovery — claim after its delay` },
          { value: `quarantine:${claimant}`, label: `Quarantine after ${claimant} recovery — remaining keys` },
        )
        if (familyFromDescriptor(k.descriptor).pending[`savings-${claimant}`].guardianExit)
          options.push({
            value: `pending-cancel:${claimant}`,
            label: `Pending ${claimant} recovery — remaining-key cancellation`,
          })
      }
  }
  const journal = source.full?.lightningJournal || source.light?.lightningJournal
  for (const entry of journal?.entries || [])
    options.push({
      value: `lightning:${entry.record.rfqId}`,
      label: `Lightning refund — ${entry.record.rfqId.slice(0, 12)}`,
    })
  if (source.full?.connectorJournal?.pending)
    options.push({ value: 'connector', label: 'Saved connector payment — resume exact approval' })
  select('program', options)
  select(
    'fee-key',
    keys().map((k) => ({ value: k.role, label: k.role === 'phone' ? 'Original passkey' : `${k.role} signing device` })),
  )
  coins = source.full?.archive.onchain || []
  paintCoins()
  el('fee-key').onchange = () => void funding()
  el<HTMLSelectElement>('program').onchange = programChanged
  programChanged()
}
function paintCoins() {
  const program = value('program')
  let script: string | undefined
  if (program === 'boarding')
    script = source.full?.header.status.vtxoBoardingDescriptor?.script || source.publicKit?.boarding?.script
  else if (program === 'savings-admin') script = kit().descriptor.savings.script
  else if (program.startsWith('pending-') || program.startsWith('quarantine:')) {
    const [path, role] = program.split(':')
    const d = kit().descriptor
    script = (path === 'quarantine' ? d.quarantine : d.pending)[`savings-${role}` as keyof typeof d.pending]?.script
  }
  select(
    'coin',
    coins.flatMap((c, i) =>
      !script || c.script === script
        ? [{ value: String(i), label: `${c.value} sats · ${c.txid.slice(0, 12)}:${c.vout}` }]
        : [],
    ),
  )
}
function programChanged() {
  const program = value('program')
  el('fee-label').hidden =
    program === 'spending' || program === 'boarding' || program === 'connector' || program.startsWith('lightning:')
  el('coin-label').hidden = program === 'spending' || program === 'connector' || program.startsWith('lightning:')
  el('scan').hidden =
    Boolean(source.light) || program === 'spending' || program.startsWith('lightning:') || program === 'connector'
  el<HTMLInputElement>('destination').disabled = program === 'boarding' || program === 'connector'
  if (program === 'boarding')
    el<HTMLInputElement>('destination').value = p2tr(
      hex.decode(keys().find((k) => k.role === 'phone')!.publicKey).slice(1),
      undefined,
      getNetwork(networkPins(network()).sdkNetwork),
    ).address!
  if (program === 'spending' && source.full?.header.kit.protectionTier === 'advanced')
    el<HTMLSelectElement>('fee-key').value = 'hardware'
  paintCoins()
  void funding()
}

async function funding() {
  const role = value('fee-key')
  const key = keys().find((k) => k.role === role)
  if (!key) return
  const address = p2tr(
    hex.decode(key.publicKey).slice(1),
    undefined,
    getNetwork(networkPins(network()).sdkNetwork),
  ).address!
  el('funding').textContent = `Separate Bitcoin fee funding address: ${address}`
}
const chain: SavingsRecoveryChain = {
  status: async (id) => {
    const s = await bitcoin.getTxStatus(id)
    return { confirmed: s.confirmed, blockHeight: s.confirmed ? s.blockHeight : undefined }
  },
  tipHeight: async () => Number(await readBounded(await fetch('/esplora/blocks/tip/height'), 64)),
  outspend: async (id, vout) => {
    const r = await fetch(`/esplora/tx/${id}/outspend/${vout}`)
    if (!r.ok) throw new Error('Bitcoin spend status unavailable')
    return JSON.parse(await readBounded(r, 10000))
  },
  broadcast: (raw) => bitcoin.broadcastTransaction(raw),
}
async function requestSignature(psbt: string, required: { role: string; publicKey: string }[]) {
  const tx = Transaction.fromPSBT(recoveryPsbtBytes(psbt), { allowUnknownInputs: true, allowUnknownOutputs: true })
  const key = hex.encode(tx.unsignedTx)
  const previous = draft?.signatures[key]
  if (previous) {
    psbt = acceptRecoveryPsbtSignatures(
      psbt,
      previous,
      required.map((k) => k.publicKey),
    )
    if (
      recoveryPsbtHasAllSignatures(
        psbt,
        required.map((k) => k.publicKey),
      )
    )
      return psbt
  }
  el('review').hidden = true
  el('prepared').hidden = true
  el('signature').hidden = false
  el('sign-error').textContent = ''
  el('psbt').textContent = psbt
  el<HTMLTextAreaElement>('psbt').value = psbt
  el('signers').textContent = `Required keys: ${required.map((k) => `${k.role} (${k.publicKey})`).join(', ')}`
  el('signing-summary').textContent =
    `Transaction ${tx.id}\n${tx.inputsLength} inputs; ${tx.outputsLength} outputs. Review the destination and amount on your signing device.`
  return new Promise<string>((resolve) => {
    request = { psbt, keys: required, resolve, key }
  })
}
async function signatureAction(action: () => Promise<void>) {
  el('sign-error').textContent = ''
  try {
    await action()
  } catch (err) {
    el('sign-error').textContent = err instanceof Error ? err.message : String(err)
  }
}
el('accept-signature').onclick = () =>
  void signatureAction(async () => {
    if (!request) throw new Error('No signing request')
    request.psbt = acceptRecoveryPsbtSignatures(
      request.psbt,
      value('signed'),
      request.keys.map((k) => k.publicKey),
    )
    el<HTMLTextAreaElement>('psbt').value = request.psbt
    el<HTMLTextAreaElement>('signed').value = ''
    if (draft) draft.signatures[request.key] = request.psbt
  })
el('sign-phone').onclick = () =>
  void signatureAction(async () => {
    if (!request || !request.keys.some((k) => k.role === 'phone'))
      throw new Error('This transaction does not request the phone key')
    const key = await phone()
    try {
      const tx = Transaction.fromPSBT(recoveryPsbtBytes(request.psbt), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      })
      const signed = await SingleKey.fromPrivateKey(key).sign(tx)
      request.psbt = acceptRecoveryPsbtSignatures(
        request.psbt,
        hex.encode(signed.toPSBT()),
        request.keys.map((k) => k.publicKey),
      )
      el<HTMLTextAreaElement>('psbt').value = request.psbt
      if (draft) draft.signatures[request.key] = request.psbt
    } finally {
      key.fill(0)
    }
  })
el('finish-signing').onclick = () => {
  if (!request) return
  if (
    !recoveryPsbtHasAllSignatures(
      request.psbt,
      request.keys.map((k) => k.publicKey),
    )
  ) {
    el('sign-error').textContent = 'Every required key must sign before continuing'
    return
  }
  const pending = request
  request = undefined
  el('signature').hidden = true
  pending.resolve(pending.psbt)
}
el('save-signing').onclick = () => {
  if (draft) save('Vaulted recovery signing.json', draft)
  if (request) save('Vaulted signing request.psbt', request.psbt)
}
async function prepare() {
  if (!draft)
    draft = {
      name: 'vaulted-recovery-signing',
      version: 1,
      source,
      program: value('program'),
      destination: value('destination'),
      feeSats: Number(value('fee')),
      feeRate: (await bitcoin.getFeeRate()) || 1,
      coin: coins[Number(value('coin'))],
      signatures: {},
    }
  const d = draft!
  const provider = new Proxy(bitcoin, {
    get: (target, key) =>
      key === 'getFeeRate'
        ? async () => d.feeRate
        : typeof Reflect.get(target, key) === 'function'
          ? Reflect.get(target, key).bind(target)
          : Reflect.get(target, key),
  })
  if (d.program === 'spending') {
    if (source.full)
      prepared = await prepareVaultSpendingRecovery(
        source.full.archive,
        d.destination,
        (r) => requestSignature(r.psbt, r.requiredKeys),
        provider,
      )
    else if (source.light) {
      const key = await phone()
      try {
        prepared = await prepareLightRecoveryWithOwner(source.light, key, d.destination, source.light.archive, true)
      } finally {
        key.fill(0)
      }
    }
  } else if (d.program === 'boarding') {
    if (!d.coin || (!source.full && !source.publicKit?.boarding)) throw new Error('Select a saved boarding output')
    const archive: BoardingRecoverySource = source.full?.archive || {
      name: 'vaulted-public-boarding-data',
      version: 1,
      kit: kit(),
      descriptor: source.publicKit!.boarding!,
      onchain: coins.filter((coin) => coin.script === source.publicKit!.boarding!.script),
    }
    const key = await phone()
    try {
      prepared = await prepareBoardingRecoveryFile(archive, d.coin, key, provider)
    } finally {
      key.fill(0)
    }
  } else if (d.program === 'connector') {
    if (!source.full?.connectorJournal?.pending) throw new Error('No saved connector operation')
    let file: ConnectorRecoveryFile = {
      name: 'vaulted-connector-recovery',
      version: 1,
      header: source.full.header,
      record: source.full.connectorJournal.pending,
    }
    if (!file.record.signedTxHex) {
      const psbt = connectorRecoveryHandoff(file)
      const signed = await requestSignature(
        psbt,
        keys().filter((k) => k.role === 'hardware'),
      )
      file = acceptConnectorRecoverySignature(file, signed)
    }
    prepared = file
  } else if (d.program.startsWith('lightning:')) {
    const journal = source.full?.lightningJournal || source.light?.lightningJournal
    const entry = journal?.entries.find((e) => e.record.rfqId === d.program.slice(10))
    if (!entry || !status()) throw new Error('Saved Lightning lockup is missing')
    prepared = await prepareLightningRecovery(
      entry,
      recoveryLightningBinding(status()!),
      d.destination,
      (r) => requestSignature(r.psbt, [{ role: 'phone', publicKey: r.publicKey }]),
      feeLimits(),
      provider,
    )
  } else {
    if (!d.coin) throw new Error('Choose a Bitcoin output')
    const [program, claimant] = d.program.split(':')
    const path = (claimant ? { program, claimant } : { program }) as SavingsRecoveryPath
    let file = prepareSavingsRecovery({
      kit: kit(),
      path,
      parentHex: d.coin.parentHex,
      vout: d.coin.vout,
      destination: d.destination,
      feeSats: d.feeSats,
    })
    const facts = validateSavingsRecovery(file)
    const signed = await requestSignature(
      file.psbt,
      facts.signers.map((role) => keys().find((k) => k.role === role)!),
    )
    // Imported PSBT signatures are already verified against every allowed role.
    file = { ...file, psbt: signed }
    if (!validateSavingsRecovery(file).complete) throw new Error('Every required recovery key must sign')
    prepared = file
  }
  if (!prepared) throw new Error('Recovery preparation did not produce a file')
  if (prepared.name === 'vaulted-light-recovery' && !prepared.exitPackage)
    throw new Error('This archive has no Spending outputs to recover')
  paintPrepared()
  el('status').textContent = 'Recovery prepared. Save the file before starting.'
}
function paintPrepared() {
  if (!prepared) return
  el('review').hidden = true
  el('signature').hidden = true
  el('prepared').hidden = false
  const p = prepared
  let details: string
  if ('exitPackage' in p && p.exitPackage) {
    const totals = p.exitPackage.totals
    details = `Bitcoin destination: ${p.exitPackage.sweepAddress}\nSweep value: ${totals.recoveredSats} sats\nEstimated recovery fee: ${totals.totalFeeSats} sats`
  } else if ('record' in p) {
    details = `Bitcoin destination: ${p.record.recipient}\nPayment: ${p.record.amountSats} sats\nTransaction: ${p.record.txid}`
  } else if (p.name === 'vaulted-savings-recovery') {
    details = `Bitcoin destination: ${p.destination}\nNetwork fee: ${p.feeSats} sats\nRecovery path: ${p.path.program}${'claimant' in p.path ? ` (${p.path.claimant})` : ''}`
  } else if (p.name === 'vaulted-boarding-recovery') {
    const view = validateBoardingRecoveryFile(p)
    details = `Bitcoin destination: ${view.destination}\nNetwork fee: ${view.fee} sats\nRequired delay: ${view.descriptor.exitDelay} seconds`
  } else details = 'The saved transaction paths are validated and ready to resume.'
  el('details').textContent = details
  const needsFeeWallet = p.name === 'vaulted-spending-recovery' || p.name === 'vaulted-lightning-refund'
  el('fee-key-label').hidden = !needsFeeWallet
  el('funding').hidden = !needsFeeWallet && p.name !== 'vaulted-light-recovery'
  if (p.name === 'vaulted-light-recovery')
    el('funding').textContent = `Separate Bitcoin fee funding address: ${p.feeFundingAddress}`
  el('export-psbt').hidden = p.name === 'vaulted-light-recovery'
}
el('change-path').onclick = () => {
  prepared = undefined
  draft = undefined
  review()
}

el('prepare').onclick = () =>
  void run(async () => {
    draft = undefined
    await prepare()
  })
el('scan').onclick = () =>
  void run(async () => {
    const k = kit()
    const trees = [
      k.descriptor.savings,
      ...Object.values(k.descriptor.pending),
      ...Object.values(k.descriptor.quarantine),
      ...(source.full
        ? [source.full.header.status.vtxoBoardingDescriptor!]
        : source.publicKit?.boarding
          ? [source.publicKit.boarding]
          : []),
    ]
    const found = new Map(coins.map((c) => [`${c.txid}:${c.vout}`, c]))
    for (const tree of trees)
      for (const coin of await bitcoin.getCoins(tree.address)) {
        const response = await fetch(`/esplora/tx/${coin.txid}/hex`)
        if (!response.ok) throw new Error('Bitcoin parent unavailable')
        const parentHex = await readBounded(response, 8_000_000)
        const tx = Transaction.fromRaw(hex.decode(parentHex.trim()), {
          allowUnknownInputs: true,
          allowUnknownOutputs: true,
        })
        const output = tx.getOutput(coin.vout)
        if (tx.id !== coin.txid || hex.encode(output.script!) !== tree.script || Number(output.amount) !== coin.value)
          throw new Error('Bitcoin parent changed')
        found.set(`${coin.txid}:${coin.vout}`, { ...coin, script: tree.script, parentHex: parentHex.trim() })
      }
    coins = [...found.values()]
    paintCoins()
    el('status').textContent =
      `${coins.length} Bitcoin outputs retained. Previous outputs remain until their spend is checked.`
  })
el('save').onclick = () => {
  if (prepared)
    save('Vaulted prepared recovery.json', { name: 'vaulted-recovery-action', version: 1, source, prepared })
}
el('export-psbt').onclick = () => {
  if (!prepared) return
  if ('psbt' in prepared) save('Vaulted recovery.psbt', prepared.psbt)
  else if ('sweeps' in prepared) prepared.sweeps.forEach((raw, i) => save(`Vaulted sweep ${i + 1}.psbt`, raw))
  else if (prepared.name === 'vaulted-connector-recovery')
    save('Vaulted connector.psbt', connectorRecoveryHandoff(prepared))
}
async function load(data: unknown) {
  const x = data as { name?: string; version?: number; source?: Source; prepared?: Prepared }
  prepared = undefined
  draft = undefined
  source = {}
  raw = data
  el('signature').hidden = true
  el('open').hidden = true
  if (x.name === 'vaulted-recovery-backup' || x.name === 'vaulted-light-backup') {
    const header = (data as any).header
    const n = header.binding?.network || header.descriptor.network
    requireReleaseNetwork(n)
    el('origin').textContent = `Use your original passkey at ${header.origin}`
    el('open').hidden = false
    el('review').hidden = true
    el('prepared').hidden = true
    return
  }
  if (x.name === 'vaulted-recovery-action') {
    source = x.source!
    prepared = x.prepared!
    validateSource()
    validatePrepared()
    review()
    paintPrepared()
    return
  }
  if (x.name === 'vaulted-recovery-signing') {
    draft = data as Draft
    source = draft.source
    validateSource()
    review()
    await prepare()
    return
  }
  if (x.name === 'vaulted-recovery') source.full = validateVaultRecoveryFile(data as VaultRecoveryFile)
  else if (x.name === 'vaulted-light-recovery') source.light = validateLightRecoveryFile(data)
  else {
    source.publicKit = parsePublicKit(data)
    source.originalKit = data
  }
  review()
}
function validateSource() {
  if ([source.full, source.light, source.publicKit].filter(Boolean).length !== 1)
    throw new Error('Recovery source must identify one wallet')
  if (source.full) validateVaultRecoveryFile(source.full)
  if (source.light) validateLightRecoveryFile(source.light)
  if (source.publicKit) source.publicKit = parsePublicKit(source.originalKit || source.publicKit)
  network()
}
function validatePrepared() {
  if (!prepared) throw new Error('Missing prepared transaction')
  switch (prepared.name) {
    case 'vaulted-spending-recovery':
      validateSpendingRecoveryPackage(prepared)
      if (prepared.archive.kit.descriptorHash !== kit().descriptorHash) throw new Error('Prepared wallet changed')
      break
    case 'vaulted-boarding-recovery':
      validateBoardingRecoveryFile(prepared)
      if (prepared.archive.kit.descriptorHash !== kit().descriptorHash) throw new Error('Prepared wallet changed')
      break
    case 'vaulted-savings-recovery':
      validateSavingsRecovery(prepared)
      if (prepared.kit.descriptorHash !== kit().descriptorHash) throw new Error('Prepared wallet changed')
      break
    case 'vaulted-connector-recovery':
      validateConnectorRecoveryFile(prepared)
      if (prepared.header.binding.descriptorHash !== source.full?.header.binding.descriptorHash)
        throw new Error('Prepared wallet changed')
      break
    case 'vaulted-lightning-refund':
      validateLightningRecoveryPackage(prepared, recoveryLightningBinding(status()!), feeLimits())
      break
    case 'vaulted-light-recovery':
      validateLightRecoveryFile(prepared)
      if (prepared.descriptor.vaultId !== source.light?.descriptor.vaultId) throw new Error('Prepared wallet changed')
      break
    default:
      throw new Error('Unknown recovery action')
  }
}
el<HTMLInputElement>('file').onchange = () =>
  void run(async () => {
    const f = el<HTMLInputElement>('file').files?.[0]
    if (!f || f.size > 32_000_000) throw new Error('Choose a recovery file smaller than 32 MB')
    await load(JSON.parse(extractRecoveryKitJson(new Uint8Array(await f.arrayBuffer()))))
  })
el('open').onclick = () =>
  void run(async () => {
    const name = (raw as { name?: string }).name
    if (name === 'vaulted-recovery-backup') source = { full: await openLocalRecoveryBackup(raw) }
    else {
      const parsed = parseLightEncryptedBackup(raw)
      source = { light: (await openLocalLightBackup(parsed)).file }
    }
    el('open').hidden = true
    review()
  })
el('stop').onclick = () => {
  controller?.abort()
  el('status').textContent = 'Recovery paused. Keep the prepared file.'
}
el('execute').onclick = () =>
  void run(async () => {
    validateSource()
    validatePrepared()
    const file = prepared!
    controller = new AbortController()
    el('stop').hidden = false
    el('events').textContent = ''
    // Persist the exact artifact before the first possible broadcast.
    save('Vaulted prepared recovery.json', { name: 'vaulted-recovery-action', version: 1, source, prepared: file })
    try {
      if (file.name === 'vaulted-savings-recovery') {
        el('status').textContent = JSON.stringify(await executeSavingsRecovery(file, chain))
        return
      }
      if (file.name === 'vaulted-connector-recovery') {
        el('status').textContent = JSON.stringify(await executeConnectorRecovery(file, chain))
        return
      }
      if (file.name === 'vaulted-light-recovery') {
        const key = await phone()
        try {
          await executeLightRecoveryWithOwner(file, key, controller.signal, (event) => {
            el('events').textContent += JSON.stringify(event) + '\n'
          })
        } finally {
          key.fill(0)
        }
        return
      }
      const role = value('fee-key'),
        key = keys().find((k) => k.role === role)!
      const readonly = ReadonlySingleKey.fromPublicKey(hex.decode(key.publicKey))
      const identity: Identity = {
        compressedPublicKey: () => readonly.compressedPublicKey(),
        xOnlyPublicKey: () => readonly.xOnlyPublicKey(),
        signMessage: async () => {
          throw new Error('Recovery cannot sign messages')
        },
        signerSession: () => {
          throw new Error('Recovery cannot create signing sessions')
        },
        sign: async (tx) =>
          Transaction.fromPSBT(recoveryPsbtBytes(await requestSignature(hex.encode(tx.toPSBT()), [key])), {
            allowUnknownInputs: true,
            allowUnknownOutputs: true,
          }),
      }
      const feeWallet = await OnchainWallet.create(identity, networkPins(network()).sdkNetwork, bitcoin)
      const executor =
        file.name === 'vaulted-spending-recovery'
          ? executeVaultSpendingRecovery(file, bitcoin, feeWallet, controller.signal)
          : file.name === 'vaulted-boarding-recovery'
            ? executeBoardingRecoveryFile(file, bitcoin, controller.signal)
            : executeLightningRecovery(
                file,
                recoveryLightningBinding(status()!),
                feeLimits(),
                bitcoin,
                feeWallet,
                controller.signal,
              )
      await requireConfirmedLightRecovery(executor.pkg, executor, (event) => {
        el('events').textContent += JSON.stringify(event) + '\n'
      })
      controller.signal.throwIfAborted()
      el('status').textContent = 'Recovery execution finished. Check the transaction confirmations above.'
    } finally {
      el('stop').hidden = true
      controller = undefined
      paintPrepared()
    }
  })
