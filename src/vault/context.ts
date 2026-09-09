import type { LedgerSavingsView } from './useLedgerSavings'
import type { BitcoinPaymentError } from '../lib/vault/bitcoinPaymentError'
import type { BitcoinPaymentJournal, BitcoinPaymentOutput } from '../lib/vault/spendingBitcoinStore'
import type { SpendingRenewalJournal } from '../lib/vault/vtxo/renewalStore'
import type { OlderActivityState } from './useVaultBalances'
import type { PaymentArrival, PaymentCatchUp } from './usePaymentArrivals'
import { createContext } from 'react'
import type { VaultHistoryItem } from '../lib/vault/history'
import { emptySetupPlan, type VaultSetupPlan } from '../lib/vault/setupPlan'
import type { VaultStatus } from '../lib/vault/types'
import type { InitiateAlert } from '../lib/vault/program/watch'
import {
  CURRENT_SPENDING_POLICY_CAPABILITIES,
  type SpendingPolicy,
  type SpendingPolicyCapabilities,
} from '../lib/vault/spendingPolicy'
import type { ProtectionTier } from '../lib/vault/protectionTier'
import type { VaultFiatDisplayRate } from '../lib/vault/fiatDisplay'
import { EMPTY_VAULT_POSITIONS, type VaultAccountPositions } from './balances'
import type { LedgerSavingsRegistration } from '../lib/vault/ledgerClient'

export type VaultAccount = 'spend' | 'savings'

export type VaultScreen =
  | 'welcome'
  | 'unlock'
  | 'design'
  | 'hardware'
  | 'ledger-register'
  | 'ledger-sign'
  | 'conditions'
  | 'plan'
  | 'passkey'
  | 'creating'
  | 'created'
  | 'kit'
  | 'ready'
  | 'problem'
  | 'home'
  | 'receive'
  | 'activity'
  | 'send'
  | 'review'
  | 'success'
  | 'keys'
  | 'settings'
  | 'signin'
  | 'handoff'
  | 'recovery'
  | 'recover'
  | 'tx'

export interface VaultSpend {
  address: string
  amount: number
  fee: number
}

export interface VaultContextProps {
  ledgerPayment: LedgerSavingsView | null
  completeLedgerPayment: (candidateId: string, signedPsbt: string) => Promise<void>
  ledgerAvailable: boolean
  connectLedgerKey: (role: 'hardware' | 'recovery') => Promise<void>
  applyLedgerRecovery: (raw: string) => void
  completeLedgerEnrollment: (registration: LedgerSavingsRegistration) => Promise<void>
  acceptDesign: (tier?: 'standard' | 'advanced') => void
  account: VaultAccount
  spendingRenewals?: SpendingRenewalJournal | null
  spendingBitcoin?: { operation: BitcoinPaymentJournal | null; error: string }
  positions: VaultAccountPositions
  applyHardware: (raw: string) => void
  applyConnectorDescriptor: (raw: string) => void
  applyRecovery: (raw: string) => void
  setProtectionTier: (tier: ProtectionTier) => void
  skipRecovery: () => void
  downloadRecoveryKit: () => string
  backupRecoveryArchive: () => Promise<void>
  downloadRecoveryArchive: (format?: 'encrypted' | 'portable') => Promise<string>
  recoveryArchiveStatus: string
  recoveryArchiveError: string
  backupRecoveryKit: () => Promise<boolean>
  balanceError: string
  balancesLoaded: boolean
  boardingAddress: string
  restoreRecoveryArchive: (raw?: unknown) => Promise<void>
  restoreRecoveryKit: () => Promise<void>
  signGuardianExitWithDevice: (psbtHex: string) => Promise<string>
  hasRecoveryKit: boolean
  initiateAlert: string
  initiateAlerts: InitiateAlert[]
  approveSend: () => Promise<void>
  busy: boolean
  canSend: boolean
  cancelSavingsHandoff: () => void
  completeSavingsHandoff: (signedPsbt: string) => Promise<void>
  handoffPsbt: string
  confirmConditions: () => void
  setSpendingPolicy: (policy: SpendingPolicy) => void
  spendingPolicyCapabilities: SpendingPolicyCapabilities
  dailyLimit: number
  dailyRemaining: number
  dailySpent: number
  enablePasskeyLogin: () => Promise<void>
  lightAvailable: boolean
  enrollmentMode: string
  enroll: (token?: string) => Promise<void>
  enrolled: boolean
  error: string
  paymentError?: BitcoinPaymentError
  dismissError?: () => void
  fiatDisplayRate: VaultFiatDisplayRate | null
  fiatDisplayEnabled: boolean
  setFiatDisplay: (enabled: boolean) => Promise<VaultFiatDisplayRate | null>
  signIn: () => Promise<void>
  finishPlan: () => void
  hasLocalEnrollment: boolean
  locked: boolean
  lastTxid: string
  lastTxKind: 'onchain' | 'vtxo' | 'lightning' | ''
  history: VaultHistoryItem[]
  selectedTx: VaultHistoryItem | null
  openTx: (tx: VaultHistoryItem) => void
  txReturn: VaultScreen
  allHistory: VaultHistoryItem[]
  loadOlderActivity: () => Promise<{ added: number; exhausted: boolean }>
  olderActivity: OlderActivityState
  arrivals: PaymentArrival[]
  dismissArrival: (key: string) => void
  openArrival: (key: string) => void
  catchUp: PaymentCatchUp | null
  dismissCatchUp: () => void
  liveNetwork: boolean
  navigate: (screen: VaultScreen) => void
  openRecover: (view?: 'kit' | 'lost', exit?: VaultScreen) => void
  recoverEntry: 'kit' | 'lost'
  recoverExit: VaultScreen
  recoverMatureBoarding: () => Promise<string>
  networkLabel: string
  spendingArkAddress: string
  refreshBalance: () => Promise<void>
  retryLightningRefund: (rfqId: string) => Promise<void>
  refreshingBalance: boolean
  reset: () => void
  reviewSpend: () => Promise<void>
  fundSavingsSigner: () => Promise<void>
  bitcoinOutputs?: BitcoinPaymentOutput[]
  rebroadcastingConnector: boolean
  resumingPayment: boolean
  pendingPayments: { operationId: string; amountSats: number; authorized: boolean }[]
  openPendingPayment: (operationId: string) => Promise<void>
  canReplaceInFlightSend: boolean
  replaceInFlightSend: () => Promise<void>
  openSendScan: () => void
  scanOnSend: boolean
  clearSendScan: () => void
  savingsAddress: string
  screen: VaultScreen
  setAccount: (account: VaultAccount) => void
  clearSpendDraft: () => void
  setSpendDraft: (draft: Partial<VaultSpend>) => void
  setup: VaultSetupPlan
  spend: VaultSpend
  status: VaultStatus | null
  lastSend: VaultSpend | null
}

