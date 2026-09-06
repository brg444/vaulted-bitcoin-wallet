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

export type VaultAccount = 'spend' | 'savings'

export type VaultScreen =
  | 'welcome'
  | 'unlock'
  | 'design'
  | 'hardware'
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
  acceptDesign: (tier?: 'standard' | 'advanced') => void
  account: VaultAccount
  positions: VaultAccountPositions
  applyHardware: (raw: string) => void
  applyRecovery: (raw: string) => void
  setProtectionTier: (tier: ProtectionTier) => void
  skipRecovery: () => void
  downloadRecoveryKit: () => string
  backupRecoveryKit: () => Promise<boolean>
  balanceError: string
  balancesLoaded: boolean
  boardingAddress: string
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
  acceptDesign: () => {},
  account: 'spend',
  positions: EMPTY_VAULT_POSITIONS,
  applyHardware: () => {},
  applyRecovery: () => {},
  setProtectionTier: () => {},
  skipRecovery: () => {},
  downloadRecoveryKit: () => '',
  backupRecoveryKit: async () => false,
  balanceError: '',
  balancesLoaded: false,
  boardingAddress: '',
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
