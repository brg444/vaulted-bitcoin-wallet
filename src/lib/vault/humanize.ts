import { BitcoinPaymentError } from './bitcoinPaymentError'
import { ConnectorUserError } from './connectorError'
import { LightningPaymentError } from './lightningError'
import { isVaultConcurrencyUnavailableError } from './vtxo/lock'
import {
  isVtxoAbortFailedError,
  isVtxoLivePendingError,
  isVtxoReservedReplaceError,
  isVtxoSameSendInProgressError,
  isVtxoSpendInFlightError,
} from './vtxo/spend'

function nestedErrorMessages(err: unknown, seen = new Set<unknown>()): string[] {
  if (err == null || seen.has(err)) return []
  seen.add(err)
  const messages: string[] = []
  if (typeof err === 'string' && err.trim()) messages.push(err)
  if (err instanceof Error && err.message) messages.push(err.message)
  if (err instanceof Error && err.cause) messages.push(...nestedErrorMessages(err.cause, seen))
  if (err instanceof AggregateError) {
    for (const inner of err.errors) messages.push(...nestedErrorMessages(inner, seen))
  }
  return messages
}

const LEDGER_ENROLLMENT_MESSAGES: Readonly<Record<string, string>> = {
  'Finish or cancel the Ledger setup already in progress.': 'Finish or cancel the Ledger setup already in progress.',
  'Ledger Savings enrollment is not available on this deployment yet.':
    'This Guardian does not support Ledger Savings setup yet. Your passkey has not been created.',
  'Spending recovery key does not match the selected Ledger account':
    'The selected Ledger account does not match the recovery key. Import the intended public account again.',
  'Ledger recovery account does not match the selected protection':
    'The selected protection does not match your Ledger accounts. Review your hardware and recovery accounts.',
  'Guardian changed the selected Ledger Savings enrollment':
    'The returned vault does not match your selected Ledger setup. Setup has not completed.',
  'Ledger enrollment changed while completing setup':
    'The returned vault does not match your saved Ledger setup. Keep this browser data and retry the original setup.',
  'Staged Ledger enrollment changed':
    'The saved Ledger setup could not be verified. Keep this browser data and review the original setup.',
  'Ledger registration does not match this Savings wallet. Register the original policy again.':
    'The Ledger registration does not match this vault. Register the original Savings policy again.',
}

