import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { recoveryFixture } from './helpers'
import {
  ledgerAccountKey,
  ledgerSavingsContextDigest,
  type LedgerSavingsKeyContext,
} from '../../program/ledgerNativeKeys'
import { buildLedgerNativeFamily } from '../../program/ledgerNativeFamily'
import {
  buildLedgerRecoveryDescriptor,
  hashLedgerSavingsEnrollment,
  LEDGER_ENROLLMENT_SCHEMA,
  type LedgerSavingsEnrollmentDescriptor,
} from '../../program/ledgerRecoveryDescriptor'
import { buildRecoveryKit } from '../../program/kit'
import { ledgerWalletPolicyId } from '../../program/ledgerEnrollment'
import { defaultSpendingPolicy } from '../../spendingPolicy'
import { networkPins } from '../../networkPins'
import { vaultRecoveryBinding } from '../../vtxo/recoveryArchive'
import { deriveBoardingKey } from '../../vtxo/board'
import { scalarSecret } from '../../program/fixtures'
import { wrapPhoneSecret } from '../../prfEnvelope'
import { wrapLedgerPhoneSeed } from '../../ledgerPhoneBackup'
import { buildRecoveryHeader, type VaultRecoveryFile } from '../backupCodec'
import { recoveryLightningBinding } from '../journals'
import vectors from '../../program/ledger-key-vectors.json'
import { deriveDirectP256 } from '../../ceremony/directauth'

export const ledgerFixtureSeed = new Uint8Array(32).fill(0x43)
export const ledgerFixturePRF = new Uint8Array(32).fill(0x71)

export async function ledgerRecoveryFixture(advanced = false, network: 'mainnet' | 'mutinynet' = 'mutinynet') {
  const context = structuredClone(
    vectors.find((v) => Boolean(v.input.recovery) === advanced && v.input.network === network)!.input,
  ) as LedgerSavingsKeyContext
  const direct = await deriveDirectP256(ledgerFixturePRF)
  context.phoneDirectP256 = hex.encode(direct.pub)
  direct.scalar.fill(0)
  const authority = (role: 'hardware' | 'recovery') =>
    '02' + hex.encode(ledgerAccountKey(context[role]!, network).deriveChild(12).deriveChild(0).publicKey!.slice(1))
  const board = await deriveBoardingKey(scalarSecret(3), context.vaultId, network)
  const old = recoveryFixture(advanced, network, context.phoneDirectP256, board.boardingPub, undefined, {
    hardwarePub: authority('hardware'),
    ...(advanced ? { recoveryPub: authority('recovery') } : {}),
  })
  board.secret.fill(0)
  const status = old.status,
    pins = networkPins(network),
    spendingPolicy = defaultSpendingPolicy(network)
  const composite: LedgerSavingsEnrollmentDescriptor = {
    schema: LEDGER_ENROLLMENT_SCHEMA,
    vaultId: context.vaultId,
    savings: { context, spendingPolicy },
    spendingAuthorities: {
      phoneBip340Pub: status.phoneBip340Pub!,
      externalOwnerWalletPub: status.externalOwnerWalletPub!,
      recoveryKeyPub: status.recoveryPub || '',
      vaultCosignerBasePub: status.vaultCosignerBasePub!,
      arkadeCosignerBasePub: status.arkadeCosignerBasePub!,
      phoneDirectP256: status.phoneDirectP256!,
      vtxoVaultCosignerPub: status.vtxoVaultCosignerPub!,
      operatorPub: pins.operatorSignerPub,
      vtxoDelegatePub: status.vtxoDelegatePub!,
      vtxoExitDelay: status.vtxoExitDelay!,
      vtxoExitDelayUnit: status.vtxoExitDelayUnit!,
      spendingArkAddress: status.spendingArkAddress!,
      spendingArkScript: status.spendingArkScript!,
    },
    boarding: status.vtxoBoardingDescriptor!,
  }
  const kit = buildRecoveryKit(buildLedgerRecoveryDescriptor(composite)),
    family = buildLedgerNativeFamily(context, spendingPolicy)
  Object.assign(status, {
    templateVersion: context.templateVersion,
    savingsAddress: family.receive.address,
    savingsScript: hex.encode(family.receive.script),
    ledgerSavings: { context, spendingPolicy, descriptorHash: hashLedgerSavingsEnrollment(composite) },
  })
  status.vtxoBoardingDescriptorHash = status.ledgerSavings!.descriptorHash
  const archive = {
    ...old.archive,
    kit,
    status,
    spending: { ...old.archive.spending, descriptorHash: vaultRecoveryBinding(kit, status).descriptorHash },
  }
  const trees = [
    kit.descriptor.savings,
    kit.descriptor.savingsChange,
    ...Object.values(kit.descriptor.pending),
    ...Object.values(kit.descriptor.quarantine),
  ]
  archive.onchain = trees.map((tree, index) => {
    const parent = new Transaction({ version: 2, allowUnknownInputs: true, allowUnknownOutputs: true })
    parent.addInput({ txid: '01'.repeat(32), index: index + 100 })
    parent.addOutput({ script: hex.decode(tree.script), amount: 100000n })
    return {
      txid: parent.id,
      vout: 0,
      value: 100000,
      script: tree.script,
      parentHex: hex.encode(parent.toBytes(true, true)),
    }
  })
  const enrollment = {
    vaultId: context.vaultId,
    credId: 'ab'.repeat(32),
    webauthnP256: context.phoneDirectP256,
    phoneDirectP256: context.phoneDirectP256,
    phoneBip340Pub: status.phoneBip340Pub!,
    ...(await wrapPhoneSecret(ledgerFixturePRF, scalarSecret(3))),
    ledgerSavings: {
      version: 1 as const,
      contract: composite.savings,
      registration: {
        name: 'vaulted-ledger-registration' as const,
        version: 1 as const,
        contextDigest: hex.encode(ledgerSavingsContextDigest(context)),
        walletId: ledgerWalletPolicyId(family.walletPolicy),
        walletHmac: 'ab'.repeat(32),
        walletPolicy: family.walletPolicy,
        receiveAddress: family.receive.address,
        changeAddress: family.change.address,
      },
      phoneSeedBackup: await wrapLedgerPhoneSeed(ledgerFixtureSeed, ledgerFixturePRF, 'passkey-prf', context),
    },
  }
  const file: VaultRecoveryFile = {
    name: 'vaulted-recovery',
    version: 1,
    header: buildRecoveryHeader(kit, status, enrollment),
    archive,
    spendingJournal: { version: 1, vaultId: context.vaultId, operations: [] },
    lightningJournal: {
      name: 'vaulted-lightning-recovery',
      version: 1,
      binding: recoveryLightningBinding(status),
      entries: [],
    },
  }
  return { file, kit, status, composite, family, enrollment, archive }
}
