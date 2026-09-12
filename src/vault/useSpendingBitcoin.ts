import { useCallback, useEffect, useRef, useState } from 'react'
import {
  readSpendingBitcoin,
  BITCOIN_PAYMENT_EVENT,
  type BitcoinPaymentJournal,
} from '../lib/vault/spendingBitcoinStore'
import { acknowledgeSpendingBitcoinRecovery, checkSpendingBitcoin } from '../lib/vault/spendingBitcoinFunding'
import type { CommittedRecoveryCoverage } from '../lib/vault/recovery/committedCoverage'
import type { VaultStatus } from '../lib/vault/types'

export function useSpendingBitcoin(status: VaultStatus | null, locked: boolean) {
  const [pending, setPending] = useState<{ operation: BitcoinPaymentJournal | null; error: string }>({
    operation: null,
    error: '',
  })
  const latest = useRef({ status, locked })
  latest.current = { status, locked }
  const acknowledgeRecovery = useCallback(async (coverage: CommittedRecoveryCoverage) => {
    const { status, locked } = latest.current
    if (!status?.enrolled || locked || coverage.vaultId !== status.vaultId || coverage.network !== status.network)
      return
    try {
      await acknowledgeSpendingBitcoinRecovery(status, coverage)
    } catch {
      // Durable coverage can be acknowledged on the next payment refresh.
    }
  }, [])
  useEffect(() => {
    let active = true,
      running = false
    const load = () => {
      if (!active) return
      try {
        setPending({
          operation: !locked && latest.current.status ? readSpendingBitcoin(latest.current.status) : null,
          error: '',
        })
      } catch (error) {
        setPending({ operation: null, error: (error as Error).message })
      }
    }
    const refresh = async () => {
      const { status, locked } = latest.current
      if (running || locked || !status?.enrolled) return
      running = true
      try {
        const operation = readSpendingBitcoin(status)
        if (operation) {
          if (operation.stage !== 'confirmed') await checkSpendingBitcoin(status)
          if (!active || latest.current.locked) return
          await acknowledgeSpendingBitcoinRecovery(status)
        }
      } catch {
        // The saved operation stays visible during a network or reconciliation failure.
      } finally {
        running = false
        load()
      }
    }
    load()
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15000)
    window.addEventListener(BITCOIN_PAYMENT_EVENT, load)
    window.addEventListener('storage', load)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener(BITCOIN_PAYMENT_EVENT, load)
      window.removeEventListener('storage', load)
      window.removeEventListener('focus', refresh)
    }
  }, [status?.vaultId, locked])
  return { snapshot: pending, acknowledgeRecovery }
}
