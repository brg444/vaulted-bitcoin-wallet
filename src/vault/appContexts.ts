import { createContext, useContext } from 'react'
import type { WatchedSavingsAddress } from '../lib/vault/watchSavings'
import type { SpendingRenewalJournal } from '../lib/vault/vtxo/renewalStore'
import type { OlderActivityState } from '../lib/vault/accountBalances'
import type { VaultHistoryItem } from '../lib/vault/history'
import type { VaultBalanceUnit, VaultFiatDisplayRate } from '../lib/vault/fiatDisplay'
import type { VaultRateStatus } from '../lib/vault/useDisplayUnit'
import {
  EMPTY_ACCOUNT_BALANCE_READS,
  EMPTY_VAULT_POSITIONS,
  type AccountBalanceReads,
  type VaultAccountPositions,
} from '../lib/vault/balances'
import type { VaultAccount, VaultScreen, VaultSpend } from './context'

/** Narrow presentation contexts. Each has one writer in the provider bindings. */
export interface VaultNavigationContextProps {
  screen: VaultScreen
  navigate: (screen: VaultScreen) => void
  confirmConditions: () => void
  openRecover: (view?: 'kit' | 'lost', exit?: VaultScreen) => void
  recoverEntry: 'kit' | 'lost'
  recoverExit: VaultScreen
}

export interface VaultAccountContextProps {
  account: VaultAccount
  setAccount: (account: VaultAccount) => void
  positions: VaultAccountPositions
  accountReads: AccountBalanceReads
  watchedSavings?: WatchedSavingsAddress | null
  updateWatchedSavings?: (address: string, label: string) => void
  watchedSavingsTotalSats?: number | null
  savingsAddress: string
  spendingArkAddress: string
  refreshBalance: () => Promise<void>
  boardingAddress: string
  boardingError: string
  dailyLimit: number
  dailyRemaining: number
  dailySpent: number
}

export interface VaultSendContextProps {
  spend: VaultSpend
  setSpendDraft: (draft: Partial<VaultSpend>) => void
  clearSpendDraft: () => void
  lastSend: VaultSpend | null
  canSend: boolean
  reviewSpend: () => Promise<void>
  approveSend: () => Promise<void>
  lastTxid: string
  lastTxKind: 'onchain' | 'vtxo' | 'lightning' | ''
  starting: boolean
  openSendScan: () => void
  scanOnSend: boolean
  clearSendScan: () => void
}

export interface VaultActivityContextProps {
  history: VaultHistoryItem[]
  allHistory: VaultHistoryItem[]
  selectedTx: VaultHistoryItem | null
  openTx: (tx: VaultHistoryItem) => void
  txReturn: VaultScreen
  loadOlderActivity: () => Promise<{ added: number; exhausted: boolean }>
  olderActivity: OlderActivityState
}

export interface VaultRecoveryContextProps {
  downloadRecoveryKit: () => string
  backupRecoveryKit: () => Promise<boolean>
  restoreRecoveryKit: () => Promise<void>
  hasRecoveryKit: boolean
  backupRecoveryArchive: () => Promise<void>
  downloadRecoveryArchive: (format?: 'encrypted' | 'portable') => Promise<string>
  recoveryArchiveStatus: string
  recoveryArchiveError: string
  initiateAlert: string
  recoverMatureBoarding: () => Promise<string>
}

export interface VaultInteractionContextProps {
  busy: boolean
  error: string
  dismissError?: () => void
}

export interface VaultDisplayContextProps {
  balanceUnit: VaultBalanceUnit
  balanceRateStatus: VaultRateStatus
  setBalanceUnit: (unit: VaultBalanceUnit) => Promise<VaultFiatDisplayRate | null>
  fiatDisplayRate: VaultFiatDisplayRate | null
  fiatDisplayEnabled: boolean
  setFiatDisplay: (enabled: boolean) => Promise<VaultFiatDisplayRate | null>
  networkLabel: string
  liveNetwork: boolean
}

export interface VaultRenewalContextProps {
  spendingRenewals: SpendingRenewalJournal | null
}

const noop = () => {}
const resolved = async () => null
const emptyActivity = async () => ({ added: 0, exhausted: true })

export const VaultNavigationContext = createContext<VaultNavigationContextProps>({
  screen: 'welcome',
  navigate: noop,
  confirmConditions: noop,
  openRecover: noop,
  recoverEntry: 'kit',
  recoverExit: 'keys',
})

export const VaultAccountContext = createContext<VaultAccountContextProps>({
  account: 'spend',
  setAccount: noop,
  positions: EMPTY_VAULT_POSITIONS,
  accountReads: EMPTY_ACCOUNT_BALANCE_READS,
  watchedSavings: null,
  updateWatchedSavings: noop,
  watchedSavingsTotalSats: undefined,
  savingsAddress: '',
  spendingArkAddress: '',
  refreshBalance: async () => {},
  boardingAddress: '',
  boardingError: '',
  dailyLimit: 0,
  dailyRemaining: 0,
  dailySpent: 0,
})

export const VaultSendContext = createContext<VaultSendContextProps>({
  spend: { address: '', amount: 0, fee: 0 },
  setSpendDraft: noop,
  clearSpendDraft: noop,
  lastSend: null,
  canSend: false,
  reviewSpend: async () => {},
  approveSend: async () => {},
  lastTxid: '',
  lastTxKind: '',
  starting: false,
  openSendScan: noop,
  scanOnSend: false,
  clearSendScan: noop,
})

export const VaultActivityContext = createContext<VaultActivityContextProps>({
  history: [],
  allHistory: [],
  selectedTx: null,
  openTx: noop,
  txReturn: 'home',
  loadOlderActivity: emptyActivity,
  olderActivity: { status: 'idle', error: '' },
})

export const VaultRecoveryContext = createContext<VaultRecoveryContextProps>({
  downloadRecoveryKit: () => '',
  backupRecoveryKit: async () => false,
  restoreRecoveryKit: async () => {},
  hasRecoveryKit: false,
  backupRecoveryArchive: async () => {},
  downloadRecoveryArchive: async () => '',
  recoveryArchiveStatus: '',
  recoveryArchiveError: '',
  initiateAlert: '',
  recoverMatureBoarding: async () => '',
})

export const VaultInteractionContext = createContext<VaultInteractionContextProps>({
  busy: false,
  error: '',
  dismissError: noop,
})

export const VaultDisplayContext = createContext<VaultDisplayContextProps>({
  balanceUnit: 'sats',
  balanceRateStatus: 'idle',
  setBalanceUnit: resolved,
  fiatDisplayRate: null,
  fiatDisplayEnabled: false,
  setFiatDisplay: resolved,
  networkLabel: 'Test network',
  liveNetwork: false,
})

export const VaultRenewalContext = createContext<VaultRenewalContextProps>({ spendingRenewals: null })

export const useVaultNavigation = () => useContext(VaultNavigationContext)
export const useVaultAccount = () => useContext(VaultAccountContext)
export const useVaultSend = () => useContext(VaultSendContext)
export const useVaultActivity = () => useContext(VaultActivityContext)
export const useVaultRecovery = () => useContext(VaultRecoveryContext)
export const useVaultInteraction = () => useContext(VaultInteractionContext)
export const useVaultDisplay = () => useContext(VaultDisplayContext)
export const useVaultRenewals = () => useContext(VaultRenewalContext)
