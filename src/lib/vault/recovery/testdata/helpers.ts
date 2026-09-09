import type { BoardingFinalRequest } from '../../cosignerClient'
import { buildConnectorEnrollmentPreview } from '../../program/connectorEnrollmentCore'
import { p2tr } from '@scure/btc-signer'
import { packExitArchive } from '../exitArchive'
import { ArkAddress, ChainTxType, Transaction, createBoardingProgramScript, getNetwork } from '@arkade-os/sdk'
import { hex, base64 } from '@scure/base'
import type { VaultStatus, BoardingDescriptor } from '../../types'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../../spendingPolicy'
import { buildVaultProgramDescriptor, type VaultProgramDescriptor } from '../../program/descriptor'
import { buildRecoveryKit } from '../../program/kit'
import { PROGRAM_FIXTURE, compressedFromScalar, scalarSecret } from '../../program/fixtures'
import { networkPins } from '../../networkPins'
import { VaultPolicyV1Script } from '../../vtxo/script'
import { BOARDING_PROGRAM, BOARDING_SCHEMA, BOARDING_TEMPLATE } from '../../vtxo/board'
import { vaultRecoveryBinding, type VaultRecoveryArchive } from '../../vtxo/recoveryArchive'
import { hashBoardingEnrollmentDescriptor } from '../../program/enroll'
function statusFromDescriptor(committed: VaultProgramDescriptor): VaultStatus {
  const spendingPolicy = defaultSpendingPolicy(committed.network)
  return {
    enrolled: true,
    network: committed.network,
    clientOrigin: 'https://vault.example',
    rpId: 'vault.example',
    vaultId: committed.vaultId,
    templateVersion: committed.templateVersion,
    policyVersion: committed.policyVersion,
    protectionTier: committed.protectionTier,
    externalOwnerWalletPub: committed.keys.hardware,
    vaultCosignerBasePub: committed.keys.vaultCosignerBase,
    arkadeCosignerBasePub: committed.keys.arkadeCosignerBase,
    arkadeCosignerOrigin: committed.arkadeCosigner.origin,
    arkadeCosignerVersion: committed.arkadeCosigner.version,
    savingsAddress: committed.savings.address,
    savingsScript: committed.savings.script,
    periodAllowance: committed.policy.periodAllowanceSats,
    periodSpent: 0,
    periodRemaining: committed.policy.periodAllowanceSats,
    txCap: committed.policy.recipientCapSats,
    absoluteFeeCap: committed.policy.absoluteFeeCapSats,
    feerateCapSatVb: committed.policy.feerateCapSatVb,
    spendingPolicy,
    spendingPolicyDigest: spendingPolicyDigest(spendingPolicy, committed.network),
    phoneBip340Pub: committed.keys.phoneBip340,
    phoneDirectP256: committed.keys.phoneDirectP256,
    recoveryPub: committed.keys.recovery,
  }
}

