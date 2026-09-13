import { Buffer } from 'buffer'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { ledgerBip32Versions } from '../../../lib/vault/program/ledgerNativeKeys'
import { ledgerRecoveryFixture, ledgerFixturePRF } from '../../../lib/vault/recovery/testdata/ledger'
import { retainLedgerSavingsPayment } from '../../../lib/vault/ledgerSavingsWallet'
import type { LedgerSavingsPayment } from '../../../lib/vault/ledgerSavings'
import type { registerLedgerSavings } from '../../../lib/vault/ledgerClient'
import type { VaultSessionSnapshot } from '../../../lib/vault/session'
import { useLedgerPayments } from '../../../vault/useLedgerPayments'
import { ledgerPaymentView } from '../../../vault/ledgerPaymentContext'
import { VaultTestProvider } from '../../fixtures/VaultTestProvider'
import LedgerPayment from '../../../screens/Vault/LedgerPayment'
import '../../../screens/Vault/vault.css'
import '../../../screens/Vault/vault-system.css'
import '../../../screens/Vault/quiet-guardian-flows.css'
import '../../../screens/Vault/qg/layout.css'
import '../../../screens/Vault/quiet-guardian-screens.css'
import '../../../tokens.css'
import '../../../app.css'
import '../../../index.css'

let fixture: Awaited<ReturnType<typeof ledgerRecoveryFixture>>
let payment: LedgerSavingsPayment
let releaseSignature: (() => void) | undefined
let holdSignature = false
export const events: string[] = []
export function releaseDevice() {
  holdSignature = false
  releaseSignature?.()
}
export function storedPayment() {
  const key = Object.keys(localStorage).find((key) => key.startsWith('vaulted-ledger-savings-payments-v1:'))
  if (!key) throw new Error('Saved Ledger payment missing')
  return JSON.parse(localStorage.getItem(key)!)
}

/** Only the device transport is synthetic. The production Ledger client verifies
 * policy, enrolled origins and signatures using public fixture keys. */
export async function connectLedgerSavings() {
  events.push('connect')
  const origin = payment.contract.context.hardware
  const hardware = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x42), ledgerBip32Versions('mutinynet')).derive(
    "m/86'/1'/0'",
  )
  const app: Parameters<typeof registerLedgerSavings>[0] = {
    getMasterFingerprint: async () => origin.fingerprint,
    getExtendedPubkey: async () => origin.xpub,
    registerWallet: async (policy) => [policy.getId(), Buffer.alloc(32, 0xab)],
    getWalletAddress: async (_policy, _hmac, change) =>
      change ? fixture.family.change.address : fixture.family.receive.address,
    signPsbt: async (psbt) => {
      events.push('sign')
      if (holdSignature)
        await new Promise<void>((resolve) => {
          releaseSignature = resolve
        })
      const tx = Transaction.fromPSBT(new Uint8Array(psbt as Uint8Array), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      })
      const child = hardware.deriveChild(0).deriveChild(0)
      tx.signIdx(child.privateKey!, 0)
      const [key, signature] = tx
        .getInput(0)
        .tapScriptSig!.find(([key]) => hex.encode(key.pubKey) === hex.encode(child.publicKey!.slice(1)))!
      return [
        [
          0,
          {
            pubkey: Buffer.from(key.pubKey),
            tapleafHash: Buffer.from(key.leafHash),
            signature: Buffer.from(signature),
          },
        ],
      ]
    },
  }
  return {
    app,
    close: async () => {
      events.push('close')
    },
  }
}

export async function mountLedgerPayment(hold = false) {
  fixture = await ledgerRecoveryFixture()
  Object.assign(fixture.status, { rpId: location.hostname, clientOrigin: location.origin })
  const coin = fixture.archive.onchain[0]
  payment = {
    contract: fixture.enrollment.ledgerSavings.contract,
    coins: [{ txid: coin.txid, vout: coin.vout, value: coin.value, parentTxHex: coin.parentHex!, branch: 0, index: 0 }],
    destAddress: fixture.family.receive.address,
    amountSats: 20000,
    feeSats: 1000,
  }
  holdSignature = hold
  await retainLedgerSavingsPayment(payment)
  Object.defineProperty(navigator, 'hid', { configurable: true, value: {} })
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      get: async () => {
        events.push('passkey')
        return {
          rawId: hex.decode(fixture.enrollment.credId).buffer,
          getClientExtensionResults: () => ({ prf: { results: { first: ledgerFixturePRF.slice().buffer } } }),
        }
      },
    },
  })
  const state = { status: fixture.status, enrollment: fixture.enrollment, locked: false } as VaultSessionSnapshot
  const session = { getSnapshot: () => state, subscribe: () => () => undefined }
  function App() {
    const binding = useLedgerPayments(session)
    const [show, setShow] = useState(false)
    const candidate = binding.view?.record.candidateId
    return (
      <VaultTestProvider
        value={{ status: fixture.status, navigate: () => setShow(false) }}
        ledgerPayment={ledgerPaymentView(binding, binding.payments)}
      >
        <button onClick={() => setShow(false)}>Leave approval</button>
        <button onClick={releaseDevice}>Release device response</button>
        <button
          onClick={() => {
            events.push('phone-click')
            void binding.payments
              .approve({ address: payment.destAddress, amount: 20000, fee: 1000 })
              .then((approved) => setShow(Boolean(approved)))
          }}
        >
          Approve phone
        </button>
        <button onClick={() => candidate && void binding.payments.reopen(candidate).then(() => setShow(true))}>
          Reopen saved payment
        </button>
        <span data-testid='owner-pending'>{binding.pending || 'idle'}</span>
        {binding.error ? <p role='alert'>{binding.error}</p> : null}
        {binding.completion ? <p data-testid='payment-complete'>{binding.completion.txid}</p> : null}
        {show ? <LedgerPayment /> : <p>Wallet</p>}
      </VaultTestProvider>
    )
  }
  document.body.innerHTML = '<main id="root" class="page" data-testid="vault-app"></main>'
  createRoot(document.getElementById('root')!).render(<App />)
}
