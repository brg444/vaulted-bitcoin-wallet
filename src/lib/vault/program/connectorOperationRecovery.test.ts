import { describe, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import { Address, OutScript, Transaction } from '@scure/btc-signer'
import { ArkAddress } from '@arkade-os/sdk'
import { VaultPolicyV1Script } from '../vtxo/script'
import { networkPins } from '../networkPins'
import { vaultAddressNetwork } from '../addressNetwork'
import { defaultSpendingPolicy } from '../spendingPolicy'
import { recoveryFixture } from '../recovery/testdata/helpers'
import { buildRecoveryHeader } from '../recovery/backupCodec'
import { buildConnectorEnrollmentPreview, buildConnectorRecoveryKit } from './connectorEnroll'
import { parseRecoveryKit } from './kit'
import { CONNECTOR_TEMPLATE } from './connector'
import { prepareConnectorPayment } from './connectorPayment'
import { scalarSecret } from './fixtures'
import {
  connectorRecoveryHandoff,
  acceptConnectorRecoverySignature,
  executeConnectorRecovery,
  validateConnectorRecoveryFile,
  type ConnectorRecoveryFile,
} from './connectorRecovery'
import type { ConnectorPendingInput } from './connectorStore'
import type { SavingsRecoveryChain } from './onchainRecovery'
import vectors from './connector-vectors.json'

const options = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true } as const
function fixture(index = 0) {
  const v = vectors[index]
  if (
    (v.network !== 'mainnet' && v.network !== 'mutinynet') ||
    (v.tier !== 'standard' && v.tier !== 'advanced') ||
    (v.connectorType !== 'p2tr' && v.connectorType !== 'p2wpkh')
  )
    throw new Error('Invalid fixture')
  const base = recoveryFixture(v.tier === 'advanced', v.network)
  const spendingPolicy = defaultSpendingPolicy(v.network)
  const spending = new VaultPolicyV1Script({
    ...base.spending.params,
    exitHardwarePub: hex.decode(v.hardware).slice(1),
  })
  const pins = networkPins(v.network)
  const input: Parameters<typeof buildConnectorEnrollmentPreview>[0] & {
    boarding: NonNullable<Parameters<typeof buildConnectorEnrollmentPreview>[0]['boarding']>
  } = {
    vaultId: 'connector-family-fixture',
    network: v.network,
    protectionTier: v.tier,
    phonePub: v.phone,
    phoneDirectP256: v.phoneDirect,
    ...(v.tier === 'advanced' ? { recoveryPub: v.recovery } : {}),
    vaultCosignerBase: v.guardian,
    arkadeCosignerBase: v.emulator,
    arkadeOrigin: base.status.arkadeCosignerOrigin!,
    arkadeVersion: base.status.arkadeCosignerVersion!,
    spendingPolicy,
    origin: {
      connectorPub: v.hardware,
      connectorType: v.connectorType,
      connectorFingerprint: v.originFingerprint,
      connectorPath: [...v.originPath],
    },
    boarding: base.status.vtxoBoardingDescriptor!,
  }
  const preview = buildConnectorEnrollmentPreview(input)
  expect(preview.digest).toBe(v.enrollmentDigest)
  const kit = parseRecoveryKit(buildConnectorRecoveryKit(preview, input))
  const status = {
    ...base.status,
    spendingArkScript: hex.encode(spending.pkScript),
    spendingArkAddress: new ArkAddress(
      hex.decode(pins.operatorSignerPub).slice(1),
      spending.tweakedPublicKey,
      pins.arkHrp,
    ).encode(),
    vaultId: input.vaultId,
    templateVersion: CONNECTOR_TEMPLATE,
    phoneBip340Pub: v.phone,
    phoneDirectP256: v.phoneDirect,
    externalOwnerWalletPub: v.hardware,
    vaultCosignerBasePub: v.guardian,
    arkadeCosignerBasePub: v.emulator,
    savingsAddress: preview.family.savings.address,
    savingsScript: hex.encode(preview.family.savings.script),
    vtxoBoardingDescriptorHash: preview.boardingHash,
    connectorEnrollment: { ...input.origin, enrollmentDigest: preview.digest, descriptorHash: preview.compositeHash },
  }
  const header = buildRecoveryHeader(kit, status, {
    vaultId: input.vaultId,
    credId: 'ab'.repeat(32),
    webauthnP256: v.phoneDirect,
    phoneDirectP256: v.phoneDirect,
    phoneBip340Pub: v.phone,
    nonce: '11'.repeat(12),
    ciphertext: '22'.repeat(48),
  })
  const payment = v.payments[0]
  const pending: ConnectorPendingInput = {
    contract: {
      connectorType: v.connectorType,
      vaultId: input.vaultId,
      network: v.network,
      phonePub: v.phone,
      hardwarePub: v.hardware,
      recoveryPub: v.tier === 'advanced' ? v.recovery : undefined,
      phoneDirectP256: v.phoneDirect,
      vaultCosignerBase: v.guardian,
      arkadeCosignerBase: v.emulator,
      absoluteFeeCapSats: spendingPolicy.absoluteFeeCapSats,
      feerateCapSatPerV: spendingPolicy.feerateCapSatPerV,
      protectionTier: v.tier,
      spendingPolicy,
    },
    origin: { publicKey: v.hardware, fingerprint: v.originFingerprint, path: [...v.originPath] },
    savings: { parentHex: payment.parent, txid: payment.parentTxid, vout: 0 },
    reserve: { parentHex: payment.parent, txid: payment.parentTxid, vout: 1 },
    recipient: Address(vaultAddressNetwork(v.network)).encode(OutScript.decode(hex.decode(payment.recipientScript))),
    amountSats: payment.amount,
    feeSats: payment.fee,
  }
  const prepared = prepareConnectorPayment({
    ...pending,
    origin: { ...pending.origin, publicKey: hex.decode(v.hardware) },
    enrollmentDigest: preview.digest,
  })
  const file: ConnectorRecoveryFile = {
    name: 'vaulted-connector-recovery',
    version: 1,
    header,
    record: {
      ...pending,
      version: 1,
      enrollmentDigest: preview.digest,
      candidatePsbt: prepared.psbt(),
      signaturesMayHaveIssued: true,
      savingsWitness: [...payment.savingsWitness],
    },
  }
  validateConnectorRecoveryFile(file)
  return { file, payment, v }
}
function sign(file: ConnectorRecoveryFile) {
  const handoff = Transaction.fromPSBT(hex.decode(connectorRecoveryHandoff(file)), options)
  handoff.signIdx(scalarSecret(4), 1)
  return acceptConnectorRecoverySignature(file, hex.encode(handoff.toPSBT()))
}
function chain(): SavingsRecoveryChain {
  return {
    status: vi.fn(async () => ({ confirmed: true })),
    tipHeight: vi.fn(async () => 10000),
    outspend: vi.fn(async () => ({ spent: false })),
    broadcast: vi.fn(async (raw) => Transaction.fromRaw(hex.decode(raw), options).id),
  }
}

