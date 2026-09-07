import { describe, expect, it, vi } from 'vitest'
import { recoveryFixture } from '../recovery/testdata/helpers'
import { validateVaultRecoveryArchive, vaultArchiveProviders } from './recoveryArchive'

describe('Standard and Advanced complete Spending archives', () => {
  it.each([false, true])(
    'validates independently and supplies transactions during both service outages (advanced=%s)',
    async (advanced) => {
      for (const network of ['mainnet', 'mutinynet'] as const) {
        const { archive, tx } = recoveryFixture(advanced, network)
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('all services unavailable'))
        try {
          const imported = JSON.parse(JSON.stringify(archive))
          const local = vaultArchiveProviders(imported)
          expect(local.coins).toHaveLength(1)
          expect((await local.source.getVirtualTxs([tx.id])).size).toBe(1)
          expect(fetch).not.toHaveBeenCalled()
        } finally {
          fetch.mockRestore()
        }
      }
    },
  )
  it('rejects changed tier, network, recovery key, Operator and missing graph evidence', () => {
    const { archive } = recoveryFixture()
    for (const mutate of [
      (a: typeof archive) => {
        a.status.protectionTier = 'standard'
      },
      (a: typeof archive) => {
        a.status.network = 'mainnet'
      },
      (a: typeof archive) => {
        a.status.recoveryPub = a.status.phoneBip340Pub
      },
      (a: typeof archive) => {
        a.status.vtxoBoardingDescriptor!.operatorPub = a.status.phoneBip340Pub!
      },
      (a: typeof archive) => {
        a.spending.transactions = {}
      },
    ]) {
      const changed = JSON.parse(JSON.stringify(archive))
      mutate(changed)
      expect(() => validateVaultRecoveryArchive(changed)).toThrow()
    }
  })
})
