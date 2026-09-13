import { SpendingPaymentContext, type SpendingPaymentContextProps } from '../../vault/spendingPaymentContext'
import { BitcoinPaymentContext, type BitcoinPaymentContextProps } from '../../vault/bitcoinPaymentContext'
import { useContext, type ReactNode } from 'react'
import { VaultSessionContext, type VaultSessionContextProps } from '../../vault/sessionContext'
import { emptySetupPlan } from '../../lib/vault/setupPlan'
import { CURRENT_SPENDING_POLICY_CAPABILITIES } from '../../lib/vault/spendingPolicy'
import { LedgerPaymentContext, type LedgerPaymentContextProps } from '../../vault/ledgerPaymentContext'
import {
  VaultAccountContext,
  VaultActivityContext,
  VaultDisplayContext,
  VaultInteractionContext,
  VaultNavigationContext,
  VaultRecoveryContext,
  VaultRenewalContext,
  VaultSendContext,
  type VaultAccountContextProps,
  type VaultActivityContextProps,
  type VaultDisplayContextProps,
  type VaultInteractionContextProps,
  type VaultNavigationContextProps,
  type VaultRecoveryContextProps,
  type VaultRenewalContextProps,
  type VaultSendContextProps,
} from '../../vault/appContexts'

export type VaultTestContextProps = VaultSessionContextProps &
  VaultNavigationContextProps &
  VaultAccountContextProps &
  VaultSendContextProps &
  VaultActivityContextProps &
  VaultRecoveryContextProps &
  VaultInteractionContextProps &
  VaultDisplayContextProps &
  VaultRenewalContextProps
const emptySession: VaultSessionContextProps = {
  setup: emptySetupPlan(),
  status: null,
  admitted: null,
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

/** Fixtures may override any narrow application API without reintroducing a shared facade. */
export function VaultTestProvider({
  value,
  children,
  ledgerPayment,
  bitcoinPayment,
  spendingPayment,
}: {
  value?: Partial<VaultTestContextProps>
  children: ReactNode
  ledgerPayment?: Partial<LedgerPaymentContextProps>
  bitcoinPayment?: Partial<BitcoinPaymentContextProps>
  spendingPayment?: Partial<SpendingPaymentContextProps>
}) {
  const inheritedSession = useContext(VaultSessionContext)
  const inheritedNavigation = useContext(VaultNavigationContext)
  const inheritedAccount = useContext(VaultAccountContext)
  const inheritedSend = useContext(VaultSendContext)
  const inheritedActivity = useContext(VaultActivityContext)
  const inheritedRecovery = useContext(VaultRecoveryContext)
  const inheritedInteraction = useContext(VaultInteractionContext)
  const inheritedDisplay = useContext(VaultDisplayContext)
  const inheritedRenewal = useContext(VaultRenewalContext)
  const inheritedBitcoin = useContext(BitcoinPaymentContext)
  const inheritedSpending = useContext(SpendingPaymentContext)
  const inheritedLedger = useContext(LedgerPaymentContext)
  return (
    <VaultSessionContext.Provider value={{ ...emptySession, ...inheritedSession, ...value }}>
      <LedgerPaymentContext.Provider value={{ ...emptyLedgerPayment, ...inheritedLedger, ...ledgerPayment }}>
        <BitcoinPaymentContext.Provider
          value={{
            operation: null,
            journalError: '',
            outputs: undefined,
            pending: null,
            error: '',
            paymentError: undefined,
            notice: null,
            check: async () => null,
            cancel: async () => null,
            ...inheritedBitcoin,
            ...bitcoinPayment,
          }}
        >
          <SpendingPaymentContext.Provider
            value={{
              pendingPayments: [],
              resumingPayment: false,
              canReplaceInFlightSend: false,
              openPendingPayment: async () => {},
              replaceInFlightSend: async () => {},
              retryLightningRefund: async () => {},
              ...inheritedSpending,
              ...spendingPayment,
            }}
          >
            <VaultNavigationContext.Provider value={{ ...inheritedNavigation, ...value }}>
              <VaultAccountContext.Provider value={{ ...inheritedAccount, ...value }}>
                <VaultSendContext.Provider value={{ ...inheritedSend, ...value }}>
                  <VaultActivityContext.Provider value={{ ...inheritedActivity, ...value }}>
                    <VaultRecoveryContext.Provider value={{ ...inheritedRecovery, ...value }}>
                      <VaultInteractionContext.Provider value={{ ...inheritedInteraction, ...value }}>
                        <VaultDisplayContext.Provider value={{ ...inheritedDisplay, ...value }}>
                          <VaultRenewalContext.Provider value={{ ...inheritedRenewal, ...value }}>
                            {children}
                          </VaultRenewalContext.Provider>
                        </VaultDisplayContext.Provider>
                      </VaultInteractionContext.Provider>
                    </VaultRecoveryContext.Provider>
                  </VaultActivityContext.Provider>
                </VaultSendContext.Provider>
              </VaultAccountContext.Provider>
            </VaultNavigationContext.Provider>
          </SpendingPaymentContext.Provider>
        </BitcoinPaymentContext.Provider>
      </LedgerPaymentContext.Provider>
    </VaultSessionContext.Provider>
  )
}
