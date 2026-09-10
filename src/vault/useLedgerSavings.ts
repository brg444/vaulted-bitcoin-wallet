import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LedgerSavingsRegistration } from '../lib/vault/ledgerClient'
import {
  broadcastLedgerSavingsPayment,
  cancelLedgerSavingsPayment,
  loadLedgerSavingsPayment,
  markLedgerSavingsSigning,
  quoteLedgerSavingsPayment,
  reconcileLedgerSavingsPayment,
  retainLedgerSavingsPayment,
  saveLedgerSavingsPhoneApproval,
  saveLedgerSavingsSigned,
  signLedgerSavingsSeed,
  type LedgerSavingsPaymentRecord,
} from '../lib/vault/ledgerSavingsWallet'
import { fetchFeeEstimates } from '../lib/vault/esplora'
import { satPerVFromFeeEstimates } from '../lib/vault/onchainFee'
import { validateLedgerSavingsEnrollmentSecrets } from '../lib/vault/program/ledgerEnrollment'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'
import { unlockLedgerSavingsSeed } from '../lib/vault/savingsSpend'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import type { VaultStatus } from '../lib/vault/types'
import type { VaultSpend } from './context'

export interface LedgerSavingsView {
  record: LedgerSavingsPaymentRecord
  registration: LedgerSavingsRegistration
  outcome: 'prepared' | 'signing' | 'unknown' | 'broadcast' | 'confirmed' | 'conflicted'
}

/** Only user actions sign or broadcast. Refreshing retains an uncertain payment. */
export function useLedgerSavings(status: VaultStatus | null, enrollment: EnrollmentSecrets | null, locked: boolean) {
  const [view, setView] = useState<LedgerSavingsView | null>(null)
  const identity =
    !locked && status?.templateVersion === LEDGER_NATIVE_TEMPLATE
      ? `${status.vaultId}:${status.ledgerSavings?.descriptorHash}`
      : ''
  const generation = useMemo(() => ({ identity }), [identity])
  const active = useRef<typeof generation | null>(generation)
  active.current = generation

  const access = useCallback(() => {
    if (!identity || !status?.enrolled || !status.ledgerSavings || !enrollment || enrollment.vaultId !== status.vaultId)
      throw new Error('Unlock this Ledger vault before sending from Savings.')
    const saved = validateLedgerSavingsEnrollmentSecrets(enrollment.ledgerSavings, {
      context: status.ledgerSavings.context,
      spendingPolicy: status.ledgerSavings.spendingPolicy,
    })
    return { ...saved, enrollment: structuredClone(enrollment), status: structuredClone(status) }
  }, [identity, status, enrollment])

  const refresh = useCallback(async () => {
    const saved = access()
    const retained = await loadLedgerSavingsPayment(saved.contract)
    if (active.current === generation)
      setView((previous) =>
        retained
          ? previous?.record.candidateId === retained.candidateId
            ? previous
            : {
                record: retained,
                registration: saved.registration,
                outcome:
                  retained.phase === 'prepared' ? 'prepared' : retained.phase === 'signing' ? 'signing' : 'unknown',
              }
          : null,
      )
    const result = await reconcileLedgerSavingsPayment(saved.contract)
    if (active.current === generation)
      setView(
        result.kind !== 'none'
          ? { record: result.record, registration: saved.registration, outcome: result.kind }
          : null,
      )
    return result
  }, [access, generation])

  useEffect(() => {
    active.current = generation
    setView(null)
    return () => {
      active.current = null
    }
  }, [generation])
  useEffect(() => {
    if (!identity) return
    const run = () => {
      void refresh().catch(() => {
        /* Retain the last verified payment while offline. */
      })
    }
    run()
    const timer = window.setInterval(run, 20_000)
    return () => window.clearInterval(timer)
  }, [identity, refresh])

  const review = useCallback(
    async (draft: VaultSpend) => {
      const saved = access()
      const retained = await loadLedgerSavingsPayment(saved.contract)
      if (retained && retained.payment.destAddress === draft.address && retained.payment.amountSats === draft.amount) {
        const result = await reconcileLedgerSavingsPayment(saved.contract)
        if (!['broadcast', 'confirmed', 'conflicted'].includes(result.kind)) {
          if (active.current !== generation) throw new Error('The active vault changed. Review the payment again.')
          setView({
            record: retained,
            registration: saved.registration,
            outcome: result.kind === 'none' ? 'unknown' : result.kind,
          })
          return retained.payment.feeSats
        }
      }
      if (retained?.phase === 'prepared') await cancelLedgerSavingsPayment(saved.contract, retained.candidateId)
      const feeRate = Math.max(1, satPerVFromFeeEstimates(await fetchFeeEstimates()))
      const quote = await quoteLedgerSavingsPayment({
        contract: saved.contract,
        destAddress: draft.address,
        amountSats: draft.amount,
        feeRate,
      })
      if (active.current !== generation) throw new Error('The active vault changed. Review the payment again.')
      const record = await retainLedgerSavingsPayment(quote.payment)
      if (active.current === generation) setView({ record, registration: saved.registration, outcome: 'prepared' })
      return record.payment.feeSats
    },
    [access, generation],
  )

  const approve = useCallback(
    async (draft: VaultSpend) => {
      const saved = access()
      let record = await loadLedgerSavingsPayment(saved.contract)
      if (
        !record ||
        record.payment.destAddress !== draft.address ||
        record.payment.amountSats !== draft.amount ||
        record.payment.feeSats !== draft.fee
      )
        throw new Error('Review this Savings payment again.')
      if (active.current !== generation) throw new Error('The active vault changed. Review the payment again.')
      const result = await reconcileLedgerSavingsPayment(saved.contract)
      if (active.current !== generation) throw new Error('The active vault changed. Reopen the saved payment.')
      if (result.kind === 'conflicted')
        throw new Error('This payment was replaced by a confirmed transaction. Review a new payment.')
      if (result.kind === 'broadcast' || result.kind === 'confirmed') return record.candidateId
      if (record.txHex) return broadcastLedgerSavingsPayment(saved.contract, record.candidateId)
      record = await markLedgerSavingsSigning(saved.contract, record.candidateId)
      if (!record.phonePsbt) {
        if (active.current !== generation) throw new Error('The active vault changed. Reopen the saved payment.')
        const seed = await unlockLedgerSavingsSeed(saved.enrollment, saved.status)
        try {
          if (active.current !== generation) throw new Error('The active vault changed. Reopen the saved payment.')
          const signed = signLedgerSavingsSeed(record.payment, seed)
          record = await saveLedgerSavingsPhoneApproval(saved.contract, record.candidateId, signed)
        } finally {
          seed.fill(0)
        }
      }
      if (active.current !== generation) throw new Error('The active vault changed. Reopen the saved payment.')
      setView({ record, registration: saved.registration, outcome: 'signing' })
      return null
    },
    [access, generation],
  )

  const complete = useCallback(
    async (candidateId: string, signedPsbt: string) => {
      const saved = access()
      if (active.current !== generation) throw new Error('The active vault changed. Reopen the saved payment.')
      const record = await saveLedgerSavingsSigned(saved.contract, candidateId, signedPsbt)
      if (active.current === generation) setView({ record, registration: saved.registration, outcome: 'unknown' })
      // Saving both signatures precedes dispatch, so a lost response can resume exactly these bytes.
      if (active.current !== generation) throw new Error('The active vault changed. Reopen the saved payment.')
      return broadcastLedgerSavingsPayment(saved.contract, candidateId)
    },
    [access, generation],
  )

  return { view, review, approve, complete, refresh }
}
