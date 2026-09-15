import { describe, expect, it } from 'vitest'
import { bytesToHex } from '../hex'
import vectors from './testdata/rolling-allowance-v1.json'
import { rollingAuthorizationDigest } from './authorization'

describe('rolling authorization digest', () => {
  it('matches the Go domain and binds the vault, full contract and transaction', () => {
    const { vaultId, operationId, digest } = vectors.authorization
    const compute = (vault = vaultId, script = vectors.scripts.pkScript, id = operationId) =>
      bytesToHex(rollingAuthorizationDigest(vault, script, id))
    expect(compute()).toBe(digest)
    expect(compute('other-vault')).not.toBe(digest)
    expect(compute(vaultId, `5120${'ab'.repeat(32)}`)).not.toBe(digest)
    expect(compute(vaultId, vectors.scripts.pkScript, 'ab'.repeat(32))).not.toBe(digest)
  })
})
