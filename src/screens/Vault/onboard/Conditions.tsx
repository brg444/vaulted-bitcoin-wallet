import { useContext, useMemo, useState } from 'react'
import { Clock3 } from 'lucide-react'
import ErrorMessage from '../../../components/Error'
import { prettyNumber } from '../../../lib/format'
import { ABSOLUTE_FEE_CEILING_SATS, FEERATE_CEILING_SAT_PER_V } from '../../../lib/vault/constants'
import { setupSpendingPolicy } from '../../../lib/vault/setupPlan'
import { spendingPolicyFromLimits } from '../../../lib/vault/spendingPolicy'
import { VaultContext } from '../../../vault/context'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

function digitsOnly(raw: string) {
  return raw.replace(/\D/g, '')
}

function displaySats(raw: string) {
  const digits = digitsOnly(raw)
  if (!digits) return ''
  return prettyNumber(Number(digits), 0)
}

export default function VaultConditions() {
  const { confirmConditions, error, navigate, setSpendingPolicy, setup, spendingPolicyCapabilities } =
    useContext(VaultContext)
  const setupPolicy = setupSpendingPolicy(setup)
  const [txCap, setTxCap] = useState(String(setupPolicy.txRecipientCapSats))
  const [allowance, setAllowance] = useState(String(setupPolicy.periodAllowanceSats))

  const selected = useMemo(() => {
    try {
      return spendingPolicyFromLimits({
        txRecipientCapSats: Number(digitsOnly(txCap) || '0'),
        periodAllowanceSats: Number(digitsOnly(allowance) || '0'),
        absoluteFeeCapSats: ABSOLUTE_FEE_CEILING_SATS,
        feerateCapSatPerV: FEERATE_CEILING_SAT_PER_V,
      })
    } catch {
      return null
    }
  }, [allowance, txCap])

  const continueSetup = () => {
    if (!selected) return
    setSpendingPolicy(selected)
    confirmConditions()
  }

  const bounds = spendingPolicyCapabilities.bounds

  return (
    <QgScreen
      title='Spending limits'
      stepLabel='4 of 6'
      back={() => navigate(setup.protectionTier === 'advanced' ? 'recovery' : 'hardware')}
      footer={
        <>
          <ErrorMessage error={Boolean(error)} text={error || ''} />
          <QgPrimary onClick={continueSetup} disabled={!selected} label='Review setup' />
        </>
      }
    >
      <h1>Set your spending limits</h1>
      <p className='qg-copy'>
        Choose a maximum per payment and per rolling 24 hours. These limits are fixed after setup.
      </p>
      <label className='qg-money-field'>
        <span>Per payment</span>
        <div>
          <b>sats</b>
          <input
            value={displaySats(txCap)}
            inputMode='numeric'
            aria-label='Per payment'
            data-testid='policy-tx-cap'
            onChange={(event) => setTxCap(digitsOnly(event.target.value))}
          />
        </div>
      </label>
      <label className='qg-money-field'>
        <span>Rolling 24-hour limit</span>
        <div>
          <b>sats</b>
          <input
            value={displaySats(allowance)}
            inputMode='numeric'
            aria-label='Rolling 24-hour limit'
            data-testid='policy-period-allowance'
            onChange={(event) => setAllowance(digitsOnly(event.target.value))}
          />
        </div>
      </label>
      <p className='qg-copy'>100,000 sats = 0.001 BTC. Each payment leaves the rolling allowance after 24 hours.</p>
      {selected ? null : (
        <section className='qg-note'>
          <Clock3 />
          <div>
            <strong>Check these limits</strong>
            <p>
              Per payment {prettyNumber(bounds.txRecipientCapSats.min, 0)}–
              {prettyNumber(bounds.txRecipientCapSats.max, 0)} sats. Rolling 24-hour
              {prettyNumber(bounds.periodAllowanceSats.min, 0)}–{prettyNumber(bounds.periodAllowanceSats.max, 0)} sats,
              and it must cover at least one payment.
            </p>
          </div>
        </section>
      )}
    </QgScreen>
  )
}
