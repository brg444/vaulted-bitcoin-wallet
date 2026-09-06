import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { createBoardingProgramScript, getNetwork } from '@arkade-os/sdk'
import { networkPins } from '../networkPins'
import { hexToBytes } from '../hex'
import { defaultSpendingPolicy } from '../spendingPolicy'
import { CONNECTOR_TEMPLATE } from './connector'
import {
  buildConnectorEnrollmentPreview,
  hashConnectorBoardComposite,
  parseConnectorOriginPath,
  preflightConnectorEnrollment,
  requireConnectorCapability,
  requireProposedConnectorDescriptor,
  verifyConnectorStatus,
  buildConnectorRecoveryKit,
  parseConnectorRecoveryKit,
  saveConnectorEnrollmentPin,
  loadConnectorEnrollmentPin,
  saveConnectorRecoveryKit,
  loadConnectorRecoveryKit,
  CONNECTOR_ENROLLMENT_SCHEMA,
  CONNECTOR_DESCRIPTOR_SCHEMA,
  REQUIRED_CONNECTOR_CAPABILITY,
  type ConnectorEnrollmentPreviewInput,
  type ConnectorRecoveryKit,
} from './connectorEnroll'
import type { BoardingDescriptor, VaultStatus } from '../types'
import vectors from './connector-vectors.json'

const vector = vectors[0]
function failFixture(): never {
  throw new Error('vector shape')
}
const V_NETWORK: 'mainnet' | 'mutinynet' =
  vector.network === 'mainnet' || vector.network === 'mutinynet' ? vector.network : failFixture()
const V_TIER: 'standard' | 'advanced' =
  vector.tier === 'standard' || vector.tier === 'advanced' ? vector.tier : failFixture()
const V_TYPE: 'p2wpkh' | 'p2tr' =
  vector.connectorType === 'p2wpkh' || vector.connectorType === 'p2tr' ? vector.connectorType : failFixture()

const pins = networkPins(V_NETWORK)
const spendingPolicy = defaultSpendingPolicy(V_NETWORK)

function testBoarding(phonePub: string, boardingPub: string, cosignerPub: string): BoardingDescriptor {
  const program = createBoardingProgramScript(
    {
      name: 'vault-board-v1',
      boardingPubKey: hexToBytes(boardingPub).slice(1),
      cosignerPubKey: hexToBytes(cosignerPub).slice(1),
      recoveryPubKey: hexToBytes(phonePub).slice(1),
    },
    hexToBytes(pins.operatorSignerPub).slice(1),
    { type: 'seconds', value: BigInt(pins.boardExitDelay) },
  )
  return {
    schema: 'arkade-vault/board-v1',
    program: 'vault-board-v1',
    template: 'vault-board-v1-boarding-vault-and-operator',
    network: V_NETWORK,
    boardingPub: boardingPub.toLowerCase(),
    recoveryPhonePub: phonePub.toLowerCase(),
    vaultBoardCosignerPub: cosignerPub.toLowerCase(),
    operatorPub: pins.operatorSignerPub.toLowerCase(),
    exitDelay: pins.boardExitDelay,
    exitDelayUnit: 'seconds',
    script: hex.encode(program.pkScript),
    address: program.onchainAddress(getNetwork(pins.sdkNetwork)),
  }
}

const boarding = testBoarding(vector.phone, vector.hardware, vector.guardian)

function previewInput(): ConnectorEnrollmentPreviewInput {
  return {
    vaultId: 'connector-family-fixture',
    network: V_NETWORK,
    protectionTier: V_TIER,
    phonePub: vector.phone,
    phoneDirectP256: vector.phoneDirect,
    ...(V_TIER === 'advanced' && vector.recovery ? { recoveryPub: vector.recovery } : {}),
    vaultCosignerBase: vector.guardian,
    arkadeCosignerBase: vector.emulator,
    arkadeOrigin: 'fixture-arkade-origin',
    arkadeVersion: 'fixture-arkade-version',
    spendingPolicy,
    origin: {
      connectorPub: vector.hardware,
      connectorType: V_TYPE,
      connectorFingerprint: vector.originFingerprint,
      connectorPath: [...vector.originPath],
    },
    boarding,
  }
}

