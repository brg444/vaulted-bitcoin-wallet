import { useEffect, useRef, useState } from 'react'
import type { VaultStatus } from '../lib/vault/types'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import { LIGHT_PROFILE } from '../lib/vault/light/contract'
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
    let active = true,
      running = false
    const load = async () => {
      const current = latest.current.status
      if (!current?.enrolled || current.templateVersion === LIGHT_PROFILE) return
      try {
        const saved = await loadSpendingRenewals(current)
        if (active) setJournal(saved)
      } catch {
        /* Renewal failures stay separate from ordinary wallet availability. */
      }
    }
    const refresh = async () => {
      const current = latest.current
      if (
        running ||
        !current.status?.enrolled ||
        !current.enrollment ||
        current.status.templateVersion === LIGHT_PROFILE
      )
        return
      running = true
      try {
        const saved = await refreshSpendingRenewals(current.status, current.enrollment)
        if (active) setJournal(saved)
      } catch {
        await load()
      } finally {
        running = false
      }
    }
    const onChange = (event: Event) => {
      if ((event as CustomEvent<string>).detail === vaultId) void load()
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30000)
    window.addEventListener(SPENDING_RENEWAL_EVENT, onChange)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      clearSpendingRenewalReads(vaultId)
      window.clearInterval(timer)
      window.removeEventListener(SPENDING_RENEWAL_EVENT, onChange)
      window.removeEventListener('focus', refresh)
    }
  }, [vaultId, locked])
  return journal
}
