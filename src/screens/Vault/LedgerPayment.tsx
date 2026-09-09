import { useContext } from 'react'
import { VaultContext } from '../../vault/context'
import LedgerSavingsApproval from './LedgerSavingsApproval'
import QgScreen, { QgPrimary } from './qg/QgScreen'

export default function VaultLedgerPayment() {
  const { ledgerPayment, completeLedgerPayment, navigate, busy, error } = useContext(VaultContext)
  const back = () => navigate('home')
  if (busy && ledgerPayment?.record.txHex)
    return (
      <QgScreen title='Sending payment'>
        <h1>Submitting your payment</h1>
        <p className='qg-copy'>
          {ledgerPayment.record.payment.amountSats.toLocaleString()} sats to {ledgerPayment.record.payment.destAddress}
        </p>
      </QgScreen>
    )
  if (!ledgerPayment?.record.phonePsbt || ledgerPayment.record.txHex) {
    return (
      <QgScreen title='Savings payment' back={back} footer={<QgPrimary label='Return to Savings' onClick={back} />}>
        <h1>Check your saved payment</h1>
        {error ? <p role='alert'>{error}</p> : null}
        <p className='qg-copy'>Open the payment in Savings history to continue from its saved status.</p>
      </QgScreen>
    )
  }
  const { record, registration } = ledgerPayment
  return (
    <LedgerSavingsApproval
      mode='sign'
      payment={record.payment}
      phonePsbt={record.phonePsbt!}
      registration={registration}
      onBack={back}
      onSigned={(signed) => completeLedgerPayment(record.candidateId, signed)}
    />
  )
}
