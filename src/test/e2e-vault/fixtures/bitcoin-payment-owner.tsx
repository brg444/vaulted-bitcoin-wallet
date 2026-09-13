import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { Address, TEST_NETWORK } from '@scure/btc-signer'
import { hex } from '@scure/base'
import {
  ContractManager,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestIndexerProvider,
} from '@arkade-os/sdk'
import { vaultAccountRuntime } from '../../../lib/vault/accountRuntime'
import { vaultOperatorOrigin } from '../../../lib/vault/networkPins'
import { registerVaultPolicyV1ContractHandler, vaultPolicyV1Contract } from '../../../lib/vault/vtxo/contractHandler'
import { vaultPolicyV1ScriptFromStatus } from '../../../lib/vault/vtxo/spend'
import { ledgerRecoveryFixture, ledgerFixturePRF } from '../../../lib/vault/recovery/testdata/ledger'
import { guardianRenewalContextDigest } from '../../../lib/vault/vtxo/renewalContext'
import {
  readSpendingBitcoin,
  savingsSetupDigest,
  type BitcoinPaymentJournal,
  type SpendingBitcoinPlan,
} from '../../../lib/vault/spendingBitcoinStore'
import type { VaultSessionSnapshot } from '../../../lib/vault/session'
import { useBitcoinPayments } from '../../../vault/useBitcoinPayments'
import { bitcoinPaymentView } from '../../../vault/bitcoinPaymentContext'
import { VaultTestProvider } from '../../fixtures/VaultTestProvider'
import VaultReview from '../../../screens/Vault/Review'
import { ToastProvider } from '../../../components/Toast'
import '../../../tokens.css'
import '../../../app.css'
import '../../../index.css'
import '../../../screens/Vault/vault.css'
import '../../../screens/Vault/vault-system.css'
import '../../../screens/Vault/quiet-guardian-flows.css'
import '../../../screens/Vault/qg/layout.css'
import '../../../screens/Vault/quiet-guardian-screens.css'

let fixture: Awaited<ReturnType<typeof ledgerRecoveryFixture>>
let passkeys = 0
/** The UI fixture uses a real SDK manager; worker transport has its own browser suite. */
export async function connectBitcoinAccount() {
  registerVaultPolicyV1ContractHandler()
  const contracts = await ContractManager.create({
    indexerProvider: new RestIndexerProvider(vaultOperatorOrigin(fixture.status.network)),
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  })
  await contracts.createContract({
    ...vaultPolicyV1Contract(vaultPolicyV1ScriptFromStatus(fixture.status), fixture.status.spendingArkAddress!),
    // This fixture drives refresh explicitly after installing its intercepted indexer.
    watch: 'retained',
  })
  const account = vaultAccountRuntime(fixture.status)
  account.connection = { wallet: { getContractManager: async () => contracts } } as never
  account.closeConnection = async () => contracts.dispose()
}
export function storedPayment() {
  return readSpendingBitcoin(fixture.status)
}
export function passkeyCount() {
  return passkeys
}
export function prepare(request: NonNullable<BitcoinPaymentJournal['prepareRequest']>) {
  const plan: SpendingBitcoinPlan = {
    operationId: request.operationId,
    vaultId: request.vaultId,
    descriptorHash: guardianRenewalContextDigest(fixture.status),
    enrollmentDigest: '',
    txid: request.txid,
    vout: request.vout,
    valueSats: 40000,
    changeSats: 40000 - request.outputs.reduce((sum, output) => sum + output.amountSats, 0) - 400,
    reserveScript: '',
    reserveSats: 0,
    reserveCount: 0,
    feeSats: 400,
    feePolicyDigest: 'cc'.repeat(32),
    registerExpireAt: request.expiresAt,
    outputs: request.outputs,
  }
  return { state: 'prepared', plan, planDigest: savingsSetupDigest('bitcoin-plan', plan) }
}
export async function mountBitcoinPayment() {
  const viewport = document.createElement('meta')
  viewport.name = 'viewport'
  viewport.content = 'width=device-width, initial-scale=1'
  document.head.append(viewport)
  fixture = await ledgerRecoveryFixture(false, 'mutinynet')
  Object.assign(fixture.status, { rpId: location.hostname, clientOrigin: location.origin })
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      get: async (options: CredentialRequestOptions) => {
        options.signal?.throwIfAborted()
        passkeys++
        return {
          rawId: hex.decode(fixture.enrollment.credId).buffer,
          response: {
            clientDataJSON: new Uint8Array([1]).buffer,
            authenticatorData: new Uint8Array([2]).buffer,
            signature: new Uint8Array([3]).buffer,
          },
          getClientExtensionResults: () => ({ prf: { results: { first: ledgerFixturePRF.slice().buffer } } }),
        }
      },
    },
  })
  let state = { status: fixture.status, enrollment: fixture.enrollment, locked: false } as VaultSessionSnapshot
  const listeners = new Set<() => void>()
  const session = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const lock = (locked: boolean) => {
    state = { ...state, locked }
    for (const listener of listeners) listener()
  }
  const draft = {
    address: Address(TEST_NETWORK).encode({ type: 'wpkh', hash: new Uint8Array(20).fill(0x43) }),
    amount: 1500,
    fee: 0,
  }
  function App() {
    const binding = useBitcoinPayments(session)
    const [showReview, setShowReview] = useState(false)
    return (
      <ToastProvider>
        <VaultTestProvider
          value={{
            status: fixture.status,
            account: 'spend',
            spend: binding.review?.payment || draft,
            error: binding.error,
            busy: binding.pending !== null && binding.pending !== 'approval',
            approveSend: async () => binding.payments.approve(binding.review!.payment),
            navigate: () => {
              binding.payments.cancelReview()
              setShowReview(false)
            },
          }}
          bitcoinPayment={bitcoinPaymentView(binding, binding.payments)}
        >
          <button onClick={() => void binding.payments.review(draft).then((view) => setShowReview(!!view))}>
            Review Bitcoin
          </button>
          <button
            onClick={() => {
              lock(true)
              setShowReview(false)
            }}
          >
            Lock account
          </button>
          <button onClick={() => lock(false)}>Unlock fixture account</button>
          <button
            onClick={() => {
              const saved = storedPayment()
              if (saved) void binding.payments.check(saved.operationId).catch(() => undefined)
            }}
          >
            Check retained payment
          </button>
          <span data-testid='bitcoin-owner-pending'>{binding.pending || 'idle'}</span>
          <span data-testid='bitcoin-owner-completion'>{binding.completion?.txid || ''}</span>
          {binding.error ? <p data-testid='bitcoin-owner-error'>{binding.error}</p> : null}
          {showReview && binding.review ? <VaultReview /> : <p>Wallet</p>}
        </VaultTestProvider>
      </ToastProvider>
    )
  }
  document.body.innerHTML =
    '<div id="root"><main id="bitcoin-fixture" class="page" data-testid="vault-app"></main></div>'
  createRoot(document.getElementById('bitcoin-fixture')!).render(<App />)
  return {
    vaultId: fixture.status.vaultId,
    descriptorHash: guardianRenewalContextDigest(fixture.status),
    script: fixture.status.spendingArkScript,
  }
}
