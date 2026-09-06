import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultStatus } from '../types'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import vector from './testdata/renewal-set-v1.json'
import { loadSpendingRenewals, saveSpendingRenewals } from './renewalStore'
import { validateSpendingSchedule } from './renewalRequest'
import { refreshSpendingRenewals, clearSpendingRenewalReads } from './guardianRenewal'

const status = vector.status as VaultStatus
const enrollment = { vaultId: status.vaultId } as EnrollmentSecrets
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('navigator', {
    locks: { request: async (_name: string, _options: unknown, run: () => Promise<unknown>) => run() },
  })
  clearSpendingRenewalReads(status.vaultId)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function saved() {
  const journal = await loadSpendingRenewals(status)
  journal.sets[vector.set.setId] = structuredClone(vector.set)
  for (const p of vector.set.plans) {
    const request = {
      program: vector.set.program,
      descriptorHash: vector.set.descriptorHash,
      vaultId: vector.set.vaultId,
      ...p,
    }
    const f = validateSpendingSchedule(request, status)
    journal.operations[p.operationId] = {
      plan: {
        request,
        txid: f.txid,
        vout: f.vout,
        valueSats: f.valueSats,
        receiverSats: f.receiverSats,
        validAt: f.message.valid_at!,
        inputExpiresAt: p.expiresAt + 60,
      },
    }
  }
  await saveSpendingRenewals(status, journal)
  return journal
}
function response() {
  return {
    setId: vector.set.setId,
    operations: vector.set.plans.map((p) => {
      const f = validateSpendingSchedule(
        { program: vector.set.program, descriptorHash: vector.set.descriptorHash, vaultId: vector.set.vaultId, ...p },
        status,
      )
      return {
        version: 1,
        program: vector.set.program,
        descriptorHash: vector.set.descriptorHash,
        operationId: p.operationId,
        state: 'armed',
        validAt: f.message.valid_at,
        expiresAt: p.expiresAt,
        txid: f.txid,
        vout: f.vout,
        inputValueSats: f.valueSats,
        receiverSats: f.receiverSats,
      }
    }),
  }
}

describe('durable bounded renewal retries', () => {
  it('replays exact signed bytes after response loss with no fresh signing ceremony', async () => {
    await saved()
    const requests: unknown[] = []
    let lost = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toContain('/v1/vtxo/delegate/schedule')
        const body = JSON.parse(String(init.body))
        expect((await loadSpendingRenewals(status)).sets[body.setId]).toEqual(body)
        requests.push(body)
        if (lost) throw new Error('response lost')
        return Response.json(response())
      }),
    )
    const pending = await refreshSpendingRenewals(status, enrollment)
    expect(Object.keys(pending.sets)).toEqual([vector.set.setId])
    expect(pending.error).toContain('response lost')
    lost = false
    const complete = await refreshSpendingRenewals(status, enrollment)
    expect(complete.sets).toEqual({})
    expect(requests).toEqual([vector.set, vector.set])
    expect(Object.values(complete.operations).map((s) => s.status?.state)).toEqual(['armed', 'armed'])
  })
  it('retains all pending plans when one acknowledgement changes authority', async () => {
    await saved()
    const changed = response()
    changed.operations[1].receiverSats--
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(changed)),
    )
    const result = await refreshSpendingRenewals(status, enrollment)
    expect(Object.keys(result.sets)).toEqual([vector.set.setId])
    expect(Object.values(result.operations).every((s) => !s.status)).toBe(true)
    expect(result.error).toContain('different renewal')
  })
  it('rejects a changed saved signature before dispatch', async () => {
    const journal = await saved()
    journal.sets[vector.set.setId].ownerSignature = '00'.repeat(64)
    await expect(saveSpendingRenewals(status, journal)).rejects.toThrow()
  })
})
