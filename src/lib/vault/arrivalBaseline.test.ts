import { describe, expect, it } from 'vitest'
import { loadArrivalBaseline, saveArrivalBaseline } from './arrivalBaseline'

const SCOPE = { network: 'mutinynet', vaultId: 'vault-baseline' }

function memoryStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

describe('arrival baseline', () => {
  it('round-trips observed keys with their availability per scope', () => {
    const storage = memoryStorage()
    expect(loadArrivalBaseline(SCOPE, storage).size).toBe(0)
    saveArrivalBaseline(
      SCOPE,
      new Map([
        ['a', true],
        ['b', false],
      ]),
      undefined,
      storage,
    )
    saveArrivalBaseline(
      SCOPE,
      new Map([
        ['a', true],
        ['b', true],
        ['c', false],
      ]),
      undefined,
      storage,
    )
    expect(loadArrivalBaseline(SCOPE, storage)).toEqual(
      new Map([
        ['a', true],
        ['b', true],
        ['c', false],
      ]),
    )
    expect(loadArrivalBaseline({ network: 'mainnet', vaultId: 'vault-baseline' }, storage).size).toBe(0)
  })

  it('ignores corrupt entries and caps growth', () => {
    const storage = memoryStorage({ 'vaulted:payment-arrivals:mutinynet:vault-baseline': 'not-json' })
    expect(loadArrivalBaseline(SCOPE, storage).size).toBe(0)
    saveArrivalBaseline(
      SCOPE,
      new Map(Array.from({ length: 600 }, (_, index) => [`key-${index}`, index % 2 === 0] as [string, boolean])),
      undefined,
      storage,
    )
    const loaded = loadArrivalBaseline(SCOPE, storage)
    expect(loaded.size).toBe(500)
    expect(loaded.has('key-0')).toBe(false)
    expect(loaded.get('key-599')).toBe(false)
  })

  it('keeps visible history ahead of stale keys under the cap', () => {
    const storage = memoryStorage()
    const seen = new Map(Array.from({ length: 600 }, (_, index) => [`key-${index}`, true] as [string, boolean]))
    const current = new Set(['key-0', 'key-1', 'key-2', 'key-3', 'key-4'])
    saveArrivalBaseline(SCOPE, seen, current, storage)
    const loaded = loadArrivalBaseline(SCOPE, storage)
    expect(loaded.size).toBe(500)
    for (const key of current) expect(loaded.has(key)).toBe(true)
  })

  it('survives unavailable storage without throwing', () => {
    const failing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadArrivalBaseline(SCOPE, failing).size).toBe(0)
    expect(() => saveArrivalBaseline(SCOPE, new Map([['a', true]]), undefined, failing)).not.toThrow()
  })
})
