import { useEffect, useRef, useState } from 'react'
import {
  readSpendingBitcoin,
  BITCOIN_PAYMENT_EVENT,
  type BitcoinPaymentJournal,
} from '../lib/vault/spendingBitcoinStore'
import { checkSpendingBitcoin } from '../lib/vault/spendingBitcoinFunding'
import type { VaultStatus } from '../lib/vault/types'

export function useSpendingBitcoin(status: VaultStatus | null, locked: boolean) {
  const [pending, setPending] = useState<{ operation: BitcoinPaymentJournal | null; error: string }>({
    operation: null,
    error: '',
  })
  const latest = useRef(status)
  latest.current = status
  useEffect(() => {
    let active = true,
      running = false
    const load = () => {
      if (!active) return
      try {
        setPending({ operation: !locked && latest.current ? readSpendingBitcoin(latest.current) : null, error: '' })
      } catch (error) {
        setPending({ operation: null, error: (error as Error).message })
      }
    }
    const refresh = async () => {
      if (running || locked || !latest.current?.enrolled) return
      running = true
      try {
        if (readSpendingBitcoin(latest.current)) await checkSpendingBitcoin(latest.current)
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
  return pending
}