export function recoveryFixture(
  advanced = true,
  network: 'mainnet' | 'mutinynet' = 'mutinynet',
  phoneDirectP256 = PROGRAM_FIXTURE.phoneDirectP256,
  derivedBoardingPub?: string,
  connector?: { templateVersion: string; connectorType: 'p2tr' | 'p2wpkh' },
  spendingKeys?: { hardwarePub: string; recoveryPub?: string },
) {
  const d = buildVaultProgramDescriptor({
    ...PROGRAM_FIXTURE,
    ...connector,
    network,
    phoneDirectP256,
    protectionTier: advanced ? 'advanced' : 'standard',
    recoveryPub: advanced ? PROGRAM_FIXTURE.recoveryPub : undefined,
    ...spendingKeys,
  })
  const kit = buildRecoveryKit(d)
  const status = statusFromDescriptor(d)
  const pins = networkPins(network)
  const spending = new VaultPolicyV1Script({
    userPub: hex.decode(d.keys.phoneBip340).slice(1),
    vtxoVaultCosignerPub: hex.decode(compressedFromScalar(18)).slice(1),
    arkdServerPub: hex.decode(pins.operatorSignerPub).slice(1),
    delegatePub: hex.decode(pins.delegatePub).slice(1),
    exitDelay: BigInt(pins.policyExitDelay),
    exitDelayUnit: 'seconds',
    network,
    exitDevicePub: hex.decode(d.keys.phoneBip340).slice(1),
    exitHardwarePub: hex.decode(d.keys.hardware).slice(1),
    ...(d.keys.recovery ? { exitRecoveryPub: hex.decode(d.keys.recovery).slice(1) } : {}),
  })
  const boardingPub = derivedBoardingPub || compressedFromScalar(19)
  const boardingGuardian = compressedFromScalar(20)
  const board = createBoardingProgramScript(
    {
      name: BOARDING_PROGRAM,
      boardingPubKey: hex.decode(boardingPub).slice(1),
      cosignerPubKey: hex.decode(boardingGuardian).slice(1),
      recoveryPubKey: hex.decode(d.keys.phoneBip340).slice(1),
    },
    hex.decode(pins.operatorSignerPub).slice(1),
    { type: 'seconds', value: BigInt(pins.boardExitDelay) },
  )
  const boarding: BoardingDescriptor = {
    schema: BOARDING_SCHEMA,
    program: BOARDING_PROGRAM,
    template: BOARDING_TEMPLATE,
    network,
    boardingPub,
    recoveryPhonePub: d.keys.phoneBip340,
    vaultBoardCosignerPub: boardingGuardian,
    operatorPub: pins.operatorSignerPub,
    exitDelay: pins.boardExitDelay,
    exitDelayUnit: 'seconds',
    script: hex.encode(board.pkScript),
    address: board.onchainAddress(getNetwork(pins.sdkNetwork)),
  }
  Object.assign(status, {
    vtxoVaultCosignerPub: compressedFromScalar(18),
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
    vtxoBoardingDescriptorHash: 'ab'.repeat(32),
    vtxoBoardingScript: boarding.script,
    vtxoBoardingAddress: boarding.address,
    vtxoBoardingExitDelay: pins.boardExitDelay,
    vtxoBoardingExitDelayUnit: 'seconds',
  })
  const tx = new Transaction({ version: 3 })
  const root = p2tr(hex.decode(compressedFromScalar(21)).slice(1), undefined, getNetwork(pins.sdkNetwork))
  tx.addInput({
    txid: '01'.repeat(32),
    index: 0,
    witnessUtxo: { script: root.script, amount: 40_000n },
    tapInternalKey: root.tapInternalKey,
  })
  tx.addOutput({ amount: 40_000n, script: spending.pkScript })
  tx.addOutput({ amount: 0n, script: hex.decode('51024e73') })
  tx.sign(scalarSecret(21))
  const coin = {
    txid: tx.id,
    vout: 0,
    value: 40_000,
    script: hex.encode(spending.pkScript),
    isSpent: false,
    createdAt: '2026-09-06T00:00:00Z',
  }
  status.vtxoBoardingDescriptorHash = hashBoardingEnrollmentDescriptor({
    schema: 'arkade-vault/enrollment-with-board-v1',
    vaultId: status.vaultId,
    savings: d,
    boarding,
  })
  if (connector) {
    const origin = {
      connectorType: connector.connectorType,
      connectorPub: d.keys.hardware,
      connectorFingerprint: 0x12345678,
      connectorPath: [
        connector.connectorType === 'p2tr' ? 0x80000056 : 0x80000054,
        network === 'mainnet' ? 0x80000000 : 0x80000001,
        0x80000000,
        0,
        0,
      ],
    }
    const preview = buildConnectorEnrollmentPreview({
      templateVersion: connector.templateVersion,
      vaultId: d.vaultId,
      network,
      protectionTier: d.protectionTier,
      phonePub: d.keys.phoneBip340,
      phoneDirectP256: d.keys.phoneDirectP256,
      recoveryPub: d.keys.recovery,
      vaultCosignerBase: d.keys.vaultCosignerBase,
      arkadeCosignerBase: d.keys.arkadeCosignerBase,
      arkadeOrigin: d.arkadeCosigner.origin,
      arkadeVersion: d.arkadeCosigner.version,
      spendingPolicy: defaultSpendingPolicy(network),
      origin,
      boarding,
    })
    status.vtxoBoardingDescriptorHash = preview.boardingHash
    status.connectorEnrollment = {
      ...origin,
      enrollmentDigest: preview.digest,
      descriptorHash: preview.compositeHash,
    }
  }
  const binding = vaultRecoveryBinding(kit, status)
  const archive: VaultRecoveryArchive = {
    name: 'vaulted-program-recovery-data',
    version: 1,
    kit,
    status,
    onchain: [],
    spending: {
      version: 1,
      descriptorHash: binding.descriptorHash,
      capturedAt: '2026-09-06T00:00:00Z',
      info: packExitArchive({
        network: pins.operatorGetInfoNetwork,
        signerPubkey: pins.operatorSignerPub,
        checkpointTapscript: pins.checkpointTapscript,
        forfeitPubkey: pins.checkpointForfeitPub,
        forfeitAddress: p2tr(hex.decode(pins.checkpointForfeitPub).slice(1), undefined, getNetwork(pins.sdkNetwork))
          .address!,
        unilateralExitDelay: 2048n,
        boardingExitDelay: BigInt(pins.boardExitDelay),
        sessionDuration: 100n,
        dust: 330n,
        fees: {},
        digest: 'ab'.repeat(32),
        version: 'fixture',
        vtxoMinAmount: 330n,
        vtxoMaxAmount: -1n,
        utxoMinAmount: 330n,
        utxoMaxAmount: -1n,
        deprecatedSigners: [],
        serviceStatus: {},
      }),
      coins: JSON.stringify([coin]),
      branches: {
        [tx.id + ':0']: [
          { txid: '01'.repeat(32), type: ChainTxType.COMMITMENT, spends: [], expiresAt: '0' },
          { txid: tx.id, type: ChainTxType.TREE, spends: ['01'.repeat(32)], expiresAt: '1789000000' },
        ],
      },
      transactions: { [tx.id]: base64.encode(tx.toPSBT()) },
    },
  }
  return { archive, kit, status, spending, board, tx, coin }
}

