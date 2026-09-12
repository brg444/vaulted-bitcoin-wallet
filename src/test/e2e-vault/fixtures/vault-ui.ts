import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { saveEnrollment, saveSelectedVaultId } from '../../../lib/vault/enrollmentStore'
import { pinFromEnrolledStatus, saveAddressPin } from '../../../lib/vault/pin'
import { scalarSecret } from '../../../lib/vault/program/fixtures'
import { saveLocalKit } from '../../../lib/vault/program/kitStore'
import { ledgerRecoveryFixture } from '../../../lib/vault/recovery/testdata/ledger'
import { saveSetupPlan } from '../../../lib/vault/setupPlan'
import type { VaultStatus } from '../../../lib/vault/types'
import { activateBoardingKey, stageBoardingKey, MUTINYNET_OPERATOR_SIGNER_PUB } from '../../../lib/vault/vtxo/board'
import { persistVtxoSpend, type PersistedVtxoSpend } from '../../../lib/vault/vtxo/spend'

export const VAULT_UI_ID = 'e2'.repeat(16)
export const OPERATOR_XONLY = MUTINYNET_OPERATOR_SIGNER_PUB.slice(2)
export const VAULT_UI_DESTINATION = new ArkAddress(
  hex.decode(OPERATOR_XONLY),
  hex.decode('5cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc'),
  'tark',
).encode()

async function vaultUiFixture(origin = location.origin, hostname = location.hostname) {
  const fixture = await ledgerRecoveryFixture(true, 'mutinynet', VAULT_UI_ID)
  const { status } = fixture
  status.clientOrigin = origin
  status.rpId = hostname
  const phoneSecret = scalarSecret(3)
  try {
    const staged = await stageBoardingKey({ vaultId: status.vaultId, phoneSecret, network: status.network })
    if (staged.boardingPub !== status.vtxoBoardingDescriptor!.boardingPub)
      throw new Error('Ledger UI fixture boarding key does not match its enrollment')
    await activateBoardingKey({
      vaultId: status.vaultId,
      descriptorHash: status.vtxoBoardingDescriptorHash!,
      expectedBoardingPub: staged.boardingPub,
    })
  } finally {
    phoneSecret.fill(0)
  }
  return fixture
}

export async function vaultUiStatus(origin = location.origin, hostname = location.hostname): Promise<VaultStatus> {
  return (await vaultUiFixture(origin, hostname)).status
}

export async function vaultUiRecoveryCoins() {
  return (await ledgerRecoveryFixture(true, 'mutinynet', VAULT_UI_ID)).archive.onchain
}

export async function installVaultUiSession() {
  const { status, kit, enrollment, composite } = await vaultUiFixture()
  saveSelectedVaultId(status.vaultId)
  saveEnrollment(enrollment)
  saveAddressPin(pinFromEnrolledStatus(status))
  saveSetupPlan({
    protectionTier: status.protectionTier,
    hardwarePub: status.externalOwnerWalletPub!,
    recoveryPub: status.recoveryPub || '',
    ledger: { hardware: composite.savings.context.hardware, recovery: composite.savings.context.recovery },
    txCapSats: status.txCap,
    dailyLimitSats: status.periodAllowance,
    absoluteFeeCapSats: status.absoluteFeeCap,
    feerateCapSatPerV: status.feerateCapSatVb,
    acceptedDesign: true,
    complete: true,
  })
  saveLocalKit(kit)
  localStorage.removeItem('arkade-vault-v2:session-lock')
  return status
}

export function wireVaultVtxo(
  status: VaultStatus,
  input: {
    amount: number
    txid: string
    vout?: number
    createdAt?: number
    isSpent?: boolean
    spentBy?: string
    arkTxid?: string
    commitmentTxids?: string[]
  },
) {
  return {
    outpoint: { txid: input.txid, vout: input.vout || 0 },
    createdAt: String(Math.floor((input.createdAt || Date.now()) / 1_000)),
    expiresAt: null,
    amount: String(input.amount),
    script: status.spendingArkScript,
    isPreconfirmed: false,
    isSwept: false,
    isUnrolled: false,
    isSpent: input.isSpent === true,
    ...(input.spentBy ? { spentBy: input.spentBy } : {}),
    ...(input.arkTxid ? { arkTxid: input.arkTxid } : {}),
    // A settled VTXO is a leaf of a Batch Output. The SDK activity builder
    // keys that receive by its commitment transaction, so every settled test
    // fixture must carry the same graph fact the real indexer supplies.
    commitmentTxids: input.commitmentTxids || [input.txid],
  }
}

export function seedReviewedVtxoSpend(
  status: VaultStatus,
  destAddress: string,
  amountSats: number,
  feeSats: number,
  changeSats: number,
) {
  const record: PersistedVtxoSpend = {
    vaultId: status.vaultId,
    operationId: '44'.repeat(16),
    bundleDigest: '55'.repeat(32),
    destAddress,
    amountSats,
    arkTxid: '66'.repeat(32),
    reservationExpires: '2099-08-20T00:02:00Z',
    stage: 'reserved',
    feePolicyDigest: '77'.repeat(32),
    feeSats,
    changeSats,
    ...(changeSats > 0 ? { changeVout: 1 } : {}),
  }
  persistVtxoSpend(record)
  return record
}