function mockServerPreview() {
  const preview = buildConnectorEnrollmentPreview(previewInput())
  return {
    preview,
    raw: {
      schema: CONNECTOR_ENROLLMENT_SCHEMA,
      vaultId: 'connector-family-fixture',
      connector: {
        schema: CONNECTOR_DESCRIPTOR_SCHEMA,
        template: CONNECTOR_TEMPLATE,
        vaultId: 'connector-family-fixture',
        network: V_NETWORK,
        protectionTier: V_TIER,
        phonePub: vector.phone,
        hardwarePub: vector.hardware,
        ...(V_TIER === 'advanced' && vector.recovery ? { recoveryPub: vector.recovery } : {}),
        phoneDirectP256: vector.phoneDirect,
        vaultCosignerBase: vector.guardian,
        arkadeCosignerBase: vector.emulator,
        spendingPolicyDigest: preview.descriptor.policy.digest,
        program: hex.encode(preview.family.program),
        savingsScript: hex.encode(preview.family.savings.script),
        savingsAddress: preview.family.savings.address,
        connectorScript: hex.encode(preview.family.connector.script),
        connectorType: V_TYPE,
        fingerprint: vector.originFingerprint,
        originPath: vector.originPath.join('/'),
        enrollmentDigest: preview.digest,
      },
      boarding,
    },
  }
}

function mockStatus(preview: ReturnType<typeof buildConnectorEnrollmentPreview>): VaultStatus {
  return {
    enrolled: true,
    network: V_NETWORK,
    clientOrigin: 'http://localhost:3003',
    rpId: 'localhost',
    vaultId: 'connector-family-fixture',
    templateVersion: CONNECTOR_TEMPLATE,
    policyVersion: 'vault-spending-policy-v1',
    protectionTier: V_TIER,
    externalOwnerWalletPub: vector.hardware,
    vaultCosignerBasePub: vector.guardian,
    arkadeCosignerBasePub: vector.emulator,
    arkadeCosignerOrigin: 'fixture-arkade-origin',
    arkadeCosignerVersion: 'fixture-arkade-version',
    savingsAddress: preview.family.savings.address,
    savingsScript: hex.encode(preview.family.savings.script),
    periodAllowance: 0,
    periodSpent: 0,
    periodRemaining: 0,
    txCap: 0,
    absoluteFeeCap: spendingPolicy.absoluteFeeCapSats,
    feerateCapSatVb: spendingPolicy.feerateCapSatPerV,
    spendingPolicy,
    spendingPolicyDigest: preview.descriptor.policy.digest,
    phoneBip340Pub: vector.phone,
    phoneDirectP256: vector.phoneDirect,
    ...(V_TIER === 'advanced' && vector.recovery ? { recoveryPub: vector.recovery } : {}),
    vtxoBoardingDescriptor: boarding,
    vtxoBoardingDescriptorHash: preview.boardingHash,
    connectorEnrollment: {
      connectorPub: vector.hardware,
      connectorType: V_TYPE,
      connectorFingerprint: vector.originFingerprint,
      connectorPath: [...vector.originPath],
      enrollmentDigest: preview.digest,
      descriptorHash: preview.compositeHash,
    },
  }
}

function mockPin(preview: ReturnType<typeof buildConnectorEnrollmentPreview>) {
  return {
    vaultId: 'connector-family-fixture',
    network: V_NETWORK,
    connectorPub: vector.hardware,
    connectorType: V_TYPE,
    connectorFingerprint: vector.originFingerprint,
    connectorPath: [...vector.originPath],
    enrollmentDigest: preview.digest,
    descriptorHash: preview.compositeHash,
    savingsAddress: preview.family.savings.address,
    savingsScript: hex.encode(preview.family.savings.script),
    protectionTier: V_TIER,
  }
}

