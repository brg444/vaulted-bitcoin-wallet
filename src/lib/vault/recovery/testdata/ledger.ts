import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { recoveryArchiveFixture } from './helpers'
import { ArkAddress, createBoardingProgramScript, getNetwork } from '@arkade-os/sdk'
import type { BoardingDescriptor, VaultStatus } from '../../types'
import { POLICY_VERSION } from '../../constants'
import { VaultPolicyV1Script } from '../../vtxo/script'
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
import { defaultSpendingPolicy, spendingPolicyDigest } from '../../spendingPolicy'
import { networkPins } from '../../networkPins'
import { deriveBoardingKey, BOARDING_PROGRAM, BOARDING_SCHEMA, BOARDING_TEMPLATE } from '../../vtxo/board'
import { scalarSecret, compressedFromScalar, PROGRAM_FIXTURE } from '../../program/fixtures'
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
  const pins = networkPins(network),
    spendingPolicy = defaultSpendingPolicy(network),
    phonePub = compressedFromScalar(3),
    hardwarePub = authority('hardware'),
    recoveryPub = advanced ? authority('recovery') : undefined,
    cosignerPub = compressedFromScalar(18),
    boardingGuardian = compressedFromScalar(20)
  const spending = new VaultPolicyV1Script({
    userPub: hex.decode(phonePub).slice(1),
    vtxoVaultCosignerPub: hex.decode(cosignerPub).slice(1),
    arkdServerPub: hex.decode(pins.operatorSignerPub).slice(1),
    delegatePub: hex.decode(pins.delegatePub).slice(1),
    exitDelay: BigInt(pins.policyExitDelay),
    exitDelayUnit: 'seconds',
    network,
    exitDevicePub: hex.decode(phonePub).slice(1),
    exitHardwarePub: hex.decode(hardwarePub).slice(1),
    ...(recoveryPub ? { exitRecoveryPub: hex.decode(recoveryPub).slice(1) } : {}),
  })
  const boardingTree = createBoardingProgramScript(
    {
      name: BOARDING_PROGRAM,
      boardingPubKey: hex.decode(board.boardingPub).slice(1),
      cosignerPubKey: hex.decode(boardingGuardian).slice(1),
      recoveryPubKey: hex.decode(phonePub).slice(1),
    },
    hex.decode(pins.operatorSignerPub).slice(1),
    { type: 'seconds', value: BigInt(pins.boardExitDelay) },
  )
  const boarding: BoardingDescriptor = {
    schema: BOARDING_SCHEMA,
    program: BOARDING_PROGRAM,
    template: BOARDING_TEMPLATE,
    network,
    boardingPub: board.boardingPub,
    recoveryPhonePub: phonePub,
    vaultBoardCosignerPub: boardingGuardian,
    operatorPub: pins.operatorSignerPub,
    exitDelay: pins.boardExitDelay,
    exitDelayUnit: 'seconds',
    script: hex.encode(boardingTree.pkScript),
    address: boardingTree.onchainAddress(getNetwork(pins.sdkNetwork)),
  }
  board.secret.fill(0)
  const status: VaultStatus = {
    enrolled: true,
    network,
    clientOrigin: 'https://vault.example',
    rpId: 'vault.example',
    vaultId: context.vaultId,
    templateVersion: context.templateVersion,
    policyVersion: POLICY_VERSION,
    protectionTier: advanced ? 'advanced' : 'standard',
    phoneBip340Pub: phonePub,
    phoneDirectP256: context.phoneDirectP256,
    externalOwnerWalletPub: hardwarePub,
    recoveryPub,
    vaultCosignerBasePub: PROGRAM_FIXTURE.vaultCosignerBase,
    arkadeCosignerBasePub: PROGRAM_FIXTURE.arkadeCosignerBase,
    arkadeCosignerOrigin: PROGRAM_FIXTURE.arkadeCosigner.origin,
    arkadeCosignerVersion: PROGRAM_FIXTURE.arkadeCosigner.version,
    savingsAddress: '',
    savingsScript: '',
    spendingPolicy,
    spendingPolicyDigest: spendingPolicyDigest(spendingPolicy, network),
    periodAllowance: spendingPolicy.periodAllowanceSats,
    periodSpent: 0,
    periodRemaining: spendingPolicy.periodAllowanceSats,
    txCap: spendingPolicy.txRecipientCapSats,
    absoluteFeeCap: spendingPolicy.absoluteFeeCapSats,
    feerateCapSatVb: spendingPolicy.feerateCapSatPerV,
    vtxoVaultCosignerPub: cosignerPub,
    vtxoDelegatePub: pins.delegatePub,
    vtxoExitDelay: pins.policyExitDelay,
    vtxoExitDelayUnit: 'seconds',
    spendingArkAddress: new ArkAddress(
      hex.decode(pins.operatorSignerPub).slice(1),
      spending.tweakedPublicKey,
      pins.arkHrp,
    ).encode(),
    spendingArkScript: hex.encode(spending.pkScript),
    vtxoBoardingActive: true,
    vtxoBoardingProgram: BOARDING_PROGRAM,
    vtxoBoardingDescriptor: boarding,
    vtxoBoardingScript: boarding.script,
    vtxoBoardingAddress: boarding.address,
    vtxoBoardingExitDelay: boarding.exitDelay,
    vtxoBoardingExitDelayUnit: boarding.exitDelayUnit,
  }
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
  const { archive } = recoveryArchiveFixture(kit, status, spending)
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
