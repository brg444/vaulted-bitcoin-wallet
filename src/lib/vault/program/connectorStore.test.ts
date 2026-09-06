import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { Address, OutScript, Transaction } from '@scure/btc-signer'
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js'
import { vaultAddressNetwork } from '../addressNetwork'
import { defaultSpendingPolicy } from '../spendingPolicy'
import { VaultConcurrencyUnavailableError, type VaultLockManager } from '../vtxo/lock'
import { connectorEnrollmentDigest } from './connector'
import {
  cancelPendingConnectorOperation,
  connectorLockName,
  connectorStoreKey,
  loadPendingConnectorOperation,
  markConnectorSignaturesMayHaveIssued,
  preparePendingConnectorOperation,
  reservedConnectorOutpoints,
  storeConnectorSavingsWitness,
  storeConnectorSignedTx,
  storeConnectorPhoneStage,
  withConnectorLock,
  type ConnectorExpectedIdentity,
  type ConnectorPendingInput,
} from './connectorStore'
import vectors from './connector-vectors.json'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

// Shared-exclusive fake: separate store instances using the same manager
// serialize on the per-vault lock, mirroring the Web Locks contract.
class FakeLockManager implements VaultLockManager {
  private readonly held = new Set<string>()
  private readonly waiters = new Map<string, (() => void)[]>()
  readonly acquisitions: string[] = []

  async request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T> {
    if (this.held.has(name) && options.ifAvailable) return callback(null)
    while (this.held.has(name)) {
      await new Promise<void>((resolve) => {
        const waiters = this.waiters.get(name) || []
        waiters.push(resolve)
        this.waiters.set(name, waiters)
      })
    }
    this.held.add(name)
    this.acquisitions.push(name)
    try {
      return await callback({ name })
    } finally {
      this.held.delete(name)
      this.waiters.get(name)?.shift()?.()
    }
  }
}

const OPTIONS = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true } as const

function vectorInput(
  vectorIndex = 0,
  paymentIndex = 0,
): {
  input: ConnectorPendingInput
  expected: ConnectorExpectedIdentity
  payment: (typeof vectors)[number]['payments'][number]
} {
  const v = vectors[vectorIndex]
  if (v.network !== 'mainnet' && v.network !== 'mutinynet') throw new Error('vector network')
  if (v.tier !== 'standard' && v.tier !== 'advanced') throw new Error('vector tier')
  if (v.connectorType !== 'p2tr' && v.connectorType !== 'p2wpkh') throw new Error('connector type')
  const spendingPolicy = defaultSpendingPolicy(v.network)
  const contract: ConnectorPendingInput['contract'] = {
    connectorType: v.connectorType,
    // The enrollment digest commits the vault id; vectors pin 'connector-family-fixture'.
    vaultId: 'connector-family-fixture',
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
  }
  const payment = v.payments[paymentIndex]
  const recipient = Address(vaultAddressNetwork(v.network)).encode(
    OutScript.decode(hex.decode(payment.recipientScript)),
  )
  return {
    input: {
      contract,
      origin: { publicKey: v.hardware, fingerprint: v.originFingerprint, path: [...v.originPath] },
      savings: { txid: payment.parentTxid, vout: 0, parentHex: payment.parent },
      reserve: { txid: payment.parentTxid, vout: 1, parentHex: payment.parent },
      recipient,
      amountSats: payment.amount,
      feeSats: payment.fee,
    },
    // The enrollment identity is supplied independently of stored state —
    // production passes the local enrollment pin, never a stored copy.
    expected: { vaultId: 'connector-family-fixture', enrollmentDigest: v.enrollmentDigest },
    payment,
  }
}

