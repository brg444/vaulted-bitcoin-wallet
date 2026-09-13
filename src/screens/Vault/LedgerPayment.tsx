import { useContext, useEffect } from 'react'
import { useLedgerPayment } from '../../vault/ledgerPaymentContext'
import { VaultContext } from '../../vault/context'
import LedgerSavingsApproval from './LedgerSavingsApproval'
import WalletScreen from './qg/WalletScreen'
import { QgPrimary } from './qg/QgScreen'

export default function VaultLedgerPayment() {
  const { navigate } = useContext(VaultContext)
  const { view: ledgerPayment, approveWithLedger, cancelHardware, pending, hardwarePhase, error } = useLedgerPayment()
  const busy = pending !== null
  useEffect(() => cancelHardware, [cancelHardware])
  const back = () => navigate('home')
  if (busy && ledgerPayment?.record.txHex)
    return (
      <WalletScreen title='Sending payment'>
        <h1>Submitting your payment</h1>
        <p className='qg-copy'>
          {ledgerPayment.record.payment.amountSats.toLocaleString()} sats to {ledgerPayment.record.payment.destAddress}
        </p>
      </WalletScreen>
    )
  if (!ledgerPayment?.record.phonePsbt || ledgerPayment.record.txHex) {
    return (
      <WalletScreen title='Savings payment' back={back} footer={<QgPrimary label='Return to Savings' onClick={back} />}>
        <h1>Check your saved payment</h1>
        {error ? <p role='alert'>{error}</p> : null}
        <p className='qg-copy'>Open the payment in Savings history to continue from its saved status.</p>
      </WalletScreen>
    )
  }
  const { record } = ledgerPayment
  return (
    <LedgerSavingsApproval
      mode='sign'
      payment={record.payment}
      busy={busy}
      phase={hardwarePhase}
      error={error}
      onBack={back}
      onApprove={() => approveWithLedger(record.candidateId)}
    />
  )
}
