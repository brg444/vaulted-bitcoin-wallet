import { useContext, type ReactNode } from 'react'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import { VaultSessionContext, type VaultSessionContextProps } from '../../vault/sessionContext'
import { emptySetupPlan } from '../../lib/vault/setupPlan'
import { CURRENT_SPENDING_POLICY_CAPABILITIES } from '../../lib/vault/spendingPolicy'
import { LedgerPaymentContext, type LedgerPaymentContextProps } from '../../vault/ledgerPaymentContext'

export type VaultTestContextProps = VaultContextProps & VaultSessionContextProps
const emptySession: VaultSessionContextProps = {
  setup: emptySetupPlan(),
  status: null,
  locked: false,
  privacyLock: false,
  setPrivacyLock: () => {},
  pendingLedgerSetup: null,
  ledgerApprovalPhase: 'idle',
  approveLedgerEnrollment: async () => {},
  cancelLedgerRegistration: () => {},
  enrolled: false,
  hasLocalEnrollment: false,
  ledgerAvailable: false,
  lightAvailable: false,
  enrollmentMode: 'token',
  spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
  acceptDesign: () => {},
  connectLedgerKey: async () => {},
  applyLedgerRecovery: () => {},
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
const emptyLedgerPayment: LedgerPaymentContextProps = {
  view: null,
  pending: null,
  hardwarePhase: 'idle',
  error: '',
  approveWithLedger: async () => '',
  cancelHardware: () => {},
}

/** Fixtures may override either context without reintroducing the application's shared facade. */
export function VaultTestProvider({
  value,
  children,
  ledgerPayment,
}: {
  value?: Partial<VaultTestContextProps>
  children: ReactNode
  ledgerPayment?: Partial<LedgerPaymentContextProps>
}) {
  const defaults = useContext(VaultContext)
  const inherited = useContext(VaultSessionContext)
  const inheritedLedger = useContext(LedgerPaymentContext)
  return (
    <VaultSessionContext.Provider value={{ ...emptySession, ...inherited, ...value }}>
      <LedgerPaymentContext.Provider value={{ ...emptyLedgerPayment, ...inheritedLedger, ...ledgerPayment }}>
        <VaultContext.Provider value={{ ...defaults, ...value }}>{children}</VaultContext.Provider>
      </LedgerPaymentContext.Provider>
    </VaultSessionContext.Provider>
  )
}
