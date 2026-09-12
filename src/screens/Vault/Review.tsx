import PaymentNotice from './qg/PaymentNotice'
import { isVaultBitcoinAddress } from '../../lib/vault/bitcoin'
import { useContext, useState } from 'react'
import { useToast } from '../../components/Toast'
import { copyToClipboard } from '../../lib/clipboard'
import { formatMoney, hasUsdRate } from '../../lib/vault/fiatDisplay'
import { isVaultLightningInput } from '../../lib/vault/lightningConfig'
import { truncateAddress } from '../../lib/vault/policy'
import { VaultContext } from '../../vault/context'
import { useBalanceDenomination, type BalanceDenomination } from './AccountBalance'
import QgAmount from './qg/QgAmount'
import ReviewAmount from './qg/ReviewAmount'
import WalletScreen from './qg/WalletScreen'
import { QgPrimary, QgTextButton } from './qg/QgScreen'

export default function VaultReview({ denomination }: { denomination?: BalanceDenomination }) {
  const {
    account,
    approveSend,
    boardingAddress,
    bitcoinOutputs,
    busy,
    error,
    navigate,
    resumingPayment,
    spend,
    status,
  } = useContext(VaultContext)
  const { toast } = useToast()
  const [revealed, setRevealed] = useState(false)
  const denom = useBalanceDenomination(denomination)
  const money = { unit: denom.unit, rate: denom.rate }
  const fromSavings = account === 'savings'
  const bitcoinSend = !fromSavings && isVaultBitcoinAddress(spend.address, status?.network)
  const movingToSpending = fromSavings && Boolean(boardingAddress) && spend.address === boardingAddress
  const lightning = isVaultLightningInput(spend.address)
  const destinationType = movingToSpending ? 'Spending' : lightning ? 'Lightning invoice' : 'Address'
  const destinationValue = movingToSpending ? 'Spending' : spend.address
  const destinationShown = movingToSpending
    ? destinationValue
    : lightning
      ? 'Lightning payment'
      : revealed
        ? destinationValue
        : truncateAddress(destinationValue, 8)

  if (fromSavings && busy) {
    return (
      <div className='qg-screen qg-screen-progress'>
        <main className='qg-main qg-centered qg-progress-screen'>
          <span className='qg-spinner' aria-hidden='true' />
          <ReviewAmount value={formatMoney(spend.amount, money)} label='Savings transfer' />
          <h1 aria-live='polite'>Approve with passkey</h1>
          <p className='qg-copy'>Use Face ID, Touch ID, fingerprint, or your device PIN when prompted.</p>
        </main>
      </div>
    )
  }

  return (
    <WalletScreen
      title={resumingPayment ? 'Resume payment' : 'Review payment'}
      back={busy ? undefined : () => navigate(resumingPayment || bitcoinSend ? 'home' : 'send')}
      footer={
        <>
          {error ? <PaymentNotice message={error} /> : null}
          <QgPrimary
            onClick={() => void approveSend()}
            disabled={busy}
            loading={busy}
            label={
              busy
                ? 'Completing payment…'
                : fromSavings
                  ? 'Sign on this device'
                  : resumingPayment
                    ? 'Continue payment'
                    : bitcoinSend
                      ? 'Confirm Bitcoin payment'
                      : 'Approve payment'
            }
          />
        </>
      }
    >
      <ReviewAmount
        value={formatMoney(spend.amount, money)}
        label={movingToSpending ? 'You’re transferring' : lightning ? 'You’re paying' : 'You’re sending'}
      >
        <p>{fromSavings ? 'From Savings' : 'From Spending'}</p>
        {resumingPayment ? (
          <p>Continue the original payment from its last saved step.</p>
        ) : !bitcoinSend ? (
          <QgTextButton onClick={() => navigate('send')} label='Edit amount' disabled={busy} />
        ) : null}
        {resumingPayment && lightning ? (
          <p>An expired Lightning invoice may need a refund after this transaction completes.</p>
        ) : null}
      </ReviewAmount>
      {bitcoinSend && bitcoinOutputs && bitcoinOutputs.length > 1 ? (
        <p className='qg-copy'>
          {bitcoinOutputs.length} separate Bitcoin outputs:{' '}
          {bitcoinOutputs
            .map((output) =>
              money.unit === 'usd' && hasUsdRate(money.rate)
                ? formatMoney(output.amountSats, money)
                : `${output.amountSats} sats`,
            )
            .join(' + ')}
          .
        </p>
      ) : null}
      <section className='qg-details' aria-label='Payment details'>
        <div>
          <span>To</span>
          <strong>
            <small className='qg-dest-type'>{destinationType}</small>
            {destinationShown}
          </strong>
        </div>
        {movingToSpending || lightning ? null : (
          <div className='qg-detail-actions'>
            <button
              type='button'
              className='qg-text'
              onClick={() => {
                void copyToClipboard(spend.address).then(() => toast('Address copied'))
              }}
            >
              Copy
            </button>
            <button type='button' className='qg-text' onClick={() => setRevealed((open) => !open)}>
              {revealed ? 'Hide' : 'Reveal'}
            </button>
            {!resumingPayment && !bitcoinSend ? (
              <button type='button' className='qg-text' disabled={busy} onClick={() => navigate('send')}>
                Edit
              </button>
            ) : null}
          </div>
        )}
        <div>
          <span>{fromSavings ? 'Network fee' : 'Fee'}</span>
          <strong>
            <QgAmount value={formatMoney(spend.fee, money)} />
          </strong>
        </div>
        <div>
          <span>Total</span>
          <strong>
            <QgAmount value={formatMoney(spend.amount + spend.fee, money)} />
          </strong>
        </div>
        <div>
          <span>Network</span>
          <strong>{status?.network === 'mainnet' ? 'Bitcoin' : 'Mutinynet'}</strong>
        </div>
      </section>
      <p className='qg-copy qg-approval-copy'>
        {fromSavings
          ? 'Approve with your passkey, then review the recipient, amount and fee on your Ledger.'
          : bitcoinSend
            ? 'Confirm this destination and fee. Keep the wallet open while your payment joins a batch; Bitcoin confirmation follows.'
            : 'Approve with your passkey. The vault service checks your payment limits.'}
      </p>
      {lightning ? (
        <details className='qg-guidance'>
          <summary>View Lightning invoice</summary>
          <p className='qg-full-value'>{spend.address}</p>
        </details>
      ) : null}
    </WalletScreen>
  )
}
