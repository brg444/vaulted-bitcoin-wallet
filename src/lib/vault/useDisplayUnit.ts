import { useCallback, useEffect, useRef, useState } from 'react'
import { getPriceFeed } from '../fiat'
import { Fiats } from '../types'
import type { VaultBalanceUnit, VaultFiatDisplayRate } from './fiatDisplay'
import { loadVaultBalanceUnit, saveVaultBalanceUnit } from './prefs'

/** Same-tab broadcast so every mounted consumer stays on one denomination. */
export const VAULT_BALANCE_UNIT_EVENT = 'vault-balance-unit'

export type VaultRateStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

export function readDisplayUnit(): VaultBalanceUnit {
  try {
    return loadVaultBalanceUnit()
  } catch {
    return 'sats'
  }
}

export function broadcastDisplayUnit(unit: VaultBalanceUnit) {
  try {
    window.dispatchEvent(new CustomEvent<VaultBalanceUnit>(VAULT_BALANCE_UNIT_EVENT, { detail: unit }))
  } catch {
    // Unit switching still works when event dispatch is unavailable.
  }
}

let inflightRate: Promise<VaultFiatDisplayRate | null> | null = null

export async function loadUsdDisplayRate(): Promise<VaultFiatDisplayRate | null> {
  if (!inflightRate) {
    inflightRate = (async () => {
      let prices: Awaited<ReturnType<typeof getPriceFeed>>
      try {
        prices = await getPriceFeed({ silent: true })
      } catch {
        return null
      }
      if (prices && Number.isFinite(prices.usd) && Number(prices.usd) > 0) {
        return { currency: Fiats.USD, pricePerBtc: Number(prices.usd) }
      }
      return null
    })().finally(() => {
      inflightRate = null
    })
  }
  return inflightRate
}

function eventUnit(event: Event): VaultBalanceUnit | null {
  const detail = (event as CustomEvent<VaultBalanceUnit>).detail
  return detail === 'usd' || detail === 'sats' ? detail : null
}

/**
 * One persistent sats/USD preference shared by every wallet surface.
 * Payment arithmetic stays in canonical satoshis; only display converts.
 * A unit change never erases the saved preference when the rate is
 * unavailable — callers fall back to sats rendering instead.
 */
export function useDisplayUnit(options?: {
  rate?: VaultFiatDisplayRate | null
  ensureRate?: () => Promise<VaultFiatDisplayRate | null>
  clearRate?: () => void | Promise<void>
}): {
  unit: VaultBalanceUnit
  rate: VaultFiatDisplayRate | null
  rateStatus: VaultRateStatus
  setUnit: (unit: VaultBalanceUnit) => Promise<VaultFiatDisplayRate | null>
} {
  const [unitState, setUnitState] = useState<VaultBalanceUnit>(readDisplayUnit)
  const unit = unitState
  const [internalRate, setInternalRate] = useState<VaultFiatDisplayRate | null>(null)
  const [rateStatus, setRateStatus] = useState<VaultRateStatus>('idle')
  const loading = useRef(false)
  const generation = useRef(0)
  const settledFor = useRef<VaultBalanceUnit | null>(null)
  const unitRef = useRef(unit)
  unitRef.current = unit
  const externalRate = options?.rate !== undefined
  const rate = externalRate ? (options?.rate ?? null) : internalRate
  const source = useRef(options)
  source.current = options

  const ensure = useCallback(async () => {
    try {
      if (source.current?.ensureRate) return await source.current.ensureRate()
    } catch {
      return null
    }
    const next = await loadUsdDisplayRate()
    if (!externalRate) setInternalRate(next)
    return next
  }, [externalRate])

  const loadForUnit = useCallback(
    async (wanted: VaultBalanceUnit) => {
      const gen = ++generation.current
      loading.current = true
      setRateStatus('loading')
      let loaded: VaultFiatDisplayRate | null = null
      try {
        loaded = await ensure()
      } catch {
        loaded = null
      }
      if (generation.current !== gen) {
        // A newer unit change owns this state. Undo a late external rate so
        // fiat state cannot come back after it was cleared.
        if (unitRef.current === 'sats') {
          try {
            await source.current?.clearRate?.()
          } catch {
            // Clearing is best-effort; status stays owned by the newer change.
          }
        }
        return loaded
      }
      loading.current = false
      settledFor.current = wanted
      if (unitRef.current !== wanted) return loaded
      setRateStatus(loaded ? 'ready' : 'unavailable')
      return loaded
    },
    [ensure],
  )

  const setUnit = useCallback(
    async (next: VaultBalanceUnit) => {
      try {
        saveVaultBalanceUnit(next)
      } catch {
        // Display switching remains available when storage is disabled.
      }
      setUnitState(next)
      broadcastDisplayUnit(next)
      if (next === 'sats') {
        generation.current += 1
        loading.current = false
        setRateStatus('idle')
        if (!externalRate) setInternalRate(null)
        try {
          await source.current?.clearRate?.()
        } catch {
          // Clearing is best-effort; the sats preference is already saved.
        }
        return null
      }
      return loadForUnit(next)
    },
    [externalRate, loadForUnit],
  )

  useEffect(() => {
    const applySync = async (next: VaultBalanceUnit) => {
      setUnitState((prev) => (prev === next ? prev : next))
      if (next === 'sats') {
        if (!externalRate) setInternalRate(null)
        setRateStatus('idle')
        try {
          await source.current?.clearRate?.()
        } catch {
          // Clearing is best-effort; the sats preference is already saved.
        }
      } else {
        // A fresh usd selection retries a previously unavailable rate.
        settledFor.current = null
        setRateStatus((prev) => (prev === 'unavailable' ? 'idle' : prev))
      }
    }
    const sync = () => {
      void applySync(readDisplayUnit())
    }
    const onBroadcast = (event: Event) => {
      const next = eventUnit(event)
      if (next) void applySync(next)
    }
    window.addEventListener('storage', sync)
    window.addEventListener(VAULT_BALANCE_UNIT_EVENT, onBroadcast)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(VAULT_BALANCE_UNIT_EVENT, onBroadcast)
    }
  }, [])

  // Mounted consumers that did not initiate the change still acquire a rate.
  useEffect(() => {
    if (unit !== 'usd' || rate || rateStatus === 'loading' || rateStatus === 'ready') return
    if (settledFor.current === unit) return
    void loadForUnit('usd')
  }, [unit, rate, rateStatus, loadForUnit])

  useEffect(() => {
    if (!externalRate || loading.current) return
    if (unit === 'sats') {
      if (rateStatus !== 'idle') setRateStatus('idle')
      return
    }
    if (rate && rateStatus !== 'ready') setRateStatus('ready')
  }, [externalRate, rate, rateStatus, unit])

  return { unit, rate, rateStatus, setUnit }
}