describe('connector durable approval/handoff', () => {
  it('restores the exact phone-signed authorization instead of signing again after response loss', async () => {
    const { input, expected } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const { prepared, candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
    const key = new Uint8Array(32)
    key[31] = 3
    const first = prepared.signPhone(key)
    const second = prepared.signPhone(key)
    expect(second).not.toBe(first) // Valid Schnorr auxiliary randomness changes the wire request.
    expect(prepared.verifyPhoneStage(second)).toBe(second)
    await storeConnectorPhoneStage(expected, candidateTxid, first, storage, locks)
    const restored = await loadPendingConnectorOperation(expected, storage, new FakeLockManager())
    expect(restored?.record.phoneSignedPsbt).toBe(first)
    expect(restored?.phase).toBe('signing')
    await expect(storeConnectorPhoneStage(expected, candidateTxid, second, storage, locks)).rejects.toThrow(
      /already saved/,
    )
    await storeConnectorPhoneStage(expected, candidateTxid, first, storage, locks)
    await expect(cancelPendingConnectorOperation(expected, candidateTxid, storage, locks)).rejects.toThrow(
      /retained for chain reconciliation/,
    )
  })

  it('checks all saved phone-stage metadata on restore, beyond the unsigned transaction id', async () => {
    const { input, expected } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const { prepared, candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
    const key = new Uint8Array(32)
    key[31] = 3
    await storeConnectorPhoneStage(expected, candidateTxid, prepared.signPhone(key), storage, locks)
    const stored = storage.getItem(connectorStoreKey(expected.vaultId))!
    const mutate = (change: (wire: ReturnType<typeof RawPSBTV0.decode>) => void) => {
      const record = JSON.parse(stored)
      const wire = RawPSBTV0.decode(hex.decode(record.phoneSignedPsbt))
      change(wire)
      record.phoneSignedPsbt = hex.encode(RawPSBTV0.encode(wire))
      storage.setItem(connectorStoreKey(expected.vaultId), JSON.stringify(record))
    }
    for (const index of [0, 1]) {
      mutate((wire) => {
        delete wire.inputs[index].unknown
      })
      await expect(loadPendingConnectorOperation(expected, storage, locks)).rejects.toThrow(/changed connector/)
    }
    mutate((wire) => {
      wire.inputs[1].tapKeySig = new Uint8Array(64)
    })
    await expect(loadPendingConnectorOperation(expected, storage, locks)).rejects.toThrow(/changed connector/)
    mutate((wire) => {
      wire.inputs[0].tapScriptSig![0][1][0] ^= 1
    })
    await expect(loadPendingConnectorOperation(expected, storage, locks)).rejects.toThrow(/phone signature/)
    storage.setItem(connectorStoreKey(expected.vaultId), stored)
    expect((await loadPendingConnectorOperation(expected, storage, locks))?.record.phoneSignedPsbt).toBeDefined()
  })

  it('persists the exact candidate before any signing request', async () => {
    const { input, expected, payment } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const { record, prepared, candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
    expect(record.signaturesMayHaveIssued).toBe(false)
    expect(record.signedTxHex).toBeUndefined()
    expect(/^[0-9a-f]{64}$/.test(candidateTxid)).toBe(true)
    const stored = Transaction.fromPSBT(hex.decode(record.candidatePsbt), OPTIONS)
    expect(hex.encode(stored.unsignedTx)).toBe(payment.unsigned)
    expect(stored.id).toBe(candidateTxid)
    const hardware = prepared.forHardware(payment.savingsWitness.map((item) => hex.decode(item)))
    expect(hardware.accept(payment.responsePSBT)).toEqual({ txHex: payment.finalTx, txid: payment.txid })
    const loaded = await loadPendingConnectorOperation(expected, storage, locks)
    expect(loaded?.phase).toBe('prepared')
    expect(loaded?.candidateTxid).toBe(candidateTxid)
    // Reload returns the rebuilt handle from the retained request: it signs too.
    const rederived = loaded!.prepared.forHardware(payment.savingsWitness.map((item) => hex.decode(item)))
    expect(rederived.accept(payment.responsePSBT)).toEqual({ txHex: payment.finalTx, txid: payment.txid })
    expect(locks.acquisitions).toEqual([connectorLockName(expected.vaultId), connectorLockName(expected.vaultId)])
  })

  it('restores the same signed candidate after reload and re-derives the broadcast tx', async () => {
    const { input, expected, payment } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const { candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
    await markConnectorSignaturesMayHaveIssued(expected, candidateTxid, storage, locks)
    await storeConnectorSavingsWitness(expected, candidateTxid, payment.savingsWitness, storage, locks)
    const { txHex, txid } = await storeConnectorSignedTx(expected, candidateTxid, payment.finalTx, storage, locks)
    expect(txHex).toBe(payment.finalTx)
    expect(txid).toBe(payment.txid)
    const reloadedLocks = new FakeLockManager()
    const loaded = await loadPendingConnectorOperation(expected, storage, reloadedLocks)
    expect(loaded?.phase).toBe('signed')
    expect(loaded?.candidateTxid).toBe(candidateTxid)
    expect(loaded?.record.signedTxHex).toBe(payment.finalTx)
    expect(loaded?.record.txid).toBe(payment.txid)
    const rebuilt = Transaction.fromPSBT(hex.decode(loaded!.record.candidatePsbt), OPTIONS)
    expect(hex.encode(rebuilt.unsignedTx)).toBe(payment.unsigned)
  })

  it('retains input ownership across timeout/cancel/reload once signatures may exist', async () => {
    const { input, expected } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const { candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
    await markConnectorSignaturesMayHaveIssued(expected, candidateTxid, storage, locks)
    await expect(preparePendingConnectorOperation(input, expected, storage, locks)).rejects.toThrow(/already pending/)
    const reloaded = await loadPendingConnectorOperation(expected, storage, locks)
    expect(reloaded?.phase).toBe('signing')
    await expect(cancelPendingConnectorOperation(expected, candidateTxid, storage, locks)).rejects.toThrow(
      /retained for chain reconciliation/,
    )
    expect(await loadPendingConnectorOperation(expected, storage, locks)).not.toBeNull()
  })

  it('serializes concurrent preparations across two instances under the shared lock', async () => {
    const { input, expected } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = withConnectorLock(
      expected.vaultId,
      async () => {
        order.push('first-start')
        await gate
        order.push('first-end')
        return 'first'
      },
      locks,
    )
    await Promise.resolve()
    const second = (async () => {
      await preparePendingConnectorOperation(input, expected, storage, locks)
      order.push('second-prepared')
    })()
    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    release()
    await first
    await second
    expect(order).toEqual(['first-start', 'first-end', 'second-prepared'])
    const third = preparePendingConnectorOperation(input, expected, storage, locks)
    const fourth = preparePendingConnectorOperation(input, expected, storage, locks)
    await expect(Promise.all([third, fourth])).rejects.toThrow(/already pending/)
    expect(await loadPendingConnectorOperation(expected, storage, locks)).not.toBeNull()
  })

  it('rebroadcasts the same raw tx after a lost broadcast response and never clears signed state', async () => {
    const { input, expected, payment } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const { candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
    await storeConnectorSavingsWitness(expected, candidateTxid, payment.savingsWitness, storage, locks)
    await storeConnectorSignedTx(expected, candidateTxid, payment.finalTx, storage, locks)
    const pending = await loadPendingConnectorOperation(expected, storage, locks)
    expect(pending?.record.signedTxHex).toBe(payment.finalTx)
    expect(pending?.phase).toBe('signed')
    await expect(cancelPendingConnectorOperation(expected, candidateTxid, storage, locks)).rejects.toThrow(
      /retained for chain reconciliation/,
    )
    expect(await loadPendingConnectorOperation(expected, storage, locks)).not.toBeNull()
  })

  it('keeps an unconfirmed signed operation pending and reserves both outpoints distinctly', async () => {
    const { input, expected } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const { candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
    await markConnectorSignaturesMayHaveIssued(expected, candidateTxid, storage, locks)
    const reserved = await reservedConnectorOutpoints(expected, storage, locks)
    expect(reserved.savings).toEqual({ txid: input.savings.txid, vout: input.savings.vout })
    expect(reserved.reserve).toEqual({ txid: input.reserve.txid, vout: input.reserve.vout })
    expect(`${reserved.savings!.txid}:${reserved.savings!.vout}`).not.toBe(
      `${reserved.reserve!.txid}:${reserved.reserve!.vout}`,
    )
    expect((await loadPendingConnectorOperation(expected, storage, locks))?.phase).toBe('signing')
  })

  it('rejects transplanted records and wrong pins against the independent identity', async () => {
    const { input, expected } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    await preparePendingConnectorOperation(input, expected, storage, locks)
    const key = connectorStoreKey(expected.vaultId)
    const raw = storage.getItem(key)!
    storage.setItem(connectorStoreKey('other-vault'), raw)
    await expect(
      loadPendingConnectorOperation(
        { vaultId: 'other-vault', enrollmentDigest: expected.enrollmentDigest },
        storage,
        locks,
      ),
    ).rejects.toThrow(/vault identity mismatch/)
    const rewritten = JSON.parse(raw) as Record<string, unknown>
    ;(rewritten.contract as Record<string, unknown>).vaultId = 'other-vault'
    storage.setItem(connectorStoreKey('other-vault'), JSON.stringify(rewritten))
    await expect(
      loadPendingConnectorOperation(
        { vaultId: 'other-vault', enrollmentDigest: expected.enrollmentDigest },
        storage,
        locks,
      ),
    ).rejects.toThrow()
    const wrongPin = { vaultId: expected.vaultId, enrollmentDigest: '00'.repeat(32) }
    await expect(loadPendingConnectorOperation(wrongPin, storage, locks)).rejects.toThrow()
    await expect(markConnectorSignaturesMayHaveIssued(wrongPin, '00'.repeat(32), storage, locks)).rejects.toThrow()
    await expect(reservedConnectorOutpoints(wrongPin, storage, locks)).rejects.toThrow()
    expect((await loadPendingConnectorOperation(expected, storage, locks))?.phase).toBe('prepared')
  })

  it('rejects tampered stores fail-closed on every method', async () => {
    const { input, expected, payment } = vectorInput()
    const key = connectorStoreKey(expected.vaultId)
    const corruptions: [string, (record: Record<string, unknown>) => void][] = [
      [
        'digest-label',
        (record) => {
          record.enrollmentDigest = '11'.repeat(32)
        },
      ],
      [
        'amount',
        (record) => {
          record.amountSats = (record.amountSats as number) + 1
        },
      ],
      [
        'recipient',
        (record) => {
          record.recipient = input.reserve.txid
        },
      ],
      [
        'savings-vout',
        (record) => {
          record.savings = { ...(record.savings as object), vout: 2 }
        },
      ],
      [
        'candidate',
        (record) => {
          record.candidatePsbt = payment.finalTx
        },
      ],
      [
        'witness-length',
        (record) => {
          record.savingsWitness = ['00']
        },
      ],
      [
        'version',
        (record) => {
          record.version = 999
        },
      ],
    ]
    for (const [name, mutate] of corruptions) {
      const storage = memoryStorage()
      const locks = new FakeLockManager()
      const { candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
      const record = JSON.parse(storage.getItem(key)!) as Record<string, unknown>
      mutate(record)
      storage.setItem(key, JSON.stringify(record))
      await expect(loadPendingConnectorOperation(expected, storage, locks), name).rejects.toThrow()
      await expect(
        markConnectorSignaturesMayHaveIssued(expected, candidateTxid, storage, locks),
        name,
      ).rejects.toThrow()
      await expect(storeConnectorPhoneStage(expected, candidateTxid, '', storage, locks), name).rejects.toThrow()
      await expect(
        storeConnectorSavingsWitness(expected, candidateTxid, payment.savingsWitness, storage, locks),
        name,
      ).rejects.toThrow()
      await expect(
        storeConnectorSignedTx(expected, candidateTxid, payment.finalTx, storage, locks),
        name,
      ).rejects.toThrow()
      await expect(reservedConnectorOutpoints(expected, storage, locks), name).rejects.toThrow()
      await expect(cancelPendingConnectorOperation(expected, candidateTxid, storage, locks), name).rejects.toThrow()
    }
    expect(
      connectorEnrollmentDigest(input.contract, { ...input.origin, publicKey: hex.decode(input.origin.publicKey) }),
    ).toBe(expected.enrollmentDigest)
  })

  it('validates the saved witness on load even before any signed tx exists', async () => {
    const { input, expected, payment } = vectorInput()
    const key = connectorStoreKey(expected.vaultId)
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const { candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
    await storeConnectorSavingsWitness(expected, candidateTxid, payment.savingsWitness, storage, locks)
    expect((await loadPendingConnectorOperation(expected, storage, locks))?.phase).toBe('signing')
    const record = JSON.parse(storage.getItem(key)!) as Record<string, unknown>
    const witness = [...(record.savingsWitness as string[])]
    witness[0] = witness[0].slice(0, -2) + (witness[0].endsWith('00') ? 'ff' : '00')
    record.savingsWitness = witness
    storage.setItem(key, JSON.stringify(record))
    await expect(loadPendingConnectorOperation(expected, storage, locks)).rejects.toThrow()
  })

  it('rejects post-signature tampering of amount and recipient on restore', async () => {
    const { input, expected, payment } = vectorInput()
    const key = connectorStoreKey(expected.vaultId)
    const buildSigned = async () => {
      const storage = memoryStorage()
      const locks = new FakeLockManager()
      const { candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
      await storeConnectorSavingsWitness(expected, candidateTxid, payment.savingsWitness, storage, locks)
      await storeConnectorSignedTx(expected, candidateTxid, payment.finalTx, storage, locks)
      return storage
    }
    for (const mutate of [
      (record: Record<string, unknown>) => {
        record.amountSats = (record.amountSats as number) - 1
      },
      (record: Record<string, unknown>) => {
        record.recipient = input.recipient.slice(0, -1) + 'q'
      },
    ]) {
      const storage = await buildSigned()
      const locks = new FakeLockManager()
      const record = JSON.parse(storage.getItem(key)!) as Record<string, unknown>
      mutate(record)
      storage.setItem(key, JSON.stringify(record))
      await expect(loadPendingConnectorOperation(expected, storage, locks)).rejects.toThrow()
    }
    const storage = await buildSigned()
    expect((await loadPendingConnectorOperation(expected, storage, new FakeLockManager()))?.record.signedTxHex).toBe(
      payment.finalTx,
    )
  })

  it('cancels only the exact never-signed candidate it names', async () => {
    const { input, expected } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const { candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
    await expect(cancelPendingConnectorOperation(expected, '00'.repeat(32), storage, locks)).rejects.toThrow(/stale/)
    await cancelPendingConnectorOperation(expected, candidateTxid, storage, locks)
    expect(await loadPendingConnectorOperation(expected, storage, locks)).toBeNull()
    expect(await reservedConnectorOutpoints(expected, storage, locks)).toEqual({ savings: null, reserve: null })
    await preparePendingConnectorOperation(input, expected, storage, locks)
    expect((await loadPendingConnectorOperation(expected, storage, locks))?.phase).toBe('prepared')
  })

  it('requires the shared lock and fails closed without it', async () => {
    const { input, expected } = vectorInput()
    const storage = memoryStorage()
    await expect(preparePendingConnectorOperation(input, expected, storage, null)).rejects.toBeInstanceOf(
      VaultConcurrencyUnavailableError,
    )
    await expect(loadPendingConnectorOperation(expected, storage, null)).rejects.toBeInstanceOf(
      VaultConcurrencyUnavailableError,
    )
  })

  it('rejects a signed tx that does not derive from the stored candidate', async () => {
    const first = vectorInput(0, 0)
    const second = vectorInput(0, 1 % vectors[0].payments.length)
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    const { candidateTxid } = await preparePendingConnectorOperation(first.input, first.expected, storage, locks)
    await storeConnectorSavingsWitness(first.expected, candidateTxid, first.payment.savingsWitness, storage, locks)
    if (second.payment.finalTx === first.payment.finalTx) return
    await expect(
      storeConnectorSignedTx(first.expected, candidateTxid, second.payment.finalTx, storage, locks),
    ).rejects.toThrow()
  })

  it('isolates storage namespaces and locks for vault ids containing separators', async () => {
    expect(connectorStoreKey('a:b')).toBe('arkade-vault-connector-v1-pending-v1:a:b')
    expect(connectorStoreKey('a:c')).toBe('arkade-vault-connector-v1-pending-v1:a:c')
    expect(connectorStoreKey('a:b')).not.toBe(connectorStoreKey('a:c'))
    expect(connectorLockName('a:b')).not.toBe(connectorLockName('a:c'))
    expect(() => connectorStoreKey('  ')).toThrow(/vault id required/)
    // The prepared record lands under the full-id key, not a truncated one.
    const { input, expected } = vectorInput()
    const storage = memoryStorage()
    await preparePendingConnectorOperation(input, expected, storage, new FakeLockManager())
    expect(storage.getItem(connectorStoreKey(expected.vaultId))).toContain('candidatePsbt')
  })

  it('snapshots queued arguments before lock acquisition', async () => {
    const { input, expected } = vectorInput()
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = withConnectorLock(expected.vaultId, () => gate, locks)
    await Promise.resolve()
    // Queue the operation, then mutate every caller-owned object while queued.
    const queued = preparePendingConnectorOperation(input, expected, storage, locks)
    await Promise.resolve()
    const originalRecipient = input.recipient
    const originalAmount = input.amountSats
    input.recipient = 'tb1qmutatedmutatedmutatedmutatedmutatedmutatedmu'
    input.amountSats = 1
    input.contract.vaultId = 'other-vault'
    expected.vaultId = 'other-vault'
    expected.enrollmentDigest = '00'.repeat(32)
    release()
    await holder
    const { record } = await queued
    // The stored operation reflects the pre-queue snapshot, not the mutations.
    expect(record.recipient).toBe(originalRecipient)
    expect(record.amountSats).toBe(originalAmount)
    expect(record.contract.vaultId).toBe('connector-family-fixture')
    expect(record.enrollmentDigest).toBe(vectors[0].enrollmentDigest)
    // Both the holder and the queued operation acquired the ORIGINAL vault
    // lock: mutating expected.vaultId while queued changed nothing.
    expect(locks.acquisitions).toEqual([
      connectorLockName('connector-family-fixture'),
      connectorLockName('connector-family-fixture'),
    ])
    expect(storage.getItem(connectorStoreKey('connector-family-fixture'))).not.toBeNull()
    expect(storage.getItem(connectorStoreKey('other-vault'))).toBeNull()
  })

  it('rejects stale callbacks after A-cancelled/B-prepared', async () => {
    const first = vectorInput(0, 0)
    const second = vectorInput(0, 1)
    expect(first.payment.finalTx).not.toBe(second.payment.finalTx)
    const storage = memoryStorage()
    const locks = new FakeLockManager()
    // Operation A is prepared and cancelled while still unsigned.
    const preparedA = await preparePendingConnectorOperation(first.input, first.expected, storage, locks)
    await cancelPendingConnectorOperation(first.expected, preparedA.candidateTxid, storage, locks)
    // Operation B (a different legitimate payment under the same enrollment)
    // is prepared in the same vault.
    const preparedB = await preparePendingConnectorOperation(second.input, second.expected, storage, locks)
    expect(preparedB.candidateTxid).not.toBe(preparedA.candidateTxid)
    // Stale A-identity callbacks must not touch B.
    await expect(
      markConnectorSignaturesMayHaveIssued(first.expected, preparedA.candidateTxid, storage, locks),
    ).rejects.toThrow(/stale/)
    await expect(
      cancelPendingConnectorOperation(first.expected, preparedA.candidateTxid, storage, locks),
    ).rejects.toThrow(/stale/)
    await expect(
      storeConnectorSavingsWitness(
        first.expected,
        preparedA.candidateTxid,
        first.payment.savingsWitness,
        storage,
        locks,
      ),
    ).rejects.toThrow(/stale/)
    await expect(
      storeConnectorSignedTx(first.expected, preparedA.candidateTxid, first.payment.finalTx, storage, locks),
    ).rejects.toThrow(/stale/)
    // B is intact and operable under its own identity.
    const loaded = await loadPendingConnectorOperation(second.expected, storage, locks)
    expect(loaded?.candidateTxid).toBe(preparedB.candidateTxid)
    await markConnectorSignaturesMayHaveIssued(second.expected, preparedB.candidateTxid, storage, locks)
    expect((await loadPendingConnectorOperation(second.expected, storage, locks))?.phase).toBe('signing')
  })

  it('rejects PSBT metadata tampering that leaves the unsigned transaction intact', async () => {
    const { input, expected } = vectorInput()
    const key = connectorStoreKey(expected.vaultId)
    const tampers: [string, (psbt: Transaction) => void][] = [
      ['sighash-type', (psbt) => psbt.updateInput(1, { sighashType: 1 })],
      ['savings-sighash-type', (psbt) => psbt.updateInput(0, { sighashType: 1 })],
    ]
    for (const [name, tamper] of tampers) {
      const storage = memoryStorage()
      const locks = new FakeLockManager()
      const { candidateTxid } = await preparePendingConnectorOperation(input, expected, storage, locks)
      const record = JSON.parse(storage.getItem(key)!) as Record<string, unknown>
      const parsed = Transaction.fromPSBT(hex.decode(record.candidatePsbt as string), OPTIONS)
      tamper(parsed)
      const tamperedPsbt = hex.encode(parsed.toPSBT())
      expect(tamperedPsbt).not.toBe(record.candidatePsbt)
      const check = Transaction.fromPSBT(hex.decode(tamperedPsbt), OPTIONS)
      expect(hex.encode(check.unsignedTx)).toBe(
        hex.encode(Transaction.fromPSBT(hex.decode(record.candidatePsbt as string), OPTIONS).unsignedTx),
      )
      record.candidatePsbt = tamperedPsbt
      storage.setItem(key, JSON.stringify(record))
      await expect(loadPendingConnectorOperation(expected, storage, locks), name).rejects.toThrow(/candidate mismatch/)
      await expect(
        markConnectorSignaturesMayHaveIssued(expected, candidateTxid, storage, locks),
        name,
      ).rejects.toThrow()
    }
  })
})
