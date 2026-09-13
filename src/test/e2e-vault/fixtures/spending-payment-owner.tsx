import { createRoot } from 'react-dom/client'
import { ArkAddress } from '@arkade-os/sdk'
import { InMemoryAssetSwapRepository } from '@arkade-os/swap'
import { hex } from '@scure/base'
import { ledgerRecoveryFixture, ledgerFixturePRF } from '../../../lib/vault/recovery/testdata/ledger'
import { vaultAccountRuntime } from '../../../lib/vault/accountRuntime'
import { listPersistedVtxoSpends, type VtxoReserveResponse } from '../../../lib/vault/vtxo/spend'
import { arkadeIntentFeePolicyDigest } from '../../../lib/vault/vtxo/feePolicy'
import { networkPins } from '../../../lib/vault/networkPins'
import type { VaultSessionSnapshot } from '../../../lib/vault/session'
import { useSpendingPayments } from '../../../vault/useSpendingPayments'
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
export const spendingRepository = new InMemoryAssetSwapRepository()
const feePolicy = { offchainInput: '0', offchainOutput: '0', onchainInput: '0', onchainOutput: '0' }
export function storedPayment() {
  return listPersistedVtxoSpends(fixture.status.vaultId)[0] || null
}
export function passkeyCount() {
  return passkeys
}
export async function mountSpendingPayment() {
  const viewport = document.createElement('meta')
  viewport.name = 'viewport'
  viewport.content = 'width=device-width, initial-scale=1'
  document.head.append(viewport)
  fixture = await ledgerRecoveryFixture(false, 'mutinynet', '13131313131313131313131313131313')
  Object.assign(fixture.status, { rpId: location.hostname, clientOrigin: location.origin })
  const spendingAddress = ArkAddress.decode(fixture.status.spendingArkAddress!)
  const destination = new ArkAddress(
    spendingAddress.serverPubKey,
    hex.decode('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
    'tark',
  )
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
  let state = {
    status: fixture.status,
    enrollment: fixture.enrollment,
    locked: false,
    setup: { txCapSats: fixture.status.txCap },
  } as VaultSessionSnapshot
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
  vaultAccountRuntime(fixture.status).balances = {
    getSnapshot: () => ({ positions: { spending: { availableSats: 20_000 } } }),
    dispose() {},
  } as never
  const draft = { address: destination.encode(), amount: 12_000, fee: 0 }
  function App() {
    const binding = useSpendingPayments(session)
    return (
      <ToastProvider>
        <VaultTestProvider
          value={{
            status: fixture.status,
            account: 'spend',
            spend: binding.review?.payment || draft,
            error: binding.error,
            busy: binding.pending !== null,
            approveSend: async () => {
              await binding.payments.approve(binding.review!.payment).catch(() => undefined)
            },
            navigate: () => binding.payments.cancelReview(),
          }}
          spendingPayment={{ resumingPayment: Boolean(binding.review?.resuming) }}
        >
          <aside data-testid='spending-fixture-controls'>
            <button onClick={() => void binding.payments.review(draft).catch(() => undefined)}>Review Spending</button>
            <button onClick={() => lock(true)}>Lock account</button>
            <button onClick={() => lock(false)}>Unlock fixture account</button>
            <button
              onClick={() => {
                const saved = storedPayment()
                if (saved) void binding.payments.openPending(saved.operationId).catch(() => undefined)
              }}
            >
              Open retained payment
            </button>
            <span data-testid='spending-owner-pending'>{binding.pending || 'idle'}</span>
            <span data-testid='spending-owner-event'>{binding.event?.outcome || ''}</span>
            <span data-testid='spending-owner-locked'>{String(state.locked)}</span>
            {binding.error ? <p data-testid='spending-owner-error'>{binding.error}</p> : null}
          </aside>
          {binding.review ? <VaultReview /> : <p>Wallet</p>}
        </VaultTestProvider>
      </ToastProvider>
    )
  }
  document.body.innerHTML =
    '<div id="root"><main id="spending-fixture" class="page" data-testid="vault-app"></main></div>'
  createRoot(document.getElementById('spending-fixture')!).render(<App />)
  const reservation: Omit<VtxoReserveResponse, 'operationId'> = {
    bundleDigest: '55'.repeat(32),
    reservationExpires: '2099-08-20T00:02:00Z',
    inputs: [{ txid: '22'.repeat(32), vout: 3, valueSats: 20_000, scriptHex: fixture.status.spendingArkScript! }],
    changeAddress: fixture.status.spendingArkAddress!,
    changeScript: fixture.status.spendingArkScript!,
    changeSats: 7_500,
    changeVout: 1,
    destScript: hex.encode(destination.pkScript),
    feeSats: 500,
    feePolicyDigest: arkadeIntentFeePolicyDigest(feePolicy),
    checkpointTapscript: networkPins('mutinynet').checkpointTapscript,
  }
  return {
    reservation,
    operatorInfo: {
      network: 'mutinynet',
      signerPubkey: '02' + hex.encode(spendingAddress.serverPubKey),
      checkpointTapscript: reservation.checkpointTapscript,
      fees: { intentFee: feePolicy, txFeeRate: '0' },
    },
  }
}
