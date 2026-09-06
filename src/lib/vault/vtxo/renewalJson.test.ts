import { hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import type { VaultStatus } from '../types'
import vectors from './testdata/renewal-context-v1.json'
import setVector from './testdata/renewal-set-v1.json'
import expected from './testdata/renewal-opaque-go-digests.json'
import { guardianRenewalContextDigest } from './renewalContext'
import { spendingDelegationDigest, spendingScheduleBody, type SpendingScheduleRequest } from './renewalRequest'
import { spendingRenewalSetDigest, type SpendingRenewalSet } from './renewalSet'

// Expected hashes were generated with Go encoding/json.Marshal and crypto/sha256.
// Existing plan signatures are payload here; this checks serialization, not renewed authorization.
describe('opaque renewal identity Go signing parity', () => {
  const vaultId = 'vault<>&\u2028\u2029é'
  const status = { ...vectors[1].status, vaultId } as VaultStatus
  const descriptorHash = expected['vaulted-vtxo/renewal-context/v1']
  const set = { ...setVector.set, vaultId, descriptorHash } as SpendingRenewalSet

  it('matches the context digest without changing the enrolled ID', () => {
    expect(guardianRenewalContextDigest(status)).toBe(descriptorHash)
  })

  it('matches ordered per-plan and complete-set digests', () => {
    const request = {
      program: set.program,
      descriptorHash,
      vaultId,
      ...set.plans[0],
    } as SpendingScheduleRequest
    expect(hex.encode(spendingDelegationDigest('schedule', spendingScheduleBody(request)))).toBe(
      expected['vaulted-vtxo/delegate-schedule/v1'],
    )
    expect(hex.encode(spendingRenewalSetDigest(set))).toBe(expected['vaulted-vtxo/delegate-schedule-set/v1'])
  })

  it.each(['status', 'cancel', 'list'] as const)('matches the %s read authorization digest', (purpose) => {
    const body = {
      program: set.program,
      descriptorHash,
      vaultId,
      ...(purpose === 'list' ? { afterOperationId: '' } : { operationId: set.plans[0].operationId }),
      expiresAt: 1788739200,
    }
    expect(hex.encode(spendingDelegationDigest(purpose, body))).toBe(expected[`vaulted-vtxo/delegate-${purpose}/v1`])
  })
})
