import { useContext, useEffect, useRef, useState } from 'react'
import SpinnerIcon from '../../icons/Spinner'
import { hapticSubtle } from '../../lib/haptics'
import { sleep } from '../../lib/sleep'
import { reloadIfNewerWallet } from '../../lib/vault/update'
import { VaultContext } from '../../vault/context'

const THRESHOLD = 104

export default function VaultRefresher({ onRefresh }: { onRefresh?: () => Promise<void> } = {}) {
  const context = useContext(VaultContext)
  const refreshBalance = onRefresh || context.refreshBalance
  const indicator = useRef<HTMLDivElement>(null)
  const [distance, setDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const running = useRef(false)

  useEffect(() => {
    const container = indicator.current?.closest<HTMLElement>('.content')
    if (!container) return
    let active = false
    let startX = 0
    let startY = 0
    let travel = 0
    let mounted = true

    const reset = () => {
      active = false
      travel = 0
      setDistance(0)
    }
    const run = async () => {
      if (running.current) return
      running.current = true
      setRefreshing(true)
      hapticSubtle()
      try {
        const updating = await reloadIfNewerWallet()
        if (!updating) await refreshBalance()
      } finally {
        await sleep(320)
        running.current = false
        if (mounted) setRefreshing(false)
      }
    }
    const onTouchStart = (event: TouchEvent) => {
      reset()
      const target = event.target as Element
      if (
        running.current ||
        container.scrollTop > 0 ||
        event.touches.length !== 1 ||
        target.closest('button, a, input, textarea, select, [role="button"]')
      )
        return
      active = true
      startX = event.touches[0].clientX
      startY = event.touches[0].clientY
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!active) return
      if (event.touches.length !== 1 || container.scrollTop > 0) return reset()
      const dx = event.touches[0].clientX - startX
      const dy = event.touches[0].clientY - startY
      if (dy < -12 || (Math.abs(dx) > 12 && Math.abs(dx) > dy)) return reset()
      travel = Math.max(0, dy)
      if (travel <= 16) return
      if (event.cancelable) event.preventDefault()
      setDistance(Math.min(travel * 0.5, 64))
    }
    const onTouchEnd = () => {
      const committed = active && travel >= THRESHOLD
      reset()
      if (committed) void run().catch(() => {})
    }
    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd)
    container.addEventListener('touchcancel', reset)
    return () => {
      mounted = false
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', reset)
    }
  }, [refreshBalance])

  return (
    <div
      ref={indicator}
      className={`pull-to-refresh vault-refresh${refreshing ? ' is-refreshing' : ''}`}
      style={{ height: refreshing ? 52 : distance, opacity: refreshing ? 1 : Math.min(distance / 52, 1) }}
      role='status'
      aria-label={refreshing ? 'Refreshing balance' : undefined}
      aria-hidden={!refreshing}
    >
      <SpinnerIcon />
    </div>
  )
}
