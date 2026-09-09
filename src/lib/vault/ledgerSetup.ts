import { hex } from '@scure/base'
import type { VaultNetwork } from './network'
import { ledgerAccountKey, type LedgerAccountOrigin } from './program/ledgerNativeKeys'

export interface VaultSetupLedger {
  hardware: LedgerAccountOrigin
  recovery?: LedgerAccountOrigin
}

/** Dedicated Spending recovery key. Savings signing branches remain 0 through 10. */
export function ledgerSpendingPublicKey(origin: LedgerAccountOrigin, network: VaultNetwork): string {
  const account = ledgerAccountKey(origin, network)
  const branch = account.deriveChild(12),
    child = branch.deriveChild(0)
  if (branch.index !== 12 || child.index !== 0) throw new Error('Invalid Spending recovery key derivation')
  return `02${hex.encode(child.publicKey!.slice(1))}`
}

/** Accept an explicit public BIP86 origin, never a seed, private key or child-only public key. */
export function parseLedgerAccountOrigin(text: string, network: VaultNetwork): LedgerAccountOrigin {
  const raw = text.trim()
  let origin: LedgerAccountOrigin
  if (raw.startsWith('{')) {
    const input = JSON.parse(raw) as LedgerAccountOrigin
    if (!input || Object.keys(input).sort().join(',') !== 'fingerprint,path,xpub')
      throw new Error('Import the public account origin with fingerprint, path and xpub')
    origin = { fingerprint: input.fingerprint, path: [...input.path], xpub: input.xpub }
  } else {
    const match = raw.match(
      /^\[([0-9a-fA-F]{8})\/86['hH]\/([01])['hH]\/(\d{1,3})['hH]\]([xt]pub[1-9A-HJ-NP-Za-km-z]+)$/,
    )
    if (!match) throw new Error('Use a public BIP86 account: [fingerprint/86h/0h/0h]xpub…')
    origin = {
      fingerprint: match[1].toLowerCase(),
      path: [0x80000056, 0x80000000 + Number(match[2]), 0x80000000 + Number(match[3])],
      xpub: match[4],
    }
  }
  ledgerAccountKey(origin, network)
  return origin
}

export function validateLedgerSetup(raw: VaultSetupLedger, network: VaultNetwork): VaultSetupLedger {
  const hardware = parseLedgerAccountOrigin(JSON.stringify(raw.hardware), network)
  const recovery = raw.recovery ? parseLedgerAccountOrigin(JSON.stringify(raw.recovery), network) : undefined
  if (
    recovery &&
    ledgerSpendingPublicKey(recovery, network).slice(2) === ledgerSpendingPublicKey(hardware, network).slice(2)
  )
    throw new Error('Recovery must use a different wallet')
  return { hardware, ...(recovery ? { recovery } : {}) }
}
