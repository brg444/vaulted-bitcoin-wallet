import { afterEach, expect, it } from 'vitest'
import { vaultLatency } from './latency'

afterEach(() => {
  vaultLatency.reset()
  vaultLatency.setEnabled(true)
})

it('records async span durations and preserves the resolved value', async () => {
  const value = await vaultLatency.measure('review', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return 'ok'
  })
  expect(value).toBe('ok')
  const samples = vaultLatency.samplesFor('review')
  expect(samples).toHaveLength(1)
  expect(samples[0].ms).toBeGreaterThanOrEqual(0)
})

it('records a duration even when the measured work rejects', async () => {
  await expect(
    vaultLatency.measure('submit', async () => {
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
  expect(vaultLatency.samplesFor('submit')).toHaveLength(1)
})

it('counts named phases independently of durations', () => {
  vaultLatency.count('review')
  vaultLatency.count('review')
  vaultLatency.count('retirement', 3)
  expect(vaultLatency.counters()).toMatchObject({ review: 2, retirement: 3 })
})

it('summarizes p50 and p95 over recorded samples', () => {
  for (const ms of [10, 20, 30, 40, 100]) vaultLatency.record('quote', ms)
  const summary = vaultLatency.summary().find((entry) => entry.phase === 'quote')!
  expect(summary.count).toBe(5)
  expect(summary.p50).toBe(30)
  expect(summary.p95).toBe(100)
  expect(summary.max).toBe(100)
})

it('closes a manual span only once', () => {
  const end = vaultLatency.span('passkey')
  end()
  end()
  expect(vaultLatency.samplesFor('passkey')).toHaveLength(1)
})

it('drops samples and counters when disabled', () => {
  vaultLatency.setEnabled(false)
  vaultLatency.record('receipt', 5)
  vaultLatency.count('receipt')
  expect(vaultLatency.samplesFor('receipt')).toHaveLength(0)
  expect(vaultLatency.counters()).toEqual({})
})
