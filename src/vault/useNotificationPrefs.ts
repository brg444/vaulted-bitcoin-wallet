import { useEffect, useState } from 'react'
import { loadArrivalBanners, loadArrivalHaptics, subscribeArrivalPrefs, type ArrivalPrefKey } from '../lib/vault/prefs'

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
    const onStorage = () => {
      setPrefs({ bannersEnabled: loadArrivalBanners(), arrivalHapticsEnabled: loadArrivalHaptics() })
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
