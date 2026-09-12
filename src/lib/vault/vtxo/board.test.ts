import 'fake-indexeddb/auto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { createBoardingProgramScript, getNetwork } from '@arkade-os/sdk'
import { describe, expect, it } from 'vitest'
import type { BoardingDescriptor } from '../types'
import {
  boardingWorkerPins,
  activateBoardingKey,
  deleteBoardingKey,
  loadActiveBoardingKey,
  suspendBoardingKey,
  deriveBoardingKey,
  MUTINYNET_OPERATOR_SIGNER_PUB,
  requireBoardingDescriptor,
  stageBoardingKey,
  BOARDING_EXIT_DELAY,
  BOARDING_EXIT_DELAY_UNIT,
  BOARDING_PROGRAM,
  BOARDING_SCHEMA,
  BOARDING_TEMPLATE,
} from './board'

function compressedSecret(value: number) {
  const secret = new Uint8Array(32)
  secret[31] = value
  return hex.encode(secp256k1.getPublicKey(secret, true))
}

function descriptor(): { descriptor: BoardingDescriptor; phonePub: string; boardingPub: string } {
  const boardingPub = compressedSecret(1)
  const phonePub = compressedSecret(2)
  const cosignerPub = compressedSecret(3)
  const program = createBoardingProgramScript(
    {
      name: BOARDING_PROGRAM,
      boardingPubKey: hex.decode(boardingPub).slice(1),
      cosignerPubKey: hex.decode(cosignerPub).slice(1),
      recoveryPubKey: hex.decode(phonePub).slice(1),
    },
    hex.decode(MUTINYNET_OPERATOR_SIGNER_PUB).slice(1),
    { type: 'seconds', value: BigInt(BOARDING_EXIT_DELAY) },
  )
  return {
    boardingPub,
    phonePub,
    descriptor: {
      schema: BOARDING_SCHEMA,
      program: BOARDING_PROGRAM,
      template: BOARDING_TEMPLATE,
      network: 'mutinynet',
      boardingPub,
      recoveryPhonePub: phonePub,
      vaultBoardCosignerPub: cosignerPub,
      operatorPub: MUTINYNET_OPERATOR_SIGNER_PUB,
      exitDelay: BOARDING_EXIT_DELAY,
      exitDelayUnit: BOARDING_EXIT_DELAY_UNIT,
      script: hex.encode(program.pkScript),
      address: program.onchainAddress(getNetwork('mutinynet')),
    },
  }
}

describe('vault-board-v1 program binding', () => {
  it('binds worker Operator and delay pins to the active vault network', () => {
    expect(boardingWorkerPins('mutinynet', 'mutinynet')).toMatchObject({
      network: 'mutinynet',
      operatorOrigin: 'https://mutinynet.arkade.sh',
      boardExitDelay: 604_672,
    })
    expect(boardingWorkerPins('mainnet', 'mainnet')).toMatchObject({
      network: 'mainnet',
      operatorOrigin: 'https://arkade.computer',
      boardExitDelay: 7_776_256,
    })
    expect(() => boardingWorkerPins('mainnet', 'mutinynet')).toThrow(/different network/)
  })
  it('accepts only the exact reconstructed release program', () => {
    const fixture = descriptor()
    expect(
      requireBoardingDescriptor(fixture.descriptor, {
        vaultId: 'vault-a',
        phonePub: fixture.phonePub,
        boardingPub: fixture.boardingPub,
        network: 'mutinynet',
      }),
    ).toEqual(fixture.descriptor)
  })

  it.each([
    ['script', (value: BoardingDescriptor) => ({ ...value, script: `${value.script.slice(0, -2)}00` })],
    ['address', (value: BoardingDescriptor) => ({ ...value, address: `${value.address}x` })],
    ['role', (value: BoardingDescriptor) => ({ ...value, vaultBoardCosignerPub: compressedSecret(4) })],
    ['collision', (value: BoardingDescriptor) => ({ ...value, vaultBoardCosignerPub: value.boardingPub })],
    ['CSV', (value: BoardingDescriptor) => ({ ...value, exitDelay: value.exitDelay - 1 })],
    ['Operator', (value: BoardingDescriptor) => ({ ...value, operatorPub: compressedSecret(5) })],
  ])('rejects a mutated %s', (_name, mutate) => {
    const fixture = descriptor()
    expect(() =>
      requireBoardingDescriptor(mutate(fixture.descriptor), {
        vaultId: 'vault-a',
        phonePub: fixture.phonePub,
        boardingPub: fixture.boardingPub,
        network: 'mutinynet',
      }),
    ).toThrow()
  })

  it('derives one deterministic, even-Y key per vault and network binding', async () => {
    const phoneSecret = new Uint8Array(32)
    phoneSecret[31] = 7
    const first = await deriveBoardingKey(phoneSecret, 'vault-a', 'mutinynet')
    const again = await deriveBoardingKey(phoneSecret, 'vault-a', 'mutinynet')
    const other = await deriveBoardingKey(phoneSecret, 'vault-b', 'mutinynet')
    try {
      expect(first.boardingPub).toBe(again.boardingPub)
      expect(first.boardingPub.startsWith('02')).toBe(true)
      expect(other.boardingPub).not.toBe(first.boardingPub)
    } finally {
      first.secret.fill(0)
      again.secret.fill(0)
      other.secret.fill(0)
      phoneSecret.fill(0)
    }
  })

  it('accepts an already-active exact key but rejects an activation mismatch', async () => {
    const vaultId = 'vault-board-activation'
    const descriptorHash = 'ab'.repeat(32)
    const phoneSecret = new Uint8Array(32)
    phoneSecret[31] = 7
    try {
      const staged = await stageBoardingKey({ vaultId, phoneSecret, network: 'mutinynet' })
      await activateBoardingKey({
        vaultId,
        descriptorHash,
        expectedBoardingPub: staged.boardingPub,
      })
      await expect(
        activateBoardingKey({ vaultId, descriptorHash, expectedBoardingPub: staged.boardingPub }),
      ).resolves.toBeUndefined()
      await expect(
        activateBoardingKey({
          vaultId,
          descriptorHash: 'cd'.repeat(32),
          expectedBoardingPub: staged.boardingPub,
        }),
      ).rejects.toThrow(/active vault-board-v1 key does not match descriptor/)
    } finally {
      phoneSecret.fill(0)
      await deleteBoardingKey(vaultId)
    }
  })
})

describe('boarding key activation revocation', () => {
  it.each(['mainnet', 'mutinynet'] as const)(
    'preserves the exact staged key through suspension on %s',
    async (network) => {
      const vaultId = 'session-suspend-' + network
      const phoneSecret = new Uint8Array(32).fill(11)
      const staged = await stageBoardingKey({ vaultId, network, phoneSecret })
      const activation = { vaultId, descriptorHash: 'ab'.repeat(32), expectedBoardingPub: staged.boardingPub }
      await activateBoardingKey(activation)
      const before = await loadActiveBoardingKey(vaultId)
      await suspendBoardingKey(vaultId)
      await expect(loadActiveBoardingKey(vaultId)).rejects.toThrow('active vault-board-v1 key required')
      await suspendBoardingKey(vaultId)
      await activateBoardingKey(activation)
      const after = await loadActiveBoardingKey(vaultId)
      expect(after).toEqual(before)
      before.secret.fill(0)
      after.secret.fill(0)
      phoneSecret.fill(0)
      await deleteBoardingKey(vaultId)
    },
  )
})
