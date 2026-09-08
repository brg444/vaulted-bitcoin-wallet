import { consoleError } from '../../lib/logs'
import { useEffect, useRef, useState } from 'react'
import { connectorContract } from '../../lib/vault/connectorWithdrawal'
import { buildConnectorFamily } from '../../lib/vault/program/connector'
import { loadEnrollment } from '../../lib/vault/enrollmentStore'
import { fundSignerFromSpending, type SavingsSetupPlan } from '../../lib/vault/savingsSetupFunding'
import type { VaultStatus } from '../../lib/vault/types'
import { QgPrimary, QgSecondary } from './qg/QgScreen'

export default function SpendingSignerFunding({
  status,
  onFinished,
  onBusyChange,
}: {
  status: VaultStatus
  onFinished: () => void
  onBusyChange?: (busy: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [plan, setPlan] = useState<SavingsSetupPlan | null>(null)
  const decision = useRef<(approve: boolean) => void>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      decision.current?.(false)
    }
  }, [])
  const decide = (approve: boolean) => {
    decision.current?.(approve)
    decision.current = undefined
    setPlan(null)
  }
  const fund = async () => {
    setBusy(true)
    onBusyChange?.(true)
    setError('')
    try {
      const enrollment = loadEnrollment(localStorage, status.vaultId)
      if (!enrollment) throw new Error('Sign in again to fund your signer from Spending.')
      await fundSignerFromSpending(
        enrollment,
        status,
        (next) =>
          new Promise<boolean>((resolve) => {
            if (!mounted.current) return resolve(false)
            decision.current = resolve
            setPlan(next)
          }),
        (next) => {
          if (mounted.current) setMessage(next)
        },
      )
      if (mounted.current) onFinished()
    } catch (err) {
      consoleError(err, 'Savings signer funding')
      if (mounted.current) setError((err as Error).message)
    } finally {
      onBusyChange?.(false)
      if (mounted.current) {
        setBusy(false)
        setMessage('')
      }
    }
  }
  return (
    <section aria-label='Fund signer from Spending'>
      {plan ? (
        <>
          <h2 className='qg-title'>Review signer funding</h2>
          <p className='qg-copy' style={{ overflowWrap: 'anywhere' }}>
            To your signer: {buildConnectorFamily(connectorContract(status)).connector.address}
          </p>
          <dl className='qg-summary'>
            <div>
              <dt>Approval outputs</dt>
              <dd>{plan.reserveSats * plan.reserveCount} sats</dd>
            </div>
            <div>
              <dt>Operator fee</dt>
              <dd>{plan.feeSats} sats</dd>
            </div>
            <div>
              <dt>Total from Spending</dt>
              <dd>{plan.reserveSats * plan.reserveCount + plan.feeSats} sats</dd>
            </div>
          </dl>
          <p className='qg-copy'>
            The approval outputs go to your enrolled signer. Remaining funds stay in Spending. Setup completes after
            Bitcoin confirmation.
          </p>
          <QgPrimary label='Confirm signer funding' onClick={() => decide(true)} />
          <QgSecondary label='Cancel' onClick={() => decide(false)} />
        </>
      ) : (
        <QgPrimary
          label={busy ? message || 'Funding signer…' : 'Fund from Spending'}
          disabled={busy}
          onClick={() => void fund()}
        />
      )}
      {error ? (
        <>
          <p role='alert'>{error}</p>
          <QgSecondary label='Check pending setup' onClick={onFinished} />
        </>
      ) : null}
    </section>
  )
}