describe('connector enrollment reconstruction', () => {
  it('reproduces the runtime-generated enrollment digest and family', () => {
    const preview = buildConnectorEnrollmentPreview(previewInput())
    expect(preview.digest).toBe(vector.enrollmentDigest)
    expect(hex.encode(preview.family.connector.script)).toBe(vector.reserve)
    expect(hex.encode(preview.family.savings.script)).toBe(vector.script)
    expect(preview.family.savings.address).toBe(vector.address)
    expect(preview.descriptor.policy.digest).toBe(spendingPolicyDigestForTest())
  })

  it('commits sha256(0x01 || digest || boardingHash) as the composite hash', () => {
    const preview = buildConnectorEnrollmentPreview(previewInput())
    const payload = new Uint8Array(65)
    payload[0] = 0x01
    payload.set(hex.decode(preview.digest), 1)
    payload.set(hex.decode(preview.boardingHash), 33)
    expect(preview.compositeHash).toBe(hex.encode(sha256(payload)))
    expect(preview.compositeHash).toBe(hashConnectorBoardComposite(preview.digest, preview.boardingHash))
  })

  it('rebuilds deterministically', () => {
    const a = buildConnectorEnrollmentPreview(previewInput())
    const b = buildConnectorEnrollmentPreview(previewInput())
    expect(b).toEqual(a)
  })

  it('parses slash-joined origin paths strictly', () => {
    expect(parseConnectorOriginPath(vector.originPath.join('/'))).toEqual(vector.originPath)
    expect(() => parseConnectorOriginPath('')).toThrowError('connector origin path required')
    expect(() => parseConnectorOriginPath("84'/0'/0'")).toThrowError('connector origin path required')
    expect(() => parseConnectorOriginPath('1/4294967296')).toThrowError('connector origin path required')
  })
})

function spendingPolicyDigestForTest(): string {
  return buildConnectorEnrollmentPreview(previewInput()).descriptor.policy.digest
}

