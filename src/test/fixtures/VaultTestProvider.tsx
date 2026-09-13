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
const emptyBitcoinPayment: BitcoinPaymentContextProps = {
  operation: null,
  journalError: '',
  outputs: undefined,
  pending: null,
  error: '',
  paymentError: undefined,
  notice: null,
  check: async () => null,
  cancel: async () => null,
}
const emptySpendingPayment: SpendingPaymentContextProps = {
  pendingPayments: [],
  resumingPayment: false,
  canReplaceInFlightSend: false,
  openPendingPayment: async () => {},
  replaceInFlightSend: async () => {},
  retryLightningRefund: async () => {},
}

// Each override key belongs to exactly one narrow application context. Listing
// the owners here keeps a fixture from landing a field in the wrong context.
const CONTEXT_KEYS: Record<string, readonly (keyof VaultTestContextProps)[]> = {
  session: Object.keys(emptySession) as (keyof VaultTestContextProps)[],
  navigation: ['screen', 'navigate', 'confirmConditions', 'openRecover', 'recoverEntry', 'recoverExit'],
  account: [
    'account',
    'setAccount',
    'positions',
    'accountReads',
    'watchedSavings',
    'updateWatchedSavings',
    'watchedSavingsTotalSats',
    'savingsAddress',
    'spendingArkAddress',
    'refreshBalance',
    'boardingAddress',
    'boardingError',
    'dailyLimit',
    'dailyRemaining',
    'dailySpent',
  ],
  send: [
    'spend',
    'setSpendDraft',
    'clearSpendDraft',
    'lastSend',
    'canSend',
    'reviewSpend',
    'approveSend',
    'lastTxid',
    'lastTxKind',
    'openSendScan',
    'scanOnSend',
    'clearSendScan',
  ],
  activity: ['history', 'allHistory', 'selectedTx', 'openTx', 'txReturn', 'loadOlderActivity', 'olderActivity'],
  recovery: [
    'downloadRecoveryKit',
    'backupRecoveryKit',
    'restoreRecoveryKit',
    'hasRecoveryKit',
    'backupRecoveryArchive',
    'downloadRecoveryArchive',
    'recoveryArchiveStatus',
    'recoveryArchiveError',
    'initiateAlert',
    'recoverMatureBoarding',
  ],
  interaction: ['busy', 'error', 'dismissError'],
  display: [
    'balanceUnit',
    'balanceRateStatus',
    'setBalanceUnit',
    'fiatDisplayRate',
    'fiatDisplayEnabled',
    'setFiatDisplay',
    'networkLabel',
    'liveNetwork',
  ],
  renewal: ['spendingRenewals'],
}
const CONTEXT_OWNERS = new Map<string, string>()
for (const [name, keys] of Object.entries(CONTEXT_KEYS)) {
  for (const key of keys) {
    if (CONTEXT_OWNERS.has(key))
      throw new Error(`VaultTestProvider key "${key}" is claimed by more than one narrow context`)
    CONTEXT_OWNERS.set(key, name)
  }
}

export type VaultTestOverrides = { [name: string]: Partial<VaultTestContextProps> }
export function partitionVaultTestOverrides(value: Partial<VaultTestContextProps> | undefined): VaultTestOverrides {
  const slices: VaultTestOverrides = {}
  for (const name of Object.keys(CONTEXT_KEYS)) slices[name] = {}
  for (const [key, entry] of Object.entries(value ?? {})) {
    const owner = CONTEXT_OWNERS.get(key)
    if (!owner) throw new Error(`VaultTestProvider override "${key}" belongs to no narrow application context`)
    ;(slices[owner] as Record<string, unknown>)[key] = entry
  }
  return slices
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
  const slices = partitionVaultTestOverrides(value)
  return (
    <VaultSessionContext.Provider
      value={{ ...emptySession, ...inheritedSession, ...(slices.session as Partial<VaultSessionContextProps>) }}
    >
      <LedgerPaymentContext.Provider value={{ ...emptyLedgerPayment, ...inheritedLedger, ...ledgerPayment }}>
        <BitcoinPaymentContext.Provider value={{ ...emptyBitcoinPayment, ...inheritedBitcoin, ...bitcoinPayment }}>
          <SpendingPaymentContext.Provider
            value={{ ...emptySpendingPayment, ...inheritedSpending, ...spendingPayment }}
          >
            <VaultNavigationContext.Provider
              value={{ ...inheritedNavigation, ...(slices.navigation as Partial<VaultNavigationContextProps>) }}
            >
              <VaultAccountContext.Provider
                value={{ ...inheritedAccount, ...(slices.account as Partial<VaultAccountContextProps>) }}
              >
                <VaultSendContext.Provider
                  value={{ ...inheritedSend, ...(slices.send as Partial<VaultSendContextProps>) }}
                >
                  <VaultActivityContext.Provider
                    value={{ ...inheritedActivity, ...(slices.activity as Partial<VaultActivityContextProps>) }}
                  >
                    <VaultRecoveryContext.Provider
                      value={{ ...inheritedRecovery, ...(slices.recovery as Partial<VaultRecoveryContextProps>) }}
                    >
                      <VaultInteractionContext.Provider
                        value={{
                          ...inheritedInteraction,
                          ...(slices.interaction as Partial<VaultInteractionContextProps>),
                        }}
                      >
                        <VaultDisplayContext.Provider
                          value={{ ...inheritedDisplay, ...(slices.display as Partial<VaultDisplayContextProps>) }}
                        >
                          <VaultRenewalContext.Provider
                            value={{ ...inheritedRenewal, ...(slices.renewal as Partial<VaultRenewalContextProps>) }}
                          >
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
