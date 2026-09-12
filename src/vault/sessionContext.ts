import { createContext, useContext } from 'react'
import type { VaultSession, VaultSessionSnapshot } from '../lib/vault/session'
import { CURRENT_SPENDING_POLICY_CAPABILITIES } from '../lib/vault/spendingPolicy'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'

export function sessionView(snapshot: VaultSessionSnapshot, session: VaultSession) {
  const { setup, status, enrollment, stagedEnrollment, deployment, locked, privacyLock } = snapshot
  return {
    setup,
    status,
    locked,
    privacyLock,
    setPrivacyLock: session.setPrivacyLock,
    pendingLedgerSetup: stagedEnrollment?.ledgerSavingsDraft
      ? { contract: stagedEnrollment.ledgerSavingsDraft.contract, registered: Boolean(stagedEnrollment.ledgerSavings) }
      : null,
    enrolled: Boolean(status?.enrolled),
    hasLocalEnrollment: Boolean(enrollment),
    ledgerAvailable:
      deployment?.ledgerSavingsCapability?.version === 1 &&
      deployment.ledgerSavingsCapability.templateVersion === LEDGER_NATIVE_TEMPLATE,
    lightAvailable: Boolean(deployment?.supportedSetups?.includes('light')),
    enrollmentMode: deployment?.enrollmentMode || 'loading',
    spendingPolicyCapabilities: deployment?.spendingPolicyCapabilities || CURRENT_SPENDING_POLICY_CAPABILITIES,
    acceptDesign: session.acceptDesign,
    connectLedgerKey: session.connectLedgerKey,
    applyLedgerRecovery: session.applyLedgerRecovery,
    completeLedgerEnrollment: session.completeLedgerEnrollment,
    setProtectionTier: session.setProtectionTier,
    skipRecovery: session.skipRecovery,
    setSpendingPolicy: session.setSpendingPolicy,
    finishPlan: session.finishPlan,
    enroll: session.enroll,
    signIn: session.signIn,
    enablePasskeyLogin: session.enableOtherDevices,
    restoreRecoveryArchive: session.restoreRecoveryArchive,
    reset: () => {
      void session.signOut().catch(() => undefined)
    },
  }
}
export type VaultSessionContextProps = ReturnType<typeof sessionView>
export const VaultSessionContext = createContext<VaultSessionContextProps | null>(null)
export function useSession() {
  const session = useContext(VaultSessionContext)
  if (!session) throw new Error('Vault session provider required')
  return session
}
