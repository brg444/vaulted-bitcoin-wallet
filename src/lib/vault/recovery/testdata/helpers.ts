import { HDKey } from '@scure/bip32'
import { hex, base64 } from '@scure/base'
import { ArkAddress, ChainTxType, Transaction, createBoardingProgramScript, getNetwork } from '@arkade-os/sdk'
import type { BoardingDescriptor, VaultStatus } from '../../types'
import { POLICY_VERSION } from '../../constants'
import { VaultPolicyV1Script } from '../../vtxo/script'
import { ledgerAccountKey, ledgerBip32Versions, type LedgerSavingsKeyContext } from '../../program/ledgerNativeKeys'
import { buildLedgerNativeFamily } from '../../program/ledgerNativeFamily'
import {
  buildLedgerRecoveryDescriptor,
  hashLedgerSavingsEnrollment,
  LEDGER_ENROLLMENT_SCHEMA,
  type LedgerSavingsEnrollmentDescriptor,
} from '../../program/ledgerRecoveryDescriptor'
import { buildRecoveryKit, type RecoveryKit } from '../../program/kit'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../../spendingPolicy'
import { networkPins } from '../../networkPins'
import { BOARDING_PROGRAM, BOARDING_SCHEMA, BOARDING_TEMPLATE } from '../../vtxo/board'
import { scalarSecret, compressedFromScalar, FIXTURE_IDENTITIES } from '../../program/fixtures'
import vectors from '../../program/ledger-key-vectors.json'

import type { BoardingFinalRequest } from '../../cosignerClient'
import { p2tr } from '@scure/btc-signer'
import { packExitArchive } from '../exitArchive'
import { sharedSpendingStatus, sharedSpendingStatusForNetwork } from '../../vtxo/testdata/sharedSpending'
import { spendingEnrollmentHash } from '../../spendingEnrollment'
import { buildSpendingRecoveryDescriptor } from '../../program/spendingRecoveryDescriptor'
import { vaultPolicyV1ScriptFromStatus } from '../../vtxo/spendingTransaction'
import { vaultRecoveryBinding, type VaultRecoveryArchive } from '../../vtxo/recoveryArchive'

export function ledgerRecoveryFacts(
  advanced = true,
  network: 'mainnet' | 'mutinynet' = 'mutinynet',
  options: {
    phoneDirectP256?: string
    boardingPub?: string
    context?: LedgerSavingsKeyContext
    spendingPolicy?: ReturnType<typeof defaultSpendingPolicy>
  } = {},
) {
  const context = structuredClone(
    options.context ??
      vectors.find((v) => Boolean(v.input.recovery) === advanced && v.input.network === network)!.input,
  ) as LedgerSavingsKeyContext
  if (options.phoneDirectP256) context.phoneDirectP256 = options.phoneDirectP256
  context.policyDigest = spendingPolicyDigest(options.spendingPolicy ?? defaultSpendingPolicy(network), network)
  const authority = (role: 'hardware' | 'recovery') =>
    '02' + hex.encode(ledgerAccountKey(context[role]!, network).deriveChild(12).deriveChild(0).publicKey!.slice(1))
  const boardingPub = options.boardingPub ?? compressedFromScalar(19)
  const pins = networkPins(network),
    spendingPolicy = options.spendingPolicy ?? defaultSpendingPolicy(network),
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
      boardingPubKey: hex.decode(boardingPub).slice(1),
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
    boardingPub: boardingPub,
    recoveryPhonePub: phonePub,
    vaultBoardCosignerPub: boardingGuardian,
    operatorPub: pins.operatorSignerPub,
    exitDelay: pins.boardExitDelay,
    exitDelayUnit: 'seconds',
    script: hex.encode(boardingTree.pkScript),
    address: boardingTree.onchainAddress(getNetwork(pins.sdkNetwork)),
  }
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
    vaultCosignerBasePub: FIXTURE_IDENTITIES.vaultCosignerBase,
    arkadeCosignerBasePub: FIXTURE_IDENTITIES.arkadeCosignerBase,
    arkadeCosignerOrigin: FIXTURE_IDENTITIES.arkadeCosigner.origin,
    arkadeCosignerVersion: FIXTURE_IDENTITIES.arkadeCosigner.version,
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
  return { ...recoveryArchiveFixture(kit, status, spending), composite, family, board: boardingTree }
}

export function sharedSpendingRecoveryFixture(derivedBoardingPub?: string, network?: 'mainnet' | 'mutinynet') {
  const status = network ? sharedSpendingStatusForNetwork(network) : sharedSpendingStatus()
  if (derivedBoardingPub) {
    const prior = status.vtxoBoardingDescriptor!
    const board = createBoardingProgramScript(
      {
        name: BOARDING_PROGRAM,
        boardingPubKey: hex.decode(derivedBoardingPub).slice(1),
        cosignerPubKey: hex.decode(prior.vaultBoardCosignerPub).slice(1),
        recoveryPubKey: hex.decode(prior.recoveryPhonePub).slice(1),
      },
      hex.decode(prior.operatorPub).slice(1),
      { type: 'seconds', value: BigInt(prior.exitDelay) },
    )
    const boarding = {
      ...prior,
      boardingPub: derivedBoardingPub,
      script: hex.encode(board.pkScript),
      address: board.onchainAddress(getNetwork(networkPins(prior.network).sdkNetwork)),
    }
    status.spendingDescriptor = { ...status.spendingDescriptor!, boarding }
    status.vtxoBoardingDescriptor = boarding
    status.vtxoBoardingDescriptorHash = spendingEnrollmentHash(status.spendingDescriptor)
    status.vtxoBoardingAddress = boarding.address
    status.vtxoBoardingScript = boarding.script
  }
  const kit = buildRecoveryKit(buildSpendingRecoveryDescriptor(status.spendingDescriptor))
  return recoveryArchiveFixture(kit, status, vaultPolicyV1ScriptFromStatus(status))
}

export function recoveryArchiveFixture<K extends RecoveryKit>(
  kit: K,
  status: VaultStatus,
  spending: VaultPolicyV1Script,
) {
  const pins = networkPins(status.network)
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
  const binding = vaultRecoveryBinding(kit, status)
  const archive: VaultRecoveryArchive<K> = {
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
  return { archive, kit, status, spending, tx, coin }
}

/** Synthetic linked, signed boarding evidence; test scalars never leave fixtures. */
export function boardingJournalFixture(handle = 'test-handle') {
  const fixture = ledgerRecoveryFacts()
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

/** Disposable fixture keys for the enrolled Ledger Spending exit, never Savings. */
export function ledgerSpendingFixtureSecret(
  role: 'hardware' | 'recovery',
  network: 'mainnet' | 'mutinynet' = 'mutinynet',
) {
  const seed = new Uint8Array(32).fill(role === 'hardware' ? 0x42 : 0x44)
  const nodes: HDKey[] = []
  try {
    let key = HDKey.fromMasterSeed(seed, ledgerBip32Versions(network))
    nodes.push(key)
    for (const index of [0x80000000 + 86, 0x80000000 + (network === 'mainnet' ? 0 : 1), 0x80000000, 12, 0]) {
      key = key.deriveChild(index)
      nodes.push(key)
    }
    return Uint8Array.from(key.privateKey!)
  } finally {
    seed.fill(0)
    nodes.forEach((node) => node.wipePrivateData())
  }
}
