import { useContext, type ReactNode } from 'react'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import { VaultSessionContext, type VaultSessionContextProps } from '../../vault/sessionContext'
import { emptySetupPlan } from '../../lib/vault/setupPlan'
import { CURRENT_SPENDING_POLICY_CAPABILITIES } from '../../lib/vault/spendingPolicy'

export type VaultTestContextProps = VaultContextProps & VaultSessionContextProps
const emptySession: VaultSessionContextProps = {
  setup: emptySetupPlan(),
  status: null,
  locked: false,
  privacyLock: false,
  setPrivacyLock: () => {},
  pendingLedgerSetup: null,
  enrolled: false,
  hasLocalEnrollment: false,
  ledgerAvailable: false,
  lightAvailable: false,
  enrollmentMode: 'token',
  spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
  acceptDesign: () => {},
  connectLedgerKey: async () => {},
  applyLedgerRecovery: () => {},
  completeLedgerEnrollment: async () => {},
  setProtectionTier: () => {},
  skipRecovery: () => {},
  setSpendingPolicy: () => {},
  finishPlan: () => {},
  enroll: async () => {},
  signIn: async () => {},
  enablePasskeyLogin: async () => {},
  restoreRecoveryArchive: async () => {},
  reset: () => {},
}

/** Fixtures may override either context without reintroducing the application's shared facade. */
export function VaultTestProvider({
  value,
  children,
}: {
  value?: Partial<VaultTestContextProps>
  children: ReactNode
}) {
  const defaults = useContext(VaultContext)
  const inherited = useContext(VaultSessionContext)
  return (
    <VaultSessionContext.Provider value={{ ...emptySession, ...inherited, ...value }}>
      <VaultContext.Provider value={{ ...defaults, ...value }}>{children}</VaultContext.Provider>
    </VaultSessionContext.Provider>
  )
}