describe('connector preview verification', () => {
  it('accepts a faithful preview and returns the verified commitment', () => {
    const { preview, raw } = mockServerPreview()
    const verified = requireProposedConnectorDescriptor(raw, preview.compositeHash, {
      vaultId: 'connector-family-fixture',
      network: V_NETWORK,
      phonePub: vector.phone,
      phoneDirectP256: vector.phoneDirect,
      ...(V_TIER === 'advanced' && vector.recovery ? { recoveryPub: vector.recovery } : {}),
      protectionTier: V_TIER,
      spendingPolicy,
      spendingPolicyDigest: preview.descriptor.policy.digest,
      origin: {
        connectorPub: vector.hardware,
        connectorType: V_TYPE,
        connectorFingerprint: vector.originFingerprint,
        connectorPath: [...vector.originPath],
      },
      boardingPub: vector.hardware,
      arkadeOrigin: 'fixture-arkade-origin',
      arkadeVersion: 'fixture-arkade-version',
    })
    expect(verified.digest).toBe(preview.digest)
    expect(verified.compositeHash).toBe(preview.compositeHash)
  })

  it('rejects tampered previews without trusting stored scripts', () => {
    const { preview, raw } = mockServerPreview()
    const expectReject = (mutate: (connector: Record<string, unknown>) => void, message: string) => {
      const tampered = JSON.parse(JSON.stringify(raw)) as { connector: Record<string, unknown> }
      mutate(tampered.connector)
      expect(() =>
        requireProposedConnectorDescriptor(tampered, preview.compositeHash, {
          vaultId: 'connector-family-fixture',
          network: V_NETWORK,
          phonePub: vector.phone,
          phoneDirectP256: vector.phoneDirect,
          ...(V_TIER === 'advanced' && vector.recovery ? { recoveryPub: vector.recovery } : {}),
          protectionTier: V_TIER,
          spendingPolicy,
          spendingPolicyDigest: preview.descriptor.policy.digest,
          origin: {
            connectorPub: vector.hardware,
            connectorType: V_TYPE,
            connectorFingerprint: vector.originFingerprint,
            connectorPath: [...vector.originPath],
          },
          boardingPub: vector.hardware,
          arkadeOrigin: 'fixture-arkade-origin',
          arkadeVersion: 'fixture-arkade-version',
        }),
      ).toThrowError(message)
    }
    expectReject(
      (c) => (c.enrollmentDigest = `ff${String(c.enrollmentDigest).slice(2)}`),
      'does not match reconstruction',
    )
    expectReject((c) => (c.program = `ff${String(c.program).slice(2)}`), 'does not match reconstruction')
    expectReject(
      (c) => (c.savingsAddress = 'bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
      'does not match reconstruction',
    )
    expectReject((c) => (c.connectorType = c.connectorType === 'p2tr' ? 'p2wpkh' : 'p2tr'), 'does not match')
    expectReject((c) => (c.fingerprint = 1), 'does not match import')
    expectReject((c) => (c.originPath = '2147483734/2147483648/2147483648/0/1'), 'does not match import')
    expectReject((c) => (c.hardwarePub = vector.phone), 'does not match')
    expect(() =>
      requireProposedConnectorDescriptor(raw, `ff${preview.compositeHash.slice(2)}`, {
        vaultId: 'connector-family-fixture',
        network: V_NETWORK,
        phonePub: vector.phone,
        phoneDirectP256: vector.phoneDirect,
        protectionTier: V_TIER,
        spendingPolicy,
        spendingPolicyDigest: preview.descriptor.policy.digest,
        origin: {
          connectorPub: vector.hardware,
          connectorType: V_TYPE,
          connectorFingerprint: vector.originFingerprint,
          connectorPath: [...vector.originPath],
        },
        boardingPub: vector.hardware,
        arkadeOrigin: 'fixture-arkade-origin',
        arkadeVersion: 'fixture-arkade-version',
      }),
    ).toThrowError('does not match reconstruction')
  })
})

describe('connector status verification', () => {
  it('accepts the enrolled status against the retained pin', () => {
    const preview = buildConnectorEnrollmentPreview(previewInput())
    expect(() =>
      verifyConnectorStatus(mockStatus(preview), mockPin(preview), { boardingPub: vector.hardware }),
    ).not.toThrow()
  })

  it('rejects drifted status facts', () => {
    const preview = buildConnectorEnrollmentPreview(previewInput())
    const pin = mockPin(preview)
    expect(() => verifyConnectorStatus({ ...mockStatus(preview), savingsAddress: 'bc1qdrift' }, pin)).toThrowError(
      'Savings address changed',
    )
    expect(() =>
      verifyConnectorStatus({ ...mockStatus(preview), externalOwnerWalletPub: vector.phone }, pin),
    ).toThrowError('does not match enrolled hardware')
    expect(() => verifyConnectorStatus({ ...mockStatus(preview), templateVersion: 'other' }, pin)).toThrowError(
      'not a connector enrollment',
    )
    expect(() =>
      verifyConnectorStatus(
        { ...mockStatus(preview), vtxoBoardingDescriptorHash: `ff${preview.boardingHash.slice(2)}` },
        pin,
        { boardingPub: vector.hardware },
      ),
    ).toThrowError('boarding descriptor does not match')
  })
})

describe('connector preflight, pin, and kit', () => {
  it('preflights the boarding program and network before any passkey', () => {
    const capable = {
      network: V_NETWORK,
      vtxoBoardingProgram: 'vault-board-v1',
      connectorCapability: { ...REQUIRED_CONNECTOR_CAPABILITY },
    }
    expect(preflightConnectorEnrollment(capable, V_NETWORK, spendingPolicy)).toEqual({
      network: V_NETWORK,
    })
    expect(() =>
      preflightConnectorEnrollment({ ...capable, network: 'mainnet' }, 'mutinynet', spendingPolicy),
    ).toThrowError('network mismatch')
    expect(() =>
      preflightConnectorEnrollment({ ...capable, vtxoBoardingProgram: 'other' }, V_NETWORK, spendingPolicy),
    ).toThrowError('boarding program')
  })

  it('rejects old Guardians without the connector capability before passkey creation', () => {
    const base = { network: V_NETWORK, vtxoBoardingProgram: 'vault-board-v1' }
    // Absent capability: old Guardian.
    expect(() => preflightConnectorEnrollment(base, V_NETWORK, spendingPolicy)).toThrowError(
      'Guardian does not support connector enrollment',
    )
    expect(() => requireConnectorCapability({})).toThrowError('Guardian does not support connector enrollment')
    // Wrong template or schema: unsupported capability.
    expect(() =>
      requireConnectorCapability({ connectorCapability: { ...REQUIRED_CONNECTOR_CAPABILITY, template: 'other' } }),
    ).toThrowError('Guardian does not support connector enrollment')
    expect(() =>
      requireConnectorCapability({ connectorCapability: { ...REQUIRED_CONNECTOR_CAPABILITY, schema: 'other' } }),
    ).toThrowError('Guardian does not support connector enrollment')
    // Exact capability passes.
    expect(() =>
      requireConnectorCapability({ connectorCapability: { ...REQUIRED_CONNECTOR_CAPABILITY } }),
    ).not.toThrow()
  })

  it('rejects a self-consistent replacement of the boarding commitment', () => {
    const input = previewInput()
    const enrolled = buildConnectorEnrollmentPreview(input)
    const changed = buildConnectorEnrollmentPreview({ ...input, arkadeOrigin: input.arkadeOrigin + '-changed' })
    expect(changed.digest).toBe(enrolled.digest)
    expect(changed.compositeHash).not.toBe(enrolled.compositeHash)
    const status = mockStatus(changed)
    status.arkadeCosignerOrigin = input.arkadeOrigin + '-changed'
    expect(() => verifyConnectorStatus(status, mockPin(enrolled))).toThrow(/origin|hash|enrollment/)
  })

  it('round-trips the enrollment pin through storage', () => {
    const preview = buildConnectorEnrollmentPreview(previewInput())
    const pin = mockPin(preview)
    const storage = makeStorage()
    saveConnectorEnrollmentPin(pin, storage)
    expect(loadConnectorEnrollmentPin(pin.vaultId, storage)).toEqual(pin)
    storage.setItem('arkade-vault-connector-enrollment:connector-family-fixture', '{"connectorPub":"bad"}')
    expect(loadConnectorEnrollmentPin(pin.vaultId, storage)).toBeNull()
  })

  it('round-trips the versioned kit and rejects tampering', () => {
    const preview = buildConnectorEnrollmentPreview(previewInput())
    const kit = buildConnectorRecoveryKit(preview, {
      vaultId: 'connector-family-fixture',
      network: V_NETWORK,
      origin: {
        connectorPub: vector.hardware,
        connectorType: V_TYPE,
        connectorFingerprint: vector.originFingerprint,
        connectorPath: [...vector.originPath],
      },
      boarding,
    })
    expect(parseConnectorRecoveryKit(kit)).toEqual(kit)
    const storage = makeStorage()
    saveConnectorRecoveryKit(kit, storage)
    expect(loadConnectorRecoveryKit(kit.vaultId, storage)).toEqual(kit)
    const tampered: ConnectorRecoveryKit = { ...kit, connectorScript: `ff${kit.connectorScript.slice(2)}` }
    expect(() => parseConnectorRecoveryKit(tampered)).toThrowError('does not match rebuild')
    expect(() => parseConnectorRecoveryKit({ ...kit, version: 999 })).toThrowError('unsupported connector kit version')
  })
})

function makeStorage(): Storage {
  const backing = new Map<string, string>()
  return {
    get length() {
      return backing.size
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => [...backing.keys()][index] ?? null,
    removeItem: (key: string) => void backing.delete(key),
    setItem: (key: string, value: string) => void backing.set(key, value),
  } as Storage
}
