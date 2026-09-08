import PaymentNotice from '../../../screens/Vault/qg/PaymentNotice'
import { bitcoinPaymentRejected } from '../../../lib/vault/bitcoinPaymentError'
import { useContext, useEffect, useState } from 'react'
import { Address, OutScript } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { VaultContext } from '../../../vault/context'
import { vaultAddressNetwork } from '../../../lib/vault/bitcoin'
import VaultReview from '../../../screens/Vault/Review'
import AccountHome from '../../../screens/Vault/AccountHome'
import { VaultHistoryList } from '../../../screens/Vault/History'
import VaultTx from '../../../screens/Vault/Tx'
import { withBitcoinPaymentHistory } from '../../../lib/vault/bitcoinPaymentHistory'
import type { BitcoinPaymentJournal } from '../../../lib/vault/spendingBitcoinStore'

// Presentation-only fixture; provider tests cover approval/cancellation and SDK
// vectors cover signed output authority. No payment is created by this view.
export default function BitcoinPaymentUi() {
  const context = useContext(VaultContext)
  const [mode, setMode] = useState(1)
  useEffect(() => {
    const change = (event: Event) => setMode((event as CustomEvent<number>).detail)
    window.addEventListener('bitcoin-payment-view', change)
    return () => window.removeEventListener('bitcoin-payment-view', change)
  }, [])
  const status = context.status
  if (!status) return null
  const script = '0014' + '43'.repeat(20)
  const address = Address(vaultAddressNetwork(status.network)).encode(OutScript.decode(hex.decode(script)))
  const outputs = Array.from({ length: mode === 1 ? 1 : 2 }, () => ({ script, amountSats: mode === 1 ? 1500 : 500 }))
  const amount = outputs.reduce((n, o) => n + o.amountSats, 0)
  const operation = {
    operationId: 'ui-payment',
    stage: 'submitted',
    outputs,
    plan: { plan: { outputs, feeSats: 400, changeSats: 25859 } },
    receipt: { state: 'submitted', commitmentTxid: 'ab'.repeat(32) },
  } as BitcoinPaymentJournal
  const history = withBitcoinPaymentHistory(
    [{ txid: 'receive', amount: 27259, type: 'received', confirmed: true, account: 'spend' }],
    operation,
  )
  if (mode === 5 || mode === 6) {
    const paymentError = bitcoinPaymentRejected(
      'INVALID_PSBT_INPUT (5): vtxo [redacted] expires after 2026-10-07 12:18:19.47932425 +0000 UTC m=+2519147.005463777 (minExpiryGap: 695h53m36s)',
      Date.UTC(2026, 8, 9, 10, 15),
    )
    return (
      <VaultContext.Provider
        value={{
          ...context,
          error: mode === 5 ? paymentError.message : '',
          paymentError,
          dismissError: () => setMode(6),
        }}
      >
        <AccountHome
          account='Spending'
          totalSats={25859}
          balancesLoaded
          security={{ label: 'Recovery', onClick: () => {} }}
          primaryAction={{ label: 'Send', onClick: () => {} }}
          secondaryAction={{ label: 'Receive', onClick: () => {} }}
        >
          {mode === 5 ? <PaymentNotice message={paymentError.message} /> : null}
          <VaultHistoryList account='spend' balancesLoaded history={history} openTx={() => setMode(4)} />
        </AccountHome>
      </VaultContext.Provider>
    )
  }
  if (mode === 3)
    return (
      <AccountHome
        account='Spending'
        totalSats={25859}
        balancesLoaded
        security={{ label: 'Recovery', onClick: () => {} }}
        primaryAction={{ label: 'Send', disabled: true, onClick: () => {} }}
        secondaryAction={{ label: 'Receive', onClick: () => {} }}
      >
        <VaultHistoryList account='spend' balancesLoaded history={history} openTx={() => setMode(4)} />
      </AccountHome>
    )
  if (mode === 4)
    return (
      <VaultContext.Provider
        value={{
          ...context,
          selectedTx: history[0],
          spendingBitcoin: { operation, error: '' },
          navigate: () => setMode(3),
        }}
      >
        <VaultTx />
      </VaultContext.Provider>
    )
  return (
    <VaultContext.Provider
      value={{
        ...context,
        account: 'spend',
        busy: false,
        spend: { address, amount, fee: 400 },
        bitcoinOutputs: outputs,
        approveSend: async () => {},
        navigate: () => {},
      }}
    >
      <VaultReview />
    </VaultContext.Provider>
  )
}
