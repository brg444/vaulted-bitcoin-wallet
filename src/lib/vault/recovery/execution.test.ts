import { describe, expect, it, vi } from 'vitest'
import type { ExecutorEvent, ExitPackage } from '@arkade-os/sdk'
import { requireConfirmedRecovery } from './execution'
describe('Recovery completion', () => {
  async function* events(rows: ExecutorEvent[]) {
    yield* rows
  }
  it('accepts only a confirmed sweep for the exact prepared transaction', async () => {
    const file = { exitPackage: { steps: [{ kind: 'sweep', txid: 'cd'.repeat(32) }] } as ExitPackage }
    await expect(
      requireConfirmedRecovery(
        file.exitPackage!,
        events([{ stepIndex: 0, kind: 'sweep', status: 'confirmed', txid: 'cd'.repeat(32) }]),
        () => {},
      ),
    ).resolves.toBeUndefined()
  })
  it.each(['failed', 'broadcast', 'skipped', 'waiting_csv'] as const)(
    'does not call %s complete when the iterator ends',
    async (status) => {
      const file = { exitPackage: { steps: [{ kind: 'sweep', txid: 'cd'.repeat(32) }] } as ExitPackage }
      const event: ExecutorEvent = { stepIndex: 0, kind: 'sweep', status, txid: 'cd'.repeat(32) }
      const observed = vi.fn()
      await expect(requireConfirmedRecovery(file.exitPackage!, events([event]), observed)).rejects.toThrow('incomplete')
      expect(observed).toHaveBeenCalledWith(event)
    },
  )
  it('rejects missing or unrelated confirmations and a partially failed exit', async () => {
    const file = { exitPackage: { steps: [{ kind: 'sweep', txid: 'cd'.repeat(32) }] } as ExitPackage }
    for (const rows of [
      [],
      [{ stepIndex: 0, kind: 'sweep', status: 'confirmed', txid: 'ef'.repeat(32) }],
      [
        { stepIndex: 1, kind: 'bump', status: 'failed' },
        { stepIndex: 0, kind: 'sweep', status: 'confirmed', txid: 'cd'.repeat(32) },
      ],
    ] as ExecutorEvent[][]) {
      await expect(requireConfirmedRecovery(file.exitPackage!, events(rows), () => {})).rejects.toThrow('incomplete')
    }
  })
})
