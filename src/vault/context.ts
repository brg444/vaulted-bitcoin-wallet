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

export const DEFAULT_SPEND_FEE_SATS = 500