export function humanizeVaultError(err: unknown): string {
  if (err instanceof ConnectorUserError || err instanceof BitcoinPaymentError || err instanceof LightningPaymentError)
    return err.message
  const parts = nestedErrorMessages(err)
  const raw = parts[0] || (err instanceof Error ? err.message : String(err || 'Something went wrong'))
  if (Object.hasOwn(LEDGER_ENROLLMENT_MESSAGES, raw)) return LEDGER_ENROLLMENT_MESSAGES[raw]
  const name = err instanceof Error ? err.name.toLowerCase() : ''
  const msg = parts.join(' \n ').toLowerCase() || raw.toLowerCase()
  if (isVaultConcurrencyUnavailableError(err)) {
    return 'This browser can’t safely coordinate wallet activity. Update it or use a supported browser.'
  }
  if (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('load failed') ||
    msg.includes('vault service is not running') ||
    msg.includes('request failed (5') ||
    msg.includes('authorizer status 5') ||
    msg.includes('econnrefused')
  ) {
    return 'Can’t reach the vault. Try again.'
  }
  if (msg.includes('authorizer status') || msg.includes('unreachable')) {
    return 'Vault isn’t responding. Try again.'
  }
  if (isRecoverableVaultBoardingError(err)) {
    return 'Moving received Bitcoin into Spending automatically. Keep this wallet open; approve with passkey if asked.'
  }
  if (msg.includes('vtxo spend is unresolved') || msg.includes('vtxo reservation expired')) {
    return 'This send did not finish. Refresh your balance before trying again.'
  }
  if (msg.includes('fee quote expired or changed')) {
    return 'This fee quote expired or changed. Review the send again.'
  }
  if (isVtxoSameSendInProgressError(err) || msg.includes('exact amount to this address is still in progress')) {
    return 'This payment is reserved. Tap Resume payment to continue it.'
  }
  if (isVtxoReservedReplaceError(err) || msg.includes('abort it before sending a different amount')) {
    return 'A reserved send is still open. Abort it before sending a different amount.'
  }
  if (
    isVtxoLivePendingError(err) ||
    msg.includes('already with the operator and cannot be cancelled') ||
    msg.includes('vtxo operation is not abortable') ||
    msg.includes('vtxo operation already active')
  ) {
    return 'This payment is with the Operator and cannot be cancelled. Open the original payment and tap Resume payment.'
  }
  if (
    isVtxoAbortFailedError(err) ||
    msg.includes('could not be aborted') ||
    msg.includes('reserved vtxo input state')
  ) {
    return 'The reserved send could not be aborted. Try again.'
  }
  if (name === 'notallowederror' || name === 'aborterror') {
    return 'The passkey prompt was cancelled. Try again and approve Face ID.'
  }
  if (msg.includes('pending send lookup failed')) {
    return 'The current send status could not be confirmed. New sends remain blocked; try again later.'
  }
  if (isVtxoSpendInFlightError(err) || msg.includes('vtxo spend is still with the operator')) {
    return 'The Operator has this payment. Tap Resume payment to finish its approvals.'
  }
  if (
    msg.includes('reserved outpoint not spent by ark txid') ||
    msg.includes('vtxo finalization receipt') ||
    msg.includes('did not return exactly one transaction') ||
    msg.includes('operator pending lookup')
  ) {
    return 'Your send was submitted and is still being confirmed. Refresh your balance before trying again.'
  }
  if (msg.includes('already bound to a different exact request')) {
    return 'This send is already in progress. Refresh your balance before trying again.'
  }
  if (msg.includes('challenge mismatch') || msg.includes('webauthn challenge')) {
    return 'Passkey didn’t match this send. Try Approve again.'
  }
  if (msg.includes('vtxo operation state') || msg.includes('changed psbt') || msg.includes('checkpoint count')) {
    return 'This send could not be authorized. Review the payment again.'
  }
  if (msg.includes('not enough') && msg.includes('vtxo')) {
    return 'Not enough confirmed spending funds after the last send.'
  }
  if (msg.includes('mutated') && msg.includes('phone')) {
    return 'The vault rejected a changed signature. Refresh your balance before trying again.'
  }
  if (msg.includes('invalid scalar') || msg.includes('scalar: out of range') || msg.includes('scalar out of range')) {
    return 'Couldn’t unlock Spending. Sign in again.'
  }
  if (msg.includes('http://localhost:3003') && msg.includes('127.0.0.1')) {
    return 'Open this page as http://localhost:3003.'
  }
  if (
    msg.includes('rp id') ||
    msg.includes('origin does not match') ||
    msg.includes('signing client') ||
    msg.includes('signing address')
  ) {
    return 'Wrong site. Open this vault at rc.getvaulted.xyz — passkeys for this RC are bound to that address.'
  }
  if (
    msg.includes('sdk worker') ||
    msg.includes('worker network') ||
    msg.includes('did not register the spending contract') ||
    msg.includes('different boarding address') ||
    msg.includes('unsupported network') ||
    msg.includes('initialization and teardown') ||
    msg.includes('active vault-board-v1 key required') ||
    msg.includes('message bus') ||
    msg.includes('message timeout')
  ) {
    return 'Spending could not start on this network. Keep this page open; the wallet will retry in the background. If it stays down, reopen the vault at rc.getvaulted.xyz.'
  }
  if (msg.includes('could not load activity') || msg.includes('could not load coins')) {
    return 'Bitcoin activity could not be loaded. Keep this page open while the wallet retries.'
  }
  if (msg.includes('vault-board-v1 descriptor does not match')) {
    return 'This app doesn’t match the vault. Update and try again.'
  }
  if (msg.includes('passkey sign-in must first be enabled') || msg.includes('has not been enabled')) {
    return 'Enable sign-in on the original device first.'
  }
  if (
    msg.includes('passkey authentication failed') ||
    msg.includes('passkey credential does not match') ||
    msg.includes('passkey does not belong') ||
    msg.includes('selected passkey does not belong') ||
    msg.includes('passkey direct key does not match') ||
    msg.includes('phone bip340 key does not match') ||
    msg.includes('does not have the passkey')
  ) {
    return 'Wrong passkey. Use the device that created this vault. On a new device, scan the QR with that original device.'
  }
  if (msg.includes('prf authentication succeeded') && msg.includes('could not decrypt')) {
    return 'The passkey was verified, but its saved Spending key could not be unlocked. Try the same sign-in button once more. If it repeats, don’t create a new vault yet.'
  }
  if (msg.includes('prf')) {
    return 'This browser verified the passkey but didn’t get the unlock secret. That’s common over a QR. Open the vault on the device that created it — Safari on a Mac with the same iCloud account may also work.'
  }
  if (
    name === 'notsupportederror' ||
    msg.includes('not supported on this device') ||
    msg.includes('authenticator is not available') ||
    msg.includes('no available authenticator')
  ) {
    return 'This browser can’t create the device key. Open Vaulted in Safari or Chrome on a phone or computer with Face ID, Touch ID, or a device PIN.'
  }
  if (msg.includes('not allowed') || msg.includes('timed out') || msg.includes('the operation was aborted')) {
    return 'The device key wasn’t created. Try again and approve the device prompt. If this browser can’t use your device, open Vaulted in Safari or Chrome.'
  }
  if (msg.includes('already set up') || msg.includes('already enrolled')) {
    return 'This vault already has a passkey. Sign in instead.'
  }
  if (msg.includes('not enrolled') || msg.includes('enroll first')) {
    return 'Create a passkey first.'
  }
  if (msg.includes('this setup skipped recovery')) {
    return 'This vault came back with recovery, but setup skipped it. Start over and add a recovery key.'
  }
  if (msg.includes('no recovery map') || msg.includes('no recovery kit yet')) {
    return 'This vault has no recovery map. Add recovery on a new vault, or get the map with your passkey.'
  }
  if (msg.includes('could not rebuild the map')) {
    return 'Could not rebuild the map. Save it while this app is open.'
  }
  if (
    msg.includes('template version') ||
    msg.includes('policy version') ||
    msg.includes('current vault program descriptor') ||
    msg.includes('tree does not match this vault')
  ) {
    return 'This app doesn’t match the vault. Update and try again.'
  }
  if (msg.includes('does not match the local pin') || msg.includes('not pinned locally')) {
    return 'This vault’s receive address no longer matches the one saved on this device. Don’t send coins until that’s fixed.'
  }
  if (msg.includes('api response too large')) {
    return 'The vault sent too much data. Try again.'
  }
  if (msg.includes('invite required')) return 'Setup now requires an invite. Return to setup to enter one.'
  if (msg.includes('setup code required') || msg.includes('paste your setup code')) {
    return 'Paste your invite.'
  }
  if (msg.includes('invalid address') || msg.includes('not a bitcoin')) {
    return 'Enter a bitcoin address.'
  }
  if (msg.includes('exceeds transaction cap') || msg.includes('recipient exceeds')) {
    return 'Over the send limit.'
  }
  if (msg.includes('period allowance')) {
    return 'Over your rolling 24-hour limit.'
  }
  if (msg.includes('dust')) {
    return 'Too small to send.'
  }
  if (msg.includes('33-byte') || msg.includes('compressed public key') || msg.includes('secp256k1')) {
    return 'Paste a public key. It starts with 02 or 03.'
  }
  if (msg.includes('recovery must be a different')) {
    return 'Recovery must be a different key than hardware.'
  }
  if (msg.includes('different key') || msg.includes('must be different')) {
    return 'Use a different hardware key.'
  }
  if (msg.includes('connector') || msg.includes('guardian does not support')) {
    if (msg.includes('descriptor'))
      return 'Use a supported public wpkh or tr wallet descriptor with its fingerprint and derivation path.'
    if (msg.includes('busy') || msg.includes('pending') || msg.includes('active'))
      return 'A Savings transfer is pending. Open it in History to continue.'
    if (msg.includes('does not support'))
      return 'This Guardian does not support Savings connectors yet. Setup has not continued.'
    return 'This Savings transfer could not be verified. Reopen the pending transfer before trying again.'
  }
  return 'Something went wrong. Try again.'
}

export function isRecoverableVaultBoardingError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase()
  return (
    msg.includes('invalid_intent_proof') ||
    msg.includes('no matching intents found') ||
    msg.includes('not enough intent confirmations') ||
    msg.includes('eventsource') ||
    msg.includes('event stream') ||
    msg.includes('duplicated input')
  )
}
