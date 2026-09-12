import type { SpendingPolicy } from '../spendingPolicy'

export interface RecoveryPolicy {
  program: SpendingPolicy['program']
  schema: SpendingPolicy['schema']
  period: SpendingPolicy['period']
  digest: string
  recipientDustSats: number
  recipientCapSats: number
  periodAllowanceSats: number
  absoluteFeeCapSats: number
  feerateCapSatVb: number
}