/** Synthetic linked, signed boarding evidence; test scalars never leave fixtures. */
export function boardingJournalFixture(handle = 'test-handle') {
  const fixture = recoveryFixture()
  const descriptor = fixture.status.vtxoBoardingDescriptor!
  const root = p2tr(hex.decode(compressedFromScalar(21)).slice(1))
  const commitment = new Transaction({ version: 3 })
  commitment.addInput({
    txid: '12'.repeat(32),
    index: 0,
    witnessUtxo: { script: fixture.board.pkScript, amount: 40_000n },
    tapLeafScript: [fixture.board.forfeit()],
  })
  commitment.addOutput({ amount: 40_000n, script: root.script })
  const unsignedCommitmentTx = base64.encode(commitment.toPSBT())
  commitment.sign(scalarSecret(19))
  const tree = new Transaction({ version: 3 })
  tree.addInput({
    txid: commitment.id,
    index: 0,
    witnessUtxo: { script: root.script, amount: 40_000n },
    tapInternalKey: root.tapInternalKey,
  })
  tree.addOutput({ amount: 40_000n, script: fixture.spending.pkScript })
  const unsignedTree = base64.encode(tree.toPSBT())
  tree.sign(scalarSecret(21))
  const request: BoardingFinalRequest = {
    handle,
    psbt: base64.encode(commitment.toPSBT()),
    inputIndexes: [0],
    signedForfeits: [],
    validatedBatch: {
      batchId: 'batch-fixture',
      batchExpiry: 604_672,
      unsignedCommitmentTx,
      vtxoTree: [{ txid: tree.id, tx: base64.encode(tree.toPSBT()), children: {} }],
      expectedRecipients: [{ address: fixture.status.spendingArkAddress!, amountSats: 40_000 }],
    },
  }
  return { ...fixture, descriptor, request, unsignedTree }
}
