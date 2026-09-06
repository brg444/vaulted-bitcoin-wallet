import type { LightKeyBackup } from './light/keyBackup'
import { clearOpenEnrollmentSession, openEnrollmentToken } from './openEnrollmentSession'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { vaultCosignerClient } from './cosignerClient'
import { bytesToHex, hexToBytes } from './hex'
import { xOnly } from './setupPlan'
import {
  clearStagedEnrollment,
  loadStagedEnrollment,
  promoteStagedEnrollment,
  saveStagedEnrollment,
  type StagedEnrollment,
} from './enrollmentStore'
import { requireProposedBoardingDescriptor } from './program/enroll'
import {
  buildConnectorRecoveryKit,
  preflightConnectorEnrollment,
  requireProposedConnectorDescriptor,
  saveConnectorEnrollmentPin,
  saveConnectorRecoveryKit,
  verifyConnectorStatus,
  type ConnectorEnrollmentPin,
  type VerifiedConnectorProposal,
} from './program/connectorEnroll'
import { fetchVaultReadiness } from './status'
import { saveLocalKit } from './program/kitStore'
import { buildRecoveryKit } from './program/kit'
import { pinEnrolledStatus, pinFromEnrolledStatus, requireStatusMatchesPin, saveAddressPin } from './pin'
import type { VaultStatus } from './types'
import type { VaultProgramDescriptor } from './program/descriptor'
import { allowPasskey, passkeyCreateOptions, passkeyGetOptions, prfExtension, prfFrom } from './webauthn'
import { activateBoardingKey, requireBoardingStatus, stageBoardingKey, BOARDING_PROGRAM } from './vtxo/board'
import { sameSpendingPolicy, spendingPolicyDigest, validateSpendingPolicy, type SpendingPolicy } from './spendingPolicy'
import { requireProtectionTierMatchesRecovery, type ProtectionTier } from './protectionTier'

const PRF_SALT = new TextEncoder().encode('arkade-2fa-vault/prf/v1')
const HKDF_INFO = new TextEncoder().encode('arkade-2fa-vault/kek/v1')
const DIRECT_INFO = new TextEncoder().encode('arkade-2fa-vault/direct-p256/v1')

export interface EnrollmentSecrets {
  lightKeyBackup?: LightKeyBackup
  vaultId: string
  credId: string
  webauthnP256: string
  phoneDirectP256: string
  phoneBip340Pub: string
  nonce: string
  ciphertext: string
}

function requireRPID(status: { rpId?: string; clientOrigin?: string }): string {
  const rpId = String(status.rpId || '').toLowerCase()
  if (!rpId || rpId !== location.hostname.toLowerCase()) {
    throw new Error('deployment RP ID does not match this signing client host')
  }
  if (status.clientOrigin !== location.origin) {
    throw new Error('deployment origin does not match this signing client origin')
  }
  return rpId
}

export async function compressedES256(response: AuthenticatorAttestationResponse): Promise<Uint8Array> {
  if (response.getPublicKeyAlgorithm() !== -7) throw new Error('credential public key must use ES256')
  const spki = response.getPublicKey()
  if (!spki) throw new Error('credential public key unavailable')
  const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('credential public key must be uncompressed P-256')
  const out = new Uint8Array(33)
  out[0] = (raw[64] & 1) === 1 ? 0x03 : 0x02
  out.set(raw.subarray(1, 33), 1)
  return out
}

async function deriveDirectP256(prf: Uint8Array<ArrayBuffer>): Promise<{ pub: Uint8Array }> {
  const key = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveBits'])
  for (let counter = 0; counter <= 255; counter++) {
    const info = new Uint8Array(DIRECT_INFO.length + 4)
    info.set(DIRECT_INFO)
    new DataView(info.buffer).setUint32(info.length - 4, counter, false)
    const scalar = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info }, key, 256),
    )
    if (p256.utils.isValidSecretKey(scalar)) {
      return { pub: p256.getPublicKey(scalar, true) }
    }
    scalar.fill(0)
  }
  throw new Error('authenticator did not return PRF')
}

