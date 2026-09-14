import { useVaultStatus } from '../../vault/sessionContext'
import QgAmount from './qg/QgAmount'
import { formatMoney } from '../../lib/vault/fiatDisplay'
import { vaultTransactionExplorer } from '../../lib/vault/explorer'
import { truncateAddress } from '../../lib/vault/policy'
import { useVaultAccount, useVaultNavigation, useVaultSend } from '../../vault/appContexts'
import { useBalanceDenomination, type BalanceDenomination } from './AccountBalance'
import TransactionReference from './qg/TransactionReference'
import WalletScreen from './qg/WalletScreen'
import { QgPrimary } from './qg/QgScreen'
import PaymentResult from './qg/PaymentResult'

export default function VaultSuccess({ denomination }: { denomination?: BalanceDenomination }) {
  const status = useVaultStatus()
  const { account, boardingAddress } = useVaultAccount()
  const { lastSend, lastTxid, lastTxKind, starting } = useVaultSend()
  const { navigate } = useVaultNavigation()
  const denom = useBalanceDenomination(denomination)
  const money = { unit: denom.unit, rate: denom.rate }
  const movingToSpending = Boolean(lastSend && boardingAddress && lastSend.address === boardingAddress)
  const lightning = lastTxKind === 'lightning'
  const onchain = lastTxKind === 'onchain'
  const explorer = lastTxKind
    ? vaultTransactionExplorer(lastTxid, lastTxKind === 'onchain' ? 'onchain' : 'arkade', status?.network)
    : null

  const headline = starting
    ? 'Payment started'
    : onchain
      ? account === 'savings'
        ? 'Savings transfer submitted'
        : 'Bitcoin payment submitted'
      : lightning
        ? 'Payment started'
        : 'Payment sent'
  const copy = starting
    ? 'Your payment is processing. Activity and balances update automatically.'
    : movingToSpending
      ? 'Bitcoin confirmation is next'
      : lightning
        ? 'Quote accepted. The Lightning payment is completing.'
        : lastTxKind === 'vtxo'
          ? 'Fast transfer complete'
          : onchain
            ? 'Bitcoin confirmation is next'
            : 'Done'

  return (
    <WalletScreen variant='success' footer={<QgPrimary onClick={() => navigate('home')} label='Done' />}>
      <PaymentResult
        state={starting ? 'started' : onchain ? 'submitted' : lightning ? 'started' : 'sent'}
        title={headline}
        copy={copy}
      >
        {lastSend ? (
          <section className='qg-details'>
            <div>
              <span>Amount</span>
              <strong>
                <QgAmount value={formatMoney(lastSend.amount, money)} />
              </strong>
            </div>
            <div>
              <span>To</span>
              <strong>
                {movingToSpending ? 'Spending' : lightning ? 'Lightning' : truncateAddress(lastSend.address, 8)}
              </strong>
            </div>
            <div>
              <span>Network</span>
              <strong>{status?.network === 'mainnet' ? 'Bitcoin' : 'Mutinynet'}</strong>
            </div>
          </section>
        ) : null}
        {starting ? null : <TransactionReference txid={lastTxid} explorer={explorer} funding={lightning} />}
      </PaymentResult>
    </WalletScreen>
  )
}