describe('saved Savings connector operation recovery', () => {
  it.each([0, 1, 2, 3])(
    'exports finalized Savings input and accepts hardware-only partial signing (vector %i)',
    async (index) => {
      const { file, payment } = fixture(index)
      const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Services unavailable'))
      try {
        const psbt = Transaction.fromPSBT(hex.decode(connectorRecoveryHandoff(file)), options)
        expect(psbt.getInput(0).finalScriptWitness?.map((x) => hex.encode(x))).toEqual(payment.savingsWitness)
        expect(psbt.getInput(1).tapKeySig).toBeUndefined()
        expect(hex.encode(psbt.getOutput(0).script!)).toBe(payment.recipientScript)
        const signed = sign(file)
        expect(signed.record.txid).toBe(payment.txid)
        const before = JSON.stringify(signed)
        const bitcoin = chain()
        expect(await executeConnectorRecovery(signed, bitcoin)).toEqual({ txid: payment.txid, confirmed: false })
        expect(bitcoin.broadcast).toHaveBeenCalledWith(signed.record.signedTxHex)
        expect(JSON.stringify(signed)).toBe(before)
        expect(network).not.toHaveBeenCalled()
      } finally {
        network.mockRestore()
      }
    },
  )
  it.each([4, 5, 6, 7, 8, 9, 10, 11])(
    'accepts a saved P2WPKH PSBT response with exact enrollment origin (vector %i)',
    (index) => {
      const { file, payment } = fixture(index)
      const handed = Transaction.fromPSBT(hex.decode(connectorRecoveryHandoff(file)), options)
      expect(handed.getInput(1).sighashType).toBe(1)
      expect(handed.getInput(1).bip32Derivation![0][1].path).toEqual(file.record.origin.path)
      const signed = acceptConnectorRecoverySignature(file, payment.responsePSBT)
      expect(signed.record.signedTxHex).toBe(payment.finalTx)
      expect(signed.record.txid).toBe(payment.txid)
    },
  )
  it('keeps exact signed bytes after a lost response and retries without another signature', async () => {
    const { file } = fixture()
    const signed = sign(file)
    const bitcoin = chain()
    vi.mocked(bitcoin.broadcast).mockRejectedValueOnce(new Error('response lost'))
    await expect(executeConnectorRecovery(signed, bitcoin)).rejects.toThrow('response lost')
    await executeConnectorRecovery(structuredClone(signed), bitcoin)
    expect(bitcoin.broadcast).toHaveBeenNthCalledWith(1, signed.record.signedTxHex)
    expect(bitcoin.broadcast).toHaveBeenNthCalledWith(2, signed.record.signedTxHex)
  })
  it('reconciles its own confirmed spend and refuses a conflicting outspend', async () => {
    const signed = sign(fixture().file)
    for (const input of [0, 1]) {
      const bitcoin = chain()
      vi.mocked(bitcoin.outspend).mockImplementation(async (_txid, vout) =>
        vout === input ? { spent: true, txid: signed.record.txid } : { spent: false },
      )
      expect(await executeConnectorRecovery(signed, bitcoin)).toEqual({ txid: signed.record.txid, confirmed: true })
      expect(bitcoin.broadcast).not.toHaveBeenCalled()
      vi.mocked(bitcoin.outspend).mockImplementation(async (_txid, vout) =>
        vout === input ? { spent: true, txid: 'ff'.repeat(32) } : { spent: false },
      )
      await expect(executeConnectorRecovery(signed, bitcoin)).rejects.toThrow('another transaction')
      expect(bitcoin.broadcast).not.toHaveBeenCalled()
    }
  })
  it('refuses missing service approval and unsigned or altered hardware responses', async () => {
    const { file } = fixture()
    const missing = structuredClone(file)
    delete missing.record.savingsWitness
    expect(() => connectorRecoveryHandoff(missing)).toThrow('Guardian and Emulator')
    await expect(executeConnectorRecovery(file, chain())).rejects.toThrow('signature is missing')
    expect(() => acceptConnectorRecoverySignature(file, connectorRecoveryHandoff(file))).toThrow()
    const tx = Transaction.fromPSBT(hex.decode(connectorRecoveryHandoff(file)), options)
    // Wire mutation creates an invalid Savings signature even if H signs the new output.
    const wire = hex.encode(tx.toPSBT())
    expect(() =>
      acceptConnectorRecoverySignature(file, wire.replace(file.record.savingsWitness![0], '00'.repeat(64))),
    ).toThrow()
  })
  it('rejects a changed enrollment, parent, candidate or approved Savings witness', () => {
    const { file } = fixture()
    const mutations: ((f: ConnectorRecoveryFile) => void)[] = [
      (f) => {
        f.header.binding.descriptorHash = '00'.repeat(32)
      },
      (f) => {
        f.header.status.connectorEnrollment!.enrollmentDigest = '00'.repeat(32)
      },
      (f) => {
        f.record.enrollmentDigest = '00'.repeat(32)
      },
      (f) => {
        f.record.savings.parentHex = '00'
      },
      (f) => {
        f.record.reserve.parentHex = '00'
      },
      (f) => {
        f.record.savingsWitness![0] = '00'.repeat(64)
      },
      (f) => {
        f.record.amountSats--
      },
      (f) => {
        f.record.signaturesMayHaveIssued = false
      },
      (f) => {
        f.header.binding.network = 'mutinynet'
      },
    ]
    for (const change of mutations) {
      const copy = structuredClone(file)
      change(copy)
      expect(() => connectorRecoveryHandoff(copy)).toThrow()
    }
  })
  it('broadcasts the validated snapshot if the caller changes the file during chain lookup', async () => {
    const signed = sign(fixture().file),
      bitcoin = chain()
    const original = signed.record.signedTxHex
    const replacement = vectors[1].payments[0]
    vi.mocked(bitcoin.outspend).mockImplementation(async () => {
      signed.record.signedTxHex = replacement.finalTx
      signed.record.txid = replacement.txid
      return { spent: false }
    })
    await executeConnectorRecovery(signed, bitcoin)
    expect(bitcoin.broadcast).toHaveBeenCalledWith(original)
  })
  it('does not report success for an unexpected broadcast transaction id', async () => {
    const signed = sign(fixture().file),
      bitcoin = chain()
    vi.mocked(bitcoin.broadcast).mockResolvedValue('ff'.repeat(32))
    await expect(executeConnectorRecovery(signed, bitcoin)).rejects.toThrow('uncertain')
  })
})