export interface EnrollmentRoles {
  protectionTier: ProtectionTier
  hardwarePub: string
  recoveryPub?: string
  spendingPolicy: SpendingPolicy
  connector?: {
    connectorPub: string
    connectorType: 'p2wpkh' | 'p2tr'
    connectorFingerprint: number
    connectorPath: number[]
  }
}

function connectorPinFromStaged(staged: {
  descriptorHash?: string
  vaultId: string
  connectorPub?: string
  connectorType?: 'p2wpkh' | 'p2tr'
  connectorFingerprint?: number
  connectorPath?: number[]
  connectorDescriptorHash?: string
  connectorSavingsAddress?: string
  connectorSavingsScript?: string
  connectorNetwork?: 'mainnet' | 'mutinynet'
  protectionTier: ProtectionTier
}): ConnectorEnrollmentPin {
  const {
    connectorPub,
    connectorType,
    connectorFingerprint,
    connectorPath,
    connectorDescriptorHash,
    connectorSavingsAddress,
    connectorSavingsScript,
    connectorNetwork,
  } = staged
  if (
    !connectorPub ||
    (connectorType !== 'p2wpkh' && connectorType !== 'p2tr') ||
    typeof connectorFingerprint !== 'number' ||
    !Number.isInteger(connectorFingerprint) ||
    !Array.isArray(connectorPath) ||
    !connectorDescriptorHash ||
    !staged.descriptorHash ||
    !connectorSavingsAddress ||
    !connectorSavingsScript ||
    (connectorNetwork !== 'mainnet' && connectorNetwork !== 'mutinynet')
  )
    throw new Error('staged connector enrollment is incomplete')
  return {
    vaultId: staged.vaultId,
    network: connectorNetwork,
    connectorPub,
    connectorType,
    connectorFingerprint,
    connectorPath: [...connectorPath],
    enrollmentDigest: connectorDescriptorHash,
    descriptorHash: staged.descriptorHash,
    savingsAddress: connectorSavingsAddress,
    savingsScript: connectorSavingsScript,
    protectionTier: staged.protectionTier,
  }
}

export async function enrollWithPasskey(
  enrollmentToken: string,
  roles: EnrollmentRoles,
): Promise<{ status: VaultStatus; enrollment: EnrollmentSecrets }> {
  const started = await beginTenantEnrollment(enrollmentToken, roles)
  return finishTenantEnrollment(started.enrollmentToken)
}

