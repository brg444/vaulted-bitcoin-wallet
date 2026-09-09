import { mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { hex } from '@scure/base'
import { requireReleaseNetwork } from '../../src/lib/vault/releaseNetwork'
import {
  inspectLedgerSpendingRecovery,
  signLedgerSpendingRecoveryWithSeed,
} from '../../src/lib/vault/vtxo/ledgerSpendingRecovery'
import { validateLedgerOfflineRequest, type LedgerOfflineRequest } from '../../src/lib/vault/vtxo/ledgerOfflineRequest'
import { inspectLedgerRecoveryFee, signLedgerRecoveryFeeWithSeed } from '../../src/lib/vault/vtxo/ledgerRecoveryFee'

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
let request: LedgerOfflineRequest | undefined
let signed: string | undefined
let busy = false
let epoch = 0
function clearSecrets() {
  el<HTMLTextAreaElement>('mnemonic').value = ''
  el<HTMLInputElement>('passphrase').value = ''
  el<HTMLInputElement>('accept').checked = false
}
function requireOffline() {
  if (navigator.onLine !== false) throw new Error('Disconnect every network before entering a Ledger seed.')
  if (navigator.serviceWorker?.controller)
    throw new Error('Open this standalone page in a browser without an active service worker.')
}
function error(e: unknown) {
  el('error').textContent = e instanceof Error ? e.message : 'Offline recovery failed'
}
el<HTMLInputElement>('request-file').onchange = async () => {
  epoch++
  clearSecrets()
  request = undefined
  signed = undefined
  el('secret').hidden = true
  el('download').hidden = true
  el('review').hidden = true
  el('error').textContent = ''
  el('status').textContent = ''
  try {
    const file = el<HTMLInputElement>('request-file').files?.[0]
    if (!file || file.size > 32_000_000) throw new Error('Choose an offline request smaller than 32 MB')
    const parsed = validateLedgerOfflineRequest(JSON.parse(await file.text()))
    request = parsed
    if (parsed.name === 'vaulted-ledger-offline-spending') {
      requireReleaseNetwork(parsed.request.descriptor.network)
      const view = inspectLedgerSpendingRecovery(parsed.request)
      el('review').textContent =
        `${parsed.request.descriptor.network} · ${parsed.role} account\nDestination: ${view.destination}\nReceive: ${view.amountSats} sats\nNetwork fee: ${view.feeSats} sats\nInput: ${parsed.request.coin.txid}:${parsed.request.coin.vout}\nEnrolled fingerprint: ${parsed.request.descriptor.ledgerSavings.context[parsed.role]!.fingerprint}\nRequired keys: ${view.requiredKeys.map((k) => k.role).join(' and ')}`
    } else {
      requireReleaseNetwork(parsed.request.file.archive.status.network)
      const view = inspectLedgerRecoveryFee(parsed.request)
      el('review').textContent =
        `${parsed.request.file.archive.status.network} · ${parsed.request.role} fee account\nRecovered funds destination: ${parsed.request.file.exitPackage.sweepAddress}\nNetwork fee: ${view.feeSats} sats\nFee change: ${view.changeSats} sats to ${view.feeAddress}\nRecovery parent: ${parsed.request.parentTxid}\nOnly the selected account's fee inputs will be signed.`
    }
    el('review').hidden = false
  } catch (e) {
    error(e)
  }
}
el('offline').onclick = () => {
  clearSecrets()
  el('secret').hidden = true
  el('error').textContent = ''
  try {
    if (!request) throw new Error('Load and review the saved request first')
    requireOffline()
    el('secret').hidden = false
  } catch (e) {
    error(e)
  }
}
el('sign').onclick = async () => {
  if (busy) return
  busy = true
  signed = undefined
  el('download').hidden = true
  el('error').textContent = ''
  let seed: Uint8Array | undefined
  try {
    requireOffline()
    if (!request || !el<HTMLInputElement>('accept').checked)
      throw new Error('Review the request and accept the seed exposure before signing')
    const snapshot = structuredClone(request)
    const started = epoch
    const words = el<HTMLTextAreaElement>('mnemonic').value.trim().normalize('NFKD').split(/\s+/).join(' ')
    if (!validateMnemonic(words, wordlist)) throw new Error('Enter valid English BIP39 seed words')
    const passphrase = el<HTMLInputElement>('passphrase').value
    clearSecrets()
    seed = await mnemonicToSeed(words, passphrase)
    requireOffline()
    if (started !== epoch || !request || JSON.stringify(request) !== JSON.stringify(snapshot))
      throw new Error('The recovery request or offline connection changed')
    signed =
      snapshot.name === 'vaulted-ledger-offline-spending'
        ? signLedgerSpendingRecoveryWithSeed(snapshot.request, seed, snapshot.psbt, snapshot.role)
        : signLedgerRecoveryFeeWithSeed(snapshot.request, seed, snapshot.psbt)
    el('status').textContent =
      'The signed PSBT is ready. Seed inputs are cleared. Download it, close this page, then return it to the recovery companion.'
    el('download').hidden = false
  } catch (e) {
    error(e)
  } finally {
    seed?.fill(0)
    clearSecrets()
    el('secret').hidden = true
    busy = false
  }
}
el('clear').onclick = clearSecrets
el('download').onclick = () => {
  if (!signed) return
  const url = URL.createObjectURL(new Blob([Uint8Array.from(hex.decode(signed))], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'Vaulted Ledger recovery signed.psbt'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
window.addEventListener('online', () => {
  epoch++
  clearSecrets()
  el('secret').hidden = true
  error(new Error('Network reconnected. Seed inputs were cleared.'))
})
window.addEventListener('pagehide', () => {
  clearSecrets()
  signed = undefined
  request = undefined
})
