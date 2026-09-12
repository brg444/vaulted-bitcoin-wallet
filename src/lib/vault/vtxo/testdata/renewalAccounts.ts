import expectedVectors from './renewal-context-v1.json'
import { LEDGER_NATIVE_TEMPLATE } from '../../program/ledgerNativeKeys'
import type { VaultStatus } from '../../types'
import { sharedSpendingStatusForNetwork } from './sharedSpending'

export const renewalAccounts = (['mainnet', 'mutinynet'] as const).flatMap((network) => [
  {
    name: `${network}-light-vaulted-spending-v1`,
    status: sharedSpendingStatusForNetwork(network, {
      phoneSecret: new Uint8Array(32).fill(1),
      cosignerSecret: new Uint8Array(32).fill(2),
      directScalar: new Uint8Array(32).fill(7),
      vaultId: '85d3dbe6dc97a42859b28dde49400985',
    }),
  },
  ...expectedVectors
    .filter((v) => v.status.network === network && v.status.templateVersion === 'phone-hww-recovery-savings-v1')
    .map((v) => ({
      name: `${network}-${v.context.protectionTier}-${LEDGER_NATIVE_TEMPLATE}`,
      status: { ...v.status, templateVersion: LEDGER_NATIVE_TEMPLATE } as VaultStatus,
    })),
])