export async function beginTenantEnrollment(
  enrollmentToken: string,
  roles: EnrollmentRoles,
): Promise<{ enrollment: EnrollmentSecrets; descriptor?: VaultProgramDescriptor; enrollmentToken: string }> {
  if (typeof location !== 'undefined' && location.hostname === '127.0.0.1') {
    throw new Error('Open this page as http://localhost:3003 so the passkey can bind to localhost.')
  }
  let token = String(enrollmentToken || '').trim()
  const protectionTier = requireProtectionTierMatchesRecovery(roles.protectionTier, roles.recoveryPub || '')
  const wantRecovery = protectionTier === 'advanced'
  const selectedPolicy = validateSpendingPolicy(roles.spendingPolicy)
  const selectedPolicyDigest = spendingPolicyDigest(selectedPolicy)
  const publicStatus = await vaultCosignerClient.enrollment.publicStatus()
  if (publicStatus.vtxoBoardingProgram !== BOARDING_PROGRAM) {
    throw new Error('vault service does not advertise the required boarding program')
  }
  const connector = roles.connector
  const hardwareXOnly = xOnly(roles.hardwarePub)
  const recoveryXOnly = wantRecovery ? xOnly(roles.recoveryPub || '') : ''
  if (wantRecovery && hardwareXOnly === recoveryXOnly) throw new Error('Recovery must be a different key')
  if (connector) {
    if (xOnly(connector.connectorPub) !== hardwareXOnly) throw new Error('connector key does not match hardware key')
    if (connector.connectorType !== 'p2wpkh' && connector.connectorType !== 'p2tr')
      throw new Error('connector type must be p2tr or p2wpkh')
  }
  const enrollmentNetwork =
    publicStatus.network === 'mainnet' || publicStatus.network === 'mutinynet' ? publicStatus.network : null
  let arkadeOrigin = ''
  let arkadeVersion = ''
  if (connector) {
    if (!enrollmentNetwork) throw new Error('unsupported enrollment network')
    // Capability preflight BEFORE passkey creation: everything the public
    // status advertises is checked here. Connector support itself is proven at
    // propose time (unknown fields fail closed) before finish.
    preflightConnectorEnrollment(publicStatus, enrollmentNetwork, selectedPolicy)
    const readiness = await fetchVaultReadiness()
    if (readiness.state !== 'ready') throw new Error('vault service is not ready for enrollment')
    arkadeVersion = readiness.status.arkadeVersion
  }
  const rpId = requireRPID(publicStatus)
  if (!token) {
    if (publicStatus.enrollmentMode !== 'open') throw new Error('setup code required')
    token = await openEnrollmentToken()
  }
  const start = await vaultCosignerClient.enrollment.start(token, {
    protectionTier,
    spendingPolicy: selectedPolicy,
    spendingPolicyDigest: selectedPolicyDigest,
  })
  if (!start.vaultId || !start.challenge || !start.handle || !start.userId) {
    throw new Error('authorizer did not assign a vault')
  }
  if (
    start.protectionTier !== protectionTier ||
    !sameSpendingPolicy(start.spendingPolicy, selectedPolicy) ||
    start.spendingPolicyDigest !== selectedPolicyDigest
  ) {
    throw new Error('vault service changed the selected spending policy')
  }
  const cred = (await navigator.credentials.create({
    publicKey: passkeyCreateOptions({
      rp: { name: 'Spending vault', id: start.rpId || rpId },
      user: {
        id: hexToBytes(start.userId) as BufferSource,
        name: start.userName || 'vault',
        displayName: 'Spending vault',
      },
      challenge: hexToBytes(start.challenge) as BufferSource,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: prfExtension(PRF_SALT),
    }),
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('The operation was aborted.')
  let prf = prfFrom(cred)
  if (!prf) {
    const get = (await navigator.credentials.get({
      publicKey: passkeyGetOptions(
        {
          challenge: hexToBytes(start.challenge) as BufferSource,
          rpId: start.rpId || rpId,
          allowCredentials: [allowPasskey(cred.rawId, true)],
          userVerification: 'required',
          extensions: prfExtension(PRF_SALT, new Uint8Array(cred.rawId)),
        },
        true,
      ),
    })) as PublicKeyCredential | null
    prf = get ? prfFrom(get) : null
  }
  if (!prf || prf.length !== 32) throw new Error('authenticator did not return PRF')

  const att = cred.response as AuthenticatorAttestationResponse
  const webauthnP256 = await compressedES256(att)
  const direct = await deriveDirectP256(prf)
  const phoneSecret = crypto.getRandomValues(new Uint8Array(32))
  const phoneBip340Pub = secp256k1.getPublicKey(phoneSecret, true)
  const authData = att.getAuthenticatorData ? new Uint8Array(att.getAuthenticatorData()) : new Uint8Array()
  let enrollment!: EnrollmentSecrets
  let stagedBoard!: Awaited<ReturnType<typeof stageBoardingKey>>
  let proposed!: Awaited<ReturnType<typeof vaultCosignerClient.enrollment.propose>>
  let composite!: { savings: VaultProgramDescriptor; boarding: unknown }
  let connectorVerified: VerifiedConnectorProposal | null = null
  let descriptor!: VaultProgramDescriptor
  try {
    stagedBoard = await stageBoardingKey({ vaultId: start.vaultId, phoneSecret, network: publicStatus.network })
    const kek = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
      await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    )
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, kek, phoneSecret))
    enrollment = {
      vaultId: start.vaultId,
      credId: bytesToHex(new Uint8Array(cred.rawId)),
      webauthnP256: bytesToHex(webauthnP256),
      phoneDirectP256: bytesToHex(direct.pub),
      phoneBip340Pub: bytesToHex(phoneBip340Pub),
      nonce: bytesToHex(nonce),
      ciphertext: bytesToHex(ciphertext),
    }
    const enrollmentRequest = {
      handle: start.handle,
      userHandle: start.userId,
      clientDataJSON: bytesToHex(new Uint8Array(att.clientDataJSON)),
      authenticatorData: bytesToHex(authData),
      attestationObject: bytesToHex(new Uint8Array(att.attestationObject)),
      credentialId: enrollment.credId,
      webauthnP256: enrollment.webauthnP256,
      phoneDirectP256: enrollment.phoneDirectP256,
      phoneBip340Pub: enrollment.phoneBip340Pub,
      vaultId: start.vaultId,
      externalOwnerWalletXOnly: hardwareXOnly,
      ...(recoveryXOnly ? { recoveryXOnly } : {}),
      ...(connector
        ? {
            connectorType: connector.connectorType,
            connectorPub: connector.connectorPub.toLowerCase(),
            connectorFingerprint: connector.connectorFingerprint,
            connectorPath: [...connector.connectorPath],
          }
        : {}),
      vtxoBoardingProgram: BOARDING_PROGRAM,
      vaultBoardingBip340Pub: xOnly(stagedBoard.boardingPub),
      protectionTier,
      spendingPolicy: selectedPolicy,
      spendingPolicyDigest: selectedPolicyDigest,
    }
    // The network and descriptor-validation phases need only public facts.
    // Restore the original short secret lifetime before yielding to either.
    prf.fill(0)
    phoneSecret.fill(0)
    proposed = await vaultCosignerClient.enrollment.propose(token, enrollmentRequest)
    if (connector && enrollmentNetwork) {
      try {
        connectorVerified = requireProposedConnectorDescriptor(proposed.descriptor, proposed.descriptorHash, {
          vaultId: start.vaultId,
          network: enrollmentNetwork,
          phonePub: enrollment.phoneBip340Pub,
          phoneDirectP256: enrollment.phoneDirectP256,
          ...(recoveryXOnly ? { recoveryPub: roles.recoveryPub || '' } : {}),
          protectionTier,
          spendingPolicy: selectedPolicy,
          spendingPolicyDigest: selectedPolicyDigest,
          origin: {
            connectorPub: connector.connectorPub.toLowerCase(),
            connectorType: connector.connectorType,
            connectorFingerprint: connector.connectorFingerprint,
            connectorPath: [...connector.connectorPath],
          },
          boardingPub: stagedBoard.boardingPub,
          arkadeVersion,
        })
      } catch (error) {
        if (error instanceof Error && /unknown field/i.test(error.message)) {
          throw new Error('Guardian does not support connector enrollment')
        }
        throw error
      }
      composite = { savings: connectorVerified.preview.descriptor, boarding: connectorVerified.boarding }
      arkadeOrigin = connectorVerified.preview.descriptor.arkadeCosigner.origin
      descriptor = connectorVerified.preview.descriptor
    } else {
      composite = requireProposedBoardingDescriptor(proposed.descriptor, proposed.descriptorHash, {
        vaultId: start.vaultId,
        phonePub: enrollment.phoneBip340Pub,
        boardingPub: stagedBoard.boardingPub,
        network: publicStatus.network,
      })
      descriptor = composite.savings
    }
  } finally {
    prf.fill(0)
    phoneSecret.fill(0)
  }
  if (wantRecovery) {
    if (xOnly(descriptor.keys.recovery || '') !== recoveryXOnly) {
      throw new Error('proposed recovery key does not match this client')
    }
  } else if (descriptor.keys.recovery) {
    throw new Error('this setup skipped recovery')
  }
  if (xOnly(descriptor.keys.hardware) !== hardwareXOnly) {
    throw new Error('proposed hardware key does not match this client')
  }
  if (descriptor.protectionTier !== protectionTier) {
    throw new Error('proposed protection tier does not match this setup')
  }
  const proposedPolicy = validateSpendingPolicy(
    {
      program: descriptor.policy.program,
      schema: descriptor.policy.schema,
      period: descriptor.policy.period,
      periodAllowanceSats: descriptor.policy.periodAllowanceSats,
      txRecipientCapSats: descriptor.policy.recipientCapSats,
      absoluteFeeCapSats: descriptor.policy.absoluteFeeCapSats,
      feerateCapSatPerV: descriptor.policy.feerateCapSatVb,
    },
    connector ? (enrollmentNetwork ?? undefined) : undefined,
  )
  const policiesMatch = connector
    ? spendingPolicyDigest(proposedPolicy, enrollmentNetwork ?? undefined) ===
      spendingPolicyDigest(selectedPolicy, enrollmentNetwork ?? undefined)
    : sameSpendingPolicy(proposedPolicy, selectedPolicy)
  if (!policiesMatch || descriptor.policy.digest !== selectedPolicyDigest) {
    throw new Error('proposed spending policy does not match this setup')
  }
  const staged: StagedEnrollment = {
    ...enrollment,
    handle: start.handle,
    userHandle: start.userId,
    clientDataJSON: bytesToHex(new Uint8Array(att.clientDataJSON)),
    authenticatorData: bytesToHex(authData),
    attestationObject: bytesToHex(new Uint8Array(att.attestationObject)),
    hardwareXOnly,
    ...(recoveryXOnly ? { recoveryXOnly } : {}),
    inviteToken: token,
    descriptorHash: proposed.descriptorHash,
    boardingPub: stagedBoard.boardingPub,
    boardingDescriptor: composite.boarding,
    boardingDescriptorHash: connectorVerified?.boardingHash ?? proposed.descriptorHash,
    savingsAddress: descriptor.savings.address,
    savingsScript: descriptor.savings.script,
    protectionTier,
    spendingPolicy: selectedPolicy,
    spendingPolicyDigest: selectedPolicyDigest,
    ...(connector && enrollmentNetwork && connectorVerified
      ? {
          connectorPub: connector.connectorPub.toLowerCase(),
          connectorType: connector.connectorType,
          connectorFingerprint: connector.connectorFingerprint,
          connectorPath: [...connector.connectorPath],
          connectorDescriptorHash: connectorVerified.digest,
          connectorSavingsAddress: connectorVerified.savingsAddress,
          connectorSavingsScript: connectorVerified.savingsScript,
          connectorNetwork: enrollmentNetwork,
          connectorArkadeOrigin: arkadeOrigin,
          connectorArkadeVersion: arkadeVersion,
        }
      : {}),
  }
  saveStagedEnrollment(staged)
  if (connector && connectorVerified) {
    saveConnectorRecoveryKit(
      buildConnectorRecoveryKit(connectorVerified.preview, {
        vaultId: start.vaultId,
        network: connectorVerified.preview.descriptor.network as 'mainnet' | 'mutinynet',
        origin: {
          connectorPub: connector.connectorPub.toLowerCase(),
          connectorType: connector.connectorType,
          connectorFingerprint: connector.connectorFingerprint,
          connectorPath: [...connector.connectorPath],
        },
        boarding: connectorVerified.boarding,
      }),
    )
  }
  saveLocalKit(buildRecoveryKit(descriptor))
  return { enrollment, descriptor, enrollmentToken: token }
}

