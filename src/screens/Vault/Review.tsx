import { isVaultBitcoinAddress } from '../../lib/vault/bitcoin'
import { isConnectorTemplate, DUAL_CONNECTOR_TEMPLATE } from '../../lib/vault/program/connector'
import { useContext, useState } from 'react'
import { useToast } from '../../components/Toast'
import { copyToClipboard } from '../../lib/clipboard'
import { prettyAmount } from '../../lib/format'
import { isVaultLightningInput } from '../../lib/vault/lightningConfig'
import { truncateAddress } from '../../lib/vault/policy'
import { VaultContext } from '../../vault/context'
import QgAmount, { amountSizeStyle } from './qg/QgAmount'
import QgScreen, { QgPrimary, QgTextButton } from './qg/QgScreen'

export default function VaultReview() {
  const {
    account,
    approveSend,
    boardingAddress,
    bitcoinOutputs,
    busy,
    error,
    navigate,
    resumingPayment,
    rebroadcastingConnector,
    spend,
    status,
  } = useContext(VaultContext)
  const { toast } = useToast()
  const [revealed, setRevealed] = useState(false)
  const fromSavings = account === 'savings'
  const bitcoinSend = !fromSavings && isVaultBitcoinAddress(spend.address, status?.network)
  const hardwareFirst = fromSavings && status?.templateVersion === DUAL_CONNECTOR_TEMPLATE
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

  if (fromSavings && busy && !rebroadcastingConnector) {
    return (
      <div className='qg-screen qg-screen-progress'>
        <main className='qg-main qg-centered qg-progress-screen'>
          <span className='qg-spinner' aria-hidden='true' />
          <p className='qg-eyebrow'>Savings transfer</p>
          <h1>{hardwareFirst ? 'Preparing approval' : 'Approve with passkey'}</h1>
          <p className='qg-copy'>Use Face ID, Touch ID, fingerprint, or your device PIN when prompted.</p>
        </main>
      </div>
    )
  }

  return (
    <QgScreen
      title={resumingPayment ? 'Resume payment' : 'Review payment'}
      back={() => navigate(resumingPayment || bitcoinSend ? 'home' : 'send')}
      footer={
        <>
          {error ? (
            <p className='qg-footer-error' role='alert'>
              {error}
            </p>
          ) : null}
          <QgPrimary
            onClick={() => void approveSend()}
            disabled={busy}
            loading={busy}
            label={
              busy
                ? 'Completing payment…'
                : rebroadcastingConnector
                  ? 'Retry broadcast'
                  : fromSavings
                    ? hardwareFirst
                      ? 'Continue to signer'
                      : 'Sign on this device'
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
      <section className='qg-review-amount'>
        <small>{movingToSpending ? 'You’re transferring' : lightning ? 'You’re paying' : 'You’re sending'}</small>
        <strong style={amountSizeStyle(prettyAmount(spend.amount))}>
          <QgAmount value={prettyAmount(spend.amount)} />
        </strong>
        <p>{fromSavings ? 'From Savings' : 'From Spending'}</p>
        {resumingPayment ? (
          <p>Continue the original payment from its last saved step.</p>
        ) : !bitcoinSend ? (
          <QgTextButton onClick={() => navigate('send')} label='Edit amount' />
        ) : null}
        {resumingPayment && lightning ? (
          <p>An expired Lightning invoice may need a refund after this transaction completes.</p>
        ) : null}
      </section>
      {bitcoinSend && bitcoinOutputs && bitcoinOutputs.length > 1 ? (
        <p className='qg-copy'>
          {bitcoinOutputs.length} separate Bitcoin outputs:{' '}
          {bitcoinOutputs.map((output) => `${output.amountSats} sats`).join(' + ')}.
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
            {!bitcoinSend ? (
              <button type='button' className='qg-text' onClick={() => navigate('send')}>
                Edit
              </button>
            ) : null}
          </div>
        )}
        <div>
          <span>
            {fromSavings
              ? isConnectorTemplate(status?.templateVersion)
                ? 'Network fee and 240-sat anchor'
                : 'Network fee'
              : 'Fee'}
          </span>
          <strong>
            <QgAmount value={prettyAmount(spend.fee)} />
          </strong>
        </div>
        <div>
          <span>Total</span>
          <strong>
            <QgAmount value={prettyAmount(spend.amount + spend.fee)} />
          </strong>
        </div>
        <div>
          <span>Network</span>
          <strong>{status?.network === 'mainnet' ? 'Bitcoin' : 'Mutinynet'}</strong>
        </div>
      </section>
      {!rebroadcastingConnector ? (
        <p className='qg-copy qg-approval-copy'>
          {fromSavings
            ? hardwareFirst
              ? 'Sign with your external wallet, then approve with your passkey to send.'
              : 'Approve with your passkey, then sign with your external wallet.'
            : bitcoinSend
              ? 'Confirm this destination and fee. Keep the wallet open while your payment joins a batch; Bitcoin confirmation follows.'
              : 'Approve with your passkey. The vault service checks your payment limits.'}
        </p>
      ) : null}
      {lightning ? (
        <details className='qg-guidance'>
          <summary>View Lightning invoice</summary>
          <p className='qg-full-value'>{spend.address}</p>
        </details>
      ) : null}
    </QgScreen>
  )
}
