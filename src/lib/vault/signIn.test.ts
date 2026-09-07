import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultStatus } from './types'

const mocks = vi.hoisted(() => ({
  publicStatus: vi.fn(),
  status: vi.fn(),
  pin: vi.fn(),
  provision: vi.fn(),
}))

vi.mock('./cosignerClient', () => ({
  vaultCosignerClient: { enrollment: { publicStatus: mocks.publicStatus, status: mocks.status } },
}))
vi.mock('./pin', () => ({
  pinEnrolledStatus: mocks.pin,
  pinFromEnrolledStatus: vi.fn(),
}))
vi.mock('./vtxo/board', () => ({
  provisionBoardingKey: mocks.provision,
}))

import { enablePasskeyLogin, unlockLocalEnrollment } from './signIn'
import { CONNECTOR_TEMPLATE } from './program/connector'
import { deriveDirectP256 } from './ceremony/directauth'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'

const HKDF_INFO = new TextEncoder().encode('arkade-2fa-vault/kek/v1')

async function envelope(prf: Uint8Array, secret: Uint8Array) {
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
    await crypto.subtle.importKey('raw', Uint8Array.from(prf).buffer, 'HKDF', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const nonce = new Uint8Array(12)
  nonce[0] = 1
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, Uint8Array.from(secret).buffer),
  )
  return {
    nonce: Array.from(nonce, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    ciphertext: Array.from(ciphertext, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  }
}

describe('local vault unlock', () => {
  beforeEach(() => {
    mocks.publicStatus.mockReset()
    mocks.status.mockReset()
    mocks.pin.mockReset()
    mocks.provision.mockReset()
    localStorage.clear()
  })

  it.each([false, true])(
    'shares only the unconsumed local ceremony and wipes keys when callback failure=%s',
    async (fail) => {
      const prf = new Uint8Array(32).fill(9),
        secret = new Uint8Array(32).fill(3)
      const direct = await deriveDirectP256(prf)
      const status = {
        enrolled: true,
        vaultId: 'ab'.repeat(32),
        network: 'mutinynet',
        rpId: location.hostname,
        clientOrigin: location.origin,
        phoneBip340Pub: `02${hex.encode(schnorr.getPublicKey(secret))}`,
        phoneDirectP256: hex.encode(direct.pub),
      } as VaultStatus
      direct.scalar.fill(0)
      const record = {
        vaultId: status.vaultId,
        credId: '01',
        webauthnP256: '02',
        phoneDirectP256: status.phoneDirectP256!,
        phoneBip340Pub: status.phoneBip340Pub!,
        ...(await envelope(prf, secret)),
      }
      mocks.publicStatus.mockResolvedValue(status)
      mocks.status.mockResolvedValue(status)
      const get = vi.fn(async () => ({
        rawId: Uint8Array.of(1).buffer,
        response: {
          clientDataJSON: Uint8Array.of(2).buffer,
          authenticatorData: Uint8Array.of(3).buffer,
          signature: Uint8Array.of(4).buffer,
        },
        getClientExtensionResults: () => ({ prf: { results: { first: prf.buffer } } }),
      }))
      Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get } })
      let keys: Uint8Array[] = []
      const callback = vi.fn(async (live, auth, canAuthorizeNew, enrollment) => {
        expect(live).toBe(status)
        expect(canAuthorizeNew).toBe(true)
        expect(enrollment).toBe(record)
        expect(auth.assertion).toEqual({
          credentialId: '01',
          clientDataJSON: '02',
          authenticatorData: '03',
          signature: '04',
        })
        keys = [auth.phoneSecret, auth.scalar]
        expect(keys.every((key) => key.some((b) => b !== 0))).toBe(true)
        if (fail) throw new Error('callback failed')
      })
      const result = unlockLocalEnrollment(record, callback)
      if (fail) await expect(result).rejects.toThrow('callback failed')
      else await expect(result).resolves.toMatchObject({ status })
      expect(get).toHaveBeenCalledOnce()
      expect(callback).toHaveBeenCalledOnce()
      expect(keys.every((key) => key.every((b) => b === 0))).toBe(true)
    },
  )

  it('does not sign a replacement connector binding when its independent enrollment pin is missing', async () => {
    mocks.status.mockResolvedValue({ enrolled: true, vaultId: 'vault-a', templateVersion: CONNECTOR_TEMPLATE })
    await expect(
      enablePasskeyLogin({ vaultId: 'vault-a' } as Parameters<typeof enablePasskeyLogin>[0]),
    ).rejects.toThrow('connector enrollment pin required')
    expect(mocks.provision).not.toHaveBeenCalled()
  })

  it('fetches and verifies the enrolled status before decrypting the phone scalar', async () => {
    const order: string[] = []
    const status = {
      enrolled: true,
      vaultId: 'vault-a',
      rpId: location.hostname,
      clientOrigin: location.origin,
      network: 'mutinynet',
    } as VaultStatus
    mocks.publicStatus.mockResolvedValue(status)
    let resolveStatus!: (status: VaultStatus) => void
    mocks.status.mockImplementation(
      () =>
        new Promise<VaultStatus>((resolve) => {
          order.push('status')
          resolveStatus = resolve
        }),
    )
    mocks.pin.mockImplementation(() => order.push('pin'))
    mocks.provision.mockImplementation(async () => order.push('provision'))
    const prf = new Uint8Array(32).fill(7)
    const phoneSecret = new Uint8Array(32)
    phoneSecret[31] = 9
    const encrypted = await envelope(prf, phoneSecret)
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      order.push('decrypt')
      return originalDecrypt(...args)
    })
    const getCredential = vi.fn(async () => {
      order.push('credentials')
      return {
        rawId: Uint8Array.of(1).buffer,
        getClientExtensionResults: () => ({ prf: { results: { first: prf.buffer } } }),
      }
    })
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { get: getCredential },
    })

    const unlocked = unlockLocalEnrollment({
      vaultId: 'vault-a',
      credId: '01',
      webauthnP256: '02',
      phoneDirectP256: '03',
      phoneBip340Pub: '04',
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
    })
    await vi.waitFor(() => expect(mocks.status).toHaveBeenCalledOnce())
    expect(getCredential).not.toHaveBeenCalled()
    resolveStatus(status)
    await expect(unlocked).resolves.toMatchObject({ status })
    expect(order).toEqual(['status', 'pin', 'credentials', 'decrypt', 'provision'])
  })
})