export async function finishTenantEnrollment(
  enrollmentToken: string,
  storage: Storage = localStorage,
): Promise<{ status: VaultStatus; enrollment: EnrollmentSecrets }> {
  const token = String(enrollmentToken || '').trim()
  if (!token) throw new Error('setup code required')
  const staged = loadStagedEnrollment(storage)
  if (!staged?.vaultId || !staged.descriptorHash || !staged.boardingPub || !staged.boardingDescriptorHash) {
    throw new Error('finish setup first')
  }
  const finishRequest = {
    handle: staged.handle,
    userHandle: staged.userHandle,
    clientDataJSON: staged.clientDataJSON,
    authenticatorData: staged.authenticatorData,
    attestationObject: staged.attestationObject,
    credentialId: staged.credId,
    webauthnP256: staged.webauthnP256,
    phoneDirectP256: staged.phoneDirectP256,
    phoneBip340Pub: staged.phoneBip340Pub,
    vaultId: staged.vaultId,
    externalOwnerWalletXOnly: staged.hardwareXOnly,
    ...(staged.recoveryXOnly ? { recoveryXOnly: staged.recoveryXOnly } : {}),
    ...(staged.connectorPub && staged.connectorType
      ? {
          connectorType: staged.connectorType,
          connectorPub: staged.connectorPub,
          connectorFingerprint: staged.connectorFingerprint,
          connectorPath: staged.connectorPath ? [...staged.connectorPath] : [],
        }
      : {}),
    descriptorHash: staged.descriptorHash,
    vtxoBoardingProgram: BOARDING_PROGRAM,
    vaultBoardingBip340Pub: xOnly(staged.boardingPub),
    protectionTier: staged.protectionTier,
    spendingPolicy: staged.spendingPolicy,
    spendingPolicyDigest: staged.spendingPolicyDigest,
  }
  await vaultCosignerClient.enrollment.finish(token, finishRequest)
  const live = await vaultCosignerClient.enrollment.status(staged.vaultId)
  requireBoardingStatus(live, String(staged.boardingPub || ''))
  if (staged.connectorPub) {
    verifyConnectorStatus(live, connectorPinFromStaged(staged), { boardingPub: String(staged.boardingPub || '') })
    saveConnectorEnrollmentPin(connectorPinFromStaged(staged))
  }
  await activateBoardingKey({
    vaultId: staged.vaultId,
    descriptorHash: String(live.vtxoBoardingDescriptorHash || staged.boardingDescriptorHash || ''),
    expectedBoardingPub: String(staged.boardingPub || ''),
  })
  const pin = pinFromEnrolledStatus({
    ...live,
    savingsAddress: staged.savingsAddress || live.savingsAddress,
    savingsScript: staged.savingsScript || live.savingsScript,
  })
  saveAddressPin(pin, storage)
  requireStatusMatchesPin(live, pin)
  pinEnrolledStatus(live, storage)
  promoteStagedEnrollment(staged, storage)
  clearOpenEnrollmentSession()
  return { status: live, enrollment: staged }
}

