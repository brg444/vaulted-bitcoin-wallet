import { useContext, useEffect, useState } from 'react'
import { Address, OutScript } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { VaultContext } from '../../../vault/context'
import { vaultAddressNetwork } from '../../../lib/vault/bitcoin'
import VaultReview from '../../../screens/Vault/Review'
import BitcoinPaymentStatus from '../../../screens/Vault/BitcoinPaymentStatus'
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
  return mode === 3 ? (
    <BitcoinPaymentStatus status={status} operation={{ stage: 'registered', outputs } as BitcoinPaymentJournal} />
  ) : (
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
