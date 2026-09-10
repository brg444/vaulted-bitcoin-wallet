import { useEffect, useState } from 'react'
import {
  ARRIVAL_PREF_STORAGE_KEYS,
  adoptStoredArrivalPrefs,
  loadArrivalBanners,
  loadArrivalHaptics,
  subscribeArrivalPrefs,
  type ArrivalPrefKey,
} from '../lib/vault/prefs'

export interface NotificationPrefs {
  bannersEnabled: boolean
  arrivalHapticsEnabled: boolean
}

/**
 * Reactive device-local foreground notification preferences. Settings writes
 * through the prefs module; this hook reflects the current values and picks
 * up changes from other tabs. Detection and baseline logic consume these;
 * history, claiming, balances, signing, and recovery never see them.
 */
export function useNotificationPrefs(): NotificationPrefs {
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => ({
    bannersEnabled: loadArrivalBanners(),
    arrivalHapticsEnabled: loadArrivalHaptics(),
  }))

  useEffect(() => {
    const onBus = (key: ArrivalPrefKey, value: boolean) => {
      setPrefs((current) =>
        key === 'banners' ? { ...current, bannersEnabled: value } : { ...current, arrivalHapticsEnabled: value },
      )
    }
    const onStorage = (event: StorageEvent) => {
      // Cross-document sync follows actual preference changes only: events
      // for unrelated keys leave the session choice untouched, while a clear
      // (null key) re-reads whatever storage still holds.
      if (event.key !== null && !(ARRIVAL_PREF_STORAGE_KEYS as readonly string[]).includes(event.key)) return
      setPrefs(adoptStoredArrivalPrefs())
    }
    const unsubscribe = subscribeArrivalPrefs(onBus)
    window.addEventListener('storage', onStorage)
    return () => {
      unsubscribe()
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  return prefs
}
