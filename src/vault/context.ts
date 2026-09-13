import type { WatchedSavingsAddress } from '../lib/vault/watchSavings'
import type { SpendingRenewalJournal } from '../lib/vault/vtxo/renewalStore'
import type { OlderActivityState } from '../lib/vault/accountBalances'
import { createContext } from 'react'
import type { VaultHistoryItem } from '../lib/vault/history'
import type { VaultBalanceUnit, VaultFiatDisplayRate } from '../lib/vault/fiatDisplay'
import type { VaultRateStatus } from '../lib/vault/useDisplayUnit'
import {
  EMPTY_VAULT_POSITIONS,
  EMPTY_ACCOUNT_BALANCE_READS,
  type AccountBalanceReads,
  type VaultAccountPositions,
} from '../lib/vault/balances'

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
  account: VaultAccount
  spendingRenewals?: SpendingRenewalJournal | null
  positions: VaultAccountPositions
  downloadRecoveryKit: () => string
  backupRecoveryArchive: () => Promise<void>
  downloadRecoveryArchive: (format?: 'encrypted' | 'portable') => Promise<string>
  recoveryArchiveStatus: string
  recoveryArchiveError: string
  backupRecoveryKit: () => Promise<boolean>
  accountReads: AccountBalanceReads
  boardingError: string
  boardingAddress: string
  restoreRecoveryKit: () => Promise<void>
  hasRecoveryKit: boolean
  initiateAlert: string
  approveSend: () => Promise<void>
  busy: boolean
  canSend: boolean
  confirmConditions: () => void
  dailyLimit: number
  dailyRemaining: number
  dailySpent: number
  error: string
  dismissError?: () => void
  fiatDisplayRate: VaultFiatDisplayRate | null
  fiatDisplayEnabled: boolean
  setFiatDisplay: (enabled: boolean) => Promise<VaultFiatDisplayRate | null>
  balanceUnit: VaultBalanceUnit
  balanceRateStatus: VaultRateStatus
  setBalanceUnit: (unit: VaultBalanceUnit) => Promise<VaultFiatDisplayRate | null>
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
  reviewSpend: () => Promise<void>
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
  spend: VaultSpend
  lastSend: VaultSpend | null
}

export const DEFAULT_SPEND_FEE_SATS = 500

export const VaultContext = createContext<VaultContextProps>({
  account: 'spend',
  positions: EMPTY_VAULT_POSITIONS,
  downloadRecoveryKit: () => '',
  backupRecoveryArchive: async () => {},
  downloadRecoveryArchive: async () => '',
  recoveryArchiveStatus: '',
  recoveryArchiveError: '',
  backupRecoveryKit: async () => false,
  accountReads: EMPTY_ACCOUNT_BALANCE_READS,
  boardingError: '',
  boardingAddress: '',
  restoreRecoveryKit: async () => {},
  hasRecoveryKit: false,
  initiateAlert: '',
  approveSend: async () => {},
  busy: false,
  canSend: false,
  confirmConditions: () => {},
  dailyLimit: 0,
  dailyRemaining: 0,
  dailySpent: 0,
  error: '',
  fiatDisplayRate: null,
  fiatDisplayEnabled: false,
  setFiatDisplay: async () => null,
  balanceUnit: 'sats',
  balanceRateStatus: 'idle',
  setBalanceUnit: async () => null,
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
  spend: { address: '', amount: 0, fee: DEFAULT_SPEND_FEE_SATS },
  lastSend: null,
})
