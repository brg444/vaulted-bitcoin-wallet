import { describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { p2tr } from '@scure/btc-signer'
import { getNetwork, serializeExitPackage, type ExecutorEvent } from '@arkade-os/sdk'
import * as recoveryArchive from './recoveryArchive'
import { networkPins } from '../networkPins'
import { LightScript, lightDescriptorDigest } from './contract'
import {
  executeLightRecovery,
  prepareLightRecoveryWithSecret,
  requireConfirmedLightRecovery,
  validateLightRecoveryFile,
  type LightRecoveryFile,
} from './recovery'
import { lightTestEnrollment, testDescriptor, testOwner, testSecret } from './testdata/helpers'

async function recoveryFixture(): Promise<LightRecoveryFile> {
  const record = await lightTestEnrollment()
  const address = new LightScript(testDescriptor).onchainAddress(getNetwork('mutinynet'))
  const file: LightRecoveryFile = {
    ...record,
    name: 'vaulted-light-recovery',
    version: 1,
    createdAt: new Date().toISOString(),
    feeFundingAddress: p2tr(hex.decode(testDescriptor.ownerPub), undefined, getNetwork('mutinynet')).address!,
    exitPackage: {
      version: 1,
      mode: 'graph',
      network: 'mutinynet',
      createdAt: 1,
      feeRate: 1,
      sweepAddress: address,
      totals: { txCount: 1, totalFeeSats: 100, fundingRequiredSats: 0, recoveredSats: 1000 },
      vtxos: [
        { outpoint: 'ab'.repeat(32) + ':0', value: 1100, sweepFee: 100, delay: { type: 'seconds', value: 4608 } },
      ],
      steps: [
        {
          kind: 'sweep',
          vtxo: 'ab'.repeat(32) + ':0',
          txid: 'cd'.repeat(32),
          hex: '010203',
          dependsOnTxid: 'ab'.repeat(32),
          delay: { type: 'seconds', value: 4608 },
        },
      ],
    },
  }
  const digest = sha256(
    new TextEncoder().encode(
      `vaulted-light/exit-package/v1:${lightDescriptorDigest(file.descriptor)}:${file.feeFundingAddress}:${serializeExitPackage(file.exitPackage!)}`,
    ),
  )
  file.exitPackageSignature = hex.encode(schnorr.sign(digest, testOwner))
  return file
}

describe('Light owner-authenticated emergency files', () => {
  it('uses a validated imported archive when local browser storage is unavailable', async () => {
    const file = await recoveryFixture()
    const pins = networkPins('mutinynet')
    file.archive = {
      version: 1,
      descriptorHash: lightDescriptorDigest(file.descriptor),
      capturedAt: new Date().toISOString(),
      info: JSON.stringify({
        network: pins.operatorGetInfoNetwork,
        signerPubkey: pins.operatorSignerPub,
        checkpointTapscript: pins.checkpointTapscript,
        forfeitPubkey: pins.checkpointForfeitPub,
      }),
      coins: '[]',
      branches: {},
      transactions: {},
    }
    const storage = vi
      .spyOn(recoveryArchive, 'loadLightRecoveryArchive')
      .mockRejectedValue(new Error('Storage unavailable'))
    const fetch = vi.fn(() => {
      throw new Error('Unexpected provider request')
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const prepared = await prepareLightRecoveryWithSecret(file, hex.encode(testSecret), file.feeFundingAddress!, true)
      expect(prepared.archive).toEqual(file.archive)
      expect(prepared.exitPackage).toBeUndefined()
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      storage.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('round trips a key backup without claiming it has current exit paths', async () => {
    const record = await lightTestEnrollment()
    const file = validateLightRecoveryFile({ name: 'vaulted-light-recovery', version: 1, ...record })
    expect(file.exitPackage).toBeUndefined()
    await expect(
      executeLightRecovery(file, hex.encode(testSecret), new AbortController().signal, () => {}),
    ).rejects.toThrow('Prepare a current')
  })
  it('authenticates the entire package, fee address and descriptor with the owner key', async () => {
    const file = await recoveryFixture()
    expect(validateLightRecoveryFile(JSON.parse(JSON.stringify(file))).exitPackage).toEqual(file.exitPackage)
    for (const mutate of [
      (value: LightRecoveryFile) => {
        value.exitPackage!.feeRate = 100
      },
      (value: LightRecoveryFile) => {
        value.exitPackage!.totals.totalFeeSats = 1
      },
      (value: LightRecoveryFile) => {
        value.exitPackage!.steps = []
      },
      (value: LightRecoveryFile) => {
        value.exitPackageSignature = '00'.repeat(64)
      },
      (value: LightRecoveryFile) => {
        value.exitPackage!.network = 'bitcoin'
      },
      (value: LightRecoveryFile) => {
        value.feeFundingAddress = 'not-an-address'
      },
    ]) {
      const changed = structuredClone(file)
      mutate(changed)
      expect(() => validateLightRecoveryFile(changed)).toThrow()
    }
  })
  it('resumes an already-confirmed exit using only the Bitcoin explorer', async () => {
    const file = await recoveryFixture()
    const step = file.exitPackage!.steps[0]
    if (step.kind !== 'sweep') throw new Error('Sweep fixture required')
    const txid = step.txid
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/esplora/tx/${txid}`) return Response.json({ status: { confirmed: true } })
      if (url === `/esplora/tx/${txid}/status`)
        return Response.json({ confirmed: true, block_height: 100, block_time: 1700000000 })
      throw new Error(`Unexpected recovery request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const observed = vi.fn()
      await executeLightRecovery(file, hex.encode(testSecret), new AbortController().signal, observed)
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirmed', txid }))
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
        `/esplora/tx/${txid}`,
        `/esplora/tx/${txid}/status`,
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('honors cancellation before requesting providers or broadcasting', async () => {
    const file = await recoveryFixture()
    const fetch = vi.fn()
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', fetch)
    try {
      await expect(
        executeLightRecovery(file, hex.encode(testSecret), controller.signal, () => {}),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('rejects an altered package before fetching providers or attempting any broadcast', async () => {
    const file = await recoveryFixture()
    file.exitPackage!.feeRate = 2
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    try {
      await expect(
        executeLightRecovery(file, hex.encode(testSecret), new AbortController().signal, () => {}),
      ).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Light recovery completion', () => {
  async function* events(rows: ExecutorEvent[]) {
    yield* rows
  }
  it('accepts only a confirmed sweep for the exact prepared transaction', async () => {
    const file = await recoveryFixture()
    await expect(
      requireConfirmedLightRecovery(
        file.exitPackage!,
        events([{ stepIndex: 0, kind: 'sweep', status: 'confirmed', txid: 'cd'.repeat(32) }]),
        () => {},
      ),
    ).resolves.toBeUndefined()
  })
  it.each(['failed', 'broadcast', 'skipped', 'waiting_csv'] as const)(
    'does not call %s complete when the iterator ends',
    async (status) => {
      const file = await recoveryFixture()
      const event: ExecutorEvent = { stepIndex: 0, kind: 'sweep', status, txid: 'cd'.repeat(32) }
      const observed = vi.fn()
      await expect(requireConfirmedLightRecovery(file.exitPackage!, events([event]), observed)).rejects.toThrow(
        'incomplete',
      )
      expect(observed).toHaveBeenCalledWith(event)
    },
  )
  it('rejects missing or unrelated confirmations and a partially failed exit', async () => {
    const file = await recoveryFixture()
    for (const rows of [
      [],
      [{ stepIndex: 0, kind: 'sweep', status: 'confirmed', txid: 'ef'.repeat(32) }],
      [
        { stepIndex: 1, kind: 'bump', status: 'failed' },
        { stepIndex: 0, kind: 'sweep', status: 'confirmed', txid: 'cd'.repeat(32) },
      ],
    ] as ExecutorEvent[][]) {
      await expect(requireConfirmedLightRecovery(file.exitPackage!, events(rows), () => {})).rejects.toThrow(
        'incomplete',
      )
    }
  })
})