export const DEFAULT_SPEND_FEE_SATS = 500

export const VaultContext = createContext<VaultContextProps>({
  ledgerPayment: null,
  completeLedgerPayment: async () => {},
  ledgerAvailable: false,
  connectLedgerKey: async () => {},
  applyLedgerRecovery: () => {},
  completeLedgerEnrollment: async () => {},
  acceptDesign: () => {},
  account: 'spend',
  positions: EMPTY_VAULT_POSITIONS,
  applyHardware: () => {},
  applyConnectorDescriptor: () => {},
  applyRecovery: () => {},
  setProtectionTier: () => {},
  skipRecovery: () => {},
  downloadRecoveryKit: () => '',
  backupRecoveryArchive: async () => {},
  downloadRecoveryArchive: async () => '',
  recoveryArchiveStatus: '',
  recoveryArchiveError: '',
  backupRecoveryKit: async () => false,
  balanceError: '',
  balancesLoaded: false,
  boardingAddress: '',
  restoreRecoveryArchive: async () => {},
  restoreRecoveryKit: async () => {},
  signGuardianExitWithDevice: async () => '',
  hasRecoveryKit: false,
  initiateAlert: '',
  initiateAlerts: [],
  approveSend: async () => {},
  busy: false,
  canSend: false,
  cancelSavingsHandoff: () => {},
  completeSavingsHandoff: async () => {},
  handoffPsbt: '',
  confirmConditions: () => {},
  setSpendingPolicy: () => {},
  spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
  dailyLimit: 0,
  dailyRemaining: 0,
  dailySpent: 0,
  enablePasskeyLogin: async () => {},
  lightAvailable: false,
  enrollmentMode: 'token',
  enroll: async () => {},
  enrolled: false,
  error: '',
  fiatDisplayRate: null,
  fiatDisplayEnabled: false,
  setFiatDisplay: async () => null,
  signIn: async () => {},
  finishPlan: () => {},
  hasLocalEnrollment: false,
  locked: false,
  lastTxid: '',
  lastTxKind: '',
  history: [],
  selectedTx: null,
  openTx: () => {},
  txReturn: 'home',
  allHistory: [],
  loadOlderActivity: async () => ({ added: 0, exhausted: true }),
  olderActivity: { status: 'idle', error: '' },
  arrivals: [],
  dismissArrival: () => {},
  openArrival: () => {},
  catchUp: null,
  dismissCatchUp: () => {},
  liveNetwork: false,
  navigate: () => {},
  openRecover: () => {},
  recoverEntry: 'kit',
  recoverExit: 'keys',
  recoverMatureBoarding: async () => '',
  networkLabel: 'Test network',
  spendingArkAddress: '',
  refreshBalance: async () => {},
  retryLightningRefund: async () => {},
  refreshingBalance: false,
  reset: () => {},
  reviewSpend: async () => {},
  fundSavingsSigner: async () => {},
  rebroadcastingConnector: false,
  resumingPayment: false,
  pendingPayments: [],
  openPendingPayment: async () => {},
  canReplaceInFlightSend: false,
  replaceInFlightSend: async () => {},
  openSendScan: () => {},
  scanOnSend: false,
  clearSendScan: () => {},
  savingsAddress: '',
  screen: 'welcome',
  setAccount: () => {},
  clearSpendDraft: () => {},
  setSpendDraft: () => {},
  setup: emptySetupPlan(),
  spend: { address: '', amount: 0, fee: DEFAULT_SPEND_FEE_SATS },
  status: null,
  lastSend: null,
})
