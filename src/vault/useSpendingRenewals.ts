import { useEffect, useRef, useState } from 'react'
import { vaultAccountRuntime } from '../lib/vault/accountRuntime'
import type { VaultStatus } from '../lib/vault/types'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import { clearSpendingRenewalReads, refreshSpendingRenewals } from '../lib/vault/vtxo/guardianRenewal'
import {
  loadSpendingRenewals,
  SPENDING_RENEWAL_EVENT,
  type SpendingRenewalJournal,
} from '../lib/vault/vtxo/renewalStore'

export function useSpendingRenewals(status: VaultStatus | null, enrollment: EnrollmentSecrets | null, locked: boolean) {
  const [journal, setJournal] = useState<SpendingRenewalJournal | null>(null)
  const latest = useRef({ status, enrollment })
  latest.current = { status, enrollment }
  const vaultId = status?.vaultId
  useEffect(() => {
    setJournal(null)
    if (!vaultId || locked) {
      if (vaultId) clearSpendingRenewalReads(vaultId)
      return
    }
    let active = true
    const load = async (signal?: AbortSignal) => {
      const current = latest.current.status
      if (!current?.enrolled) return
      try {
        const saved = await loadSpendingRenewals(current)
        if (active && !signal?.aborted) setJournal(saved)
      } catch {
        /* Renewal failures stay separate from ordinary wallet availability. */
      }
    }
    const refresh = async (signal: AbortSignal) => {
      const current = latest.current
      if (!current.status?.enrolled || !current.enrollment) return
      try {
        const saved = await refreshSpendingRenewals(current.status, current.enrollment)
        if (active && !signal.aborted) setJournal(saved)
      } catch {
        if (!signal.aborted) await load(signal)
      }
    }
    const onChange = (event: Event) => {
      if ((event as CustomEvent<string>).detail === vaultId) void load()
    }
    const task = latest.current.status?.enrolled
      ? vaultAccountRuntime(latest.current.status).maintenance.observe('spending-renewals', refresh, {
          intervalMs: 30_000,
        })
      : undefined
    task?.request()
    window.addEventListener(SPENDING_RENEWAL_EVENT, onChange)
    return () => {
      active = false
      clearSpendingRenewalReads(vaultId)
      void task?.dispose()
      window.removeEventListener(SPENDING_RENEWAL_EVENT, onChange)
    }
  }, [vaultId, status?.network, locked])
  return journal
}
