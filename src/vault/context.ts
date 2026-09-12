import type { WatchedSavingsAddress } from '../lib/vault/watchSavings'
import type { LedgerSavingsView } from './useLedgerSavings'
import type { BitcoinPaymentError } from '../lib/vault/bitcoinPaymentError'
import type { BitcoinPaymentJournal, BitcoinPaymentOutput } from '../lib/vault/spendingBitcoinStore'
import type { SpendingRenewalJournal } from '../lib/vault/vtxo/renewalStore'
import type { OlderActivityState } from '../lib/vault/accountBalances'
import { createContext } from 'react'
import type { VaultHistoryItem } from '../lib/vault/history'
import { emptySetupPlan, type VaultSetupPlan } from '../lib/vault/setupPlan'
import type { VaultStatus } from '../lib/vault/types'
import {
  CURRENT_SPENDING_POLICY_CAPABILITIES,
  type SpendingPolicy,
  type SpendingPolicyCapabilities,
} from '../lib/vault/spendingPolicy'
import type { ProtectionTier } from '../lib/vault/protectionTier'
import type { VaultBalanceUnit, VaultFiatDisplayRate } from '../lib/vault/fiatDisplay'
import type { VaultRateStatus } from '../lib/vault/useDisplayUnit'
import {
  EMPTY_VAULT_POSITIONS,
  EMPTY_ACCOUNT_BALANCE_READS,
  type AccountBalanceReads,
  type VaultAccountPositions,
} from '../lib/vault/balances'
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
  | 'recovery'
  | 'recover'
  | 'tx'

export interface VaultSpend {
  address: string
  amount: number
  fee: number
}

export interface VaultContextProps {
  watchedSavings?: WatchedSavingsAddress | null
  updateWatchedSavings?: (address: string, label: string) => void
  watchedSavingsTotalSats?: number | null
  ledgerPayment: LedgerSavingsView | null
  completeLedgerPayment: (candidateId: string, signedPsbt: string) => Promise<void>
  ledgerAvailable: boolean
  connectLedgerKey: (role: 'hardware' | 'recovery') => Promise<void>
  applyLedgerRecovery: (raw: string) => void
  completeLedgerEnrollment: (registration: LedgerSavingsRegistration) => Promise<void>
  acceptDesign: (tier?: 'light' | 'standard' | 'advanced') => void
  account: VaultAccount
  spendingRenewals?: SpendingRenewalJournal | null
  spendingBitcoin?: { operation: BitcoinPaymentJournal | null; error: string }
  positions: VaultAccountPositions
  setProtectionTier: (tier: ProtectionTier) => void
  skipRecovery: () => void
  downloadRecoveryKit: () => string
  backupRecoveryArchive: () => Promise<void>
  downloadRecoveryArchive: (format?: 'encrypted' | 'portable') => Promise<string>
  recoveryArchiveStatus: string
  recoveryArchiveError: string
  backupRecoveryKit: () => Promise<boolean>
  accountReads: AccountBalanceReads
  boardingError: string
  boardingAddress: string
  restoreRecoveryArchive: (raw?: unknown) => Promise<void>
  restoreRecoveryKit: () => Promise<void>
  hasRecoveryKit: boolean
  initiateAlert: string
  approveSend: () => Promise<void>
  busy: boolean
  canSend: boolean
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
  balanceUnit: VaultBalanceUnit
  balanceRateStatus: VaultRateStatus
  setBalanceUnit: (unit: VaultBalanceUnit) => Promise<VaultFiatDisplayRate | null>
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
  reset: () => void
  reviewSpend: () => Promise<void>
  bitcoinOutputs?: BitcoinPaymentOutput[]
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
  setProtectionTier: () => {},
  skipRecovery: () => {},
  downloadRecoveryKit: () => '',
  backupRecoveryArchive: async () => {},
  downloadRecoveryArchive: async () => '',
  recoveryArchiveStatus: '',
  recoveryArchiveError: '',
  backupRecoveryKit: async () => false,
  accountReads: EMPTY_ACCOUNT_BALANCE_READS,
  boardingError: '',
  boardingAddress: '',
  restoreRecoveryArchive: async () => {},
  restoreRecoveryKit: async () => {},
  hasRecoveryKit: false,
  initiateAlert: '',
  approveSend: async () => {},
  busy: false,
  canSend: false,
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
  balanceUnit: 'sats',
  balanceRateStatus: 'idle',
  setBalanceUnit: async () => null,
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
  reset: () => {},
  reviewSpend: async () => {},
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