export async function reconcileStagedEnrollment(
  storage: Storage = localStorage,
): Promise<{ status: VaultStatus; enrollment: EnrollmentSecrets } | null> {
  const staged = loadStagedEnrollment(storage)
  if (!staged?.vaultId) return null
  if (!staged.boardingPub || !staged.boardingDescriptorHash) throw new Error('staged boarding setup is incomplete')
  const live = await vaultCosignerClient.enrollment.status(staged.vaultId)
  if (!live.enrolled) return null
  requireBoardingStatus(live, String(staged.boardingPub || ''))
  if (staged.connectorPub) {
    verifyConnectorStatus(live, connectorPinFromStaged(staged), { boardingPub: String(staged.boardingPub || '') })
    saveConnectorEnrollmentPin(connectorPinFromStaged(staged))
  }
  await activateBoardingKey({
    vaultId: staged.vaultId,
    descriptorHash: String(live.vtxoBoardingDescriptorHash || staged.boardingDescriptorHash || ''),
    expectedBoardingPub: String(staged.boardingPub || ''),
  })
  if (staged.savingsAddress) {
    const pin = pinFromEnrolledStatus({
      ...live,
      savingsAddress: staged.savingsAddress,
      savingsScript: staged.savingsScript || live.savingsScript,
    })
    saveAddressPin(pin, storage)
    requireStatusMatchesPin(live, pin)
  } else {
    pinEnrolledStatus(live, storage)
  }
  promoteStagedEnrollment(staged, storage)
  clearOpenEnrollmentSession()
  return { status: live, enrollment: staged }
}

export function abandonStagedEnrollment(storage: Storage = localStorage) {
  clearStagedEnrollment(storage)
}

export function hexCredentialId(id: string): BufferSource {
  return hexToBytes(id) as BufferSource
}
