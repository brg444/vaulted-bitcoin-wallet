import { useContext, useEffect, useLayoutEffect, useRef, type PointerEvent, type ReactNode } from 'react'
import { VaultContext } from '../../../vault/context'
import WalletHelp from './Help'
import { ArrowLeft } from 'lucide-react'
import { hapticLight } from '../../../lib/haptics'
import { animateScreenEntrance } from './useScreenMotion'

function revealFocusedField(main: HTMLElement, target: HTMLElement) {
  const field = (target.closest('.qg-dest-field, .qg-amount-entry') as HTMLElement | null) || target
  const viewport = main.getBoundingClientRect()
  const bounds = field.getBoundingClientRect()
  const margin = 12
  const delta =
    bounds.bottom > viewport.bottom - margin
      ? bounds.bottom - viewport.bottom + margin
      : bounds.top < viewport.top + margin
        ? bounds.top - viewport.top - margin
        : 0
  if (!delta) return
  if (typeof main.scrollBy === 'function') main.scrollBy({ top: delta, behavior: 'smooth' })
  else main.scrollTop += delta
}

export function QgMark({ className = 'qg-mark' }: { className?: string }) {
  return (
    <span className={className} aria-hidden='true'>
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

export function QgCheck() {
  return (
    <svg viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        d='M5 12.5 9.5 17 19 7.5'
        stroke='currentColor'
        strokeWidth='1.8'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  )
}

export function QgPrimary({
  label,
  onClick,
  disabled,
  loading,
  icon,
  testId,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  icon?: ReactNode
  testId?: string
}) {
  return (
    <button
      type='button'
      className='qg-primary'
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-testid={testId}
      onClick={() => {
        if (disabled || loading) return
        hapticLight()
        onClick()
      }}
    >
      {loading ? <span className='qg-spinner-inline' aria-hidden='true' /> : icon}
      {label}
    </button>
  )
}

export function QgSecondary({
  label,
  onClick,
  disabled,
  testId,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type='button'
      className='qg-secondary'
      disabled={disabled}
      data-testid={testId}
      onClick={() => {
        if (disabled) return
        hapticLight()
        onClick()
      }}
    >
      {label}
    </button>
  )
}

export function QgTextButton({
  label,
  onClick,
  testId,
  disabled,
  icon,
}: {
  label: string
  onClick: () => void
  testId?: string
  disabled?: boolean
  icon?: ReactNode
}) {
  return (
    <button
      type='button'
      className='qg-text'
      data-testid={testId}
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        hapticLight()
        onClick()
      }}
    >
      {label}
      {icon ? <span aria-hidden='true'>{icon}</span> : null}
    </button>
  )
}

const DISMISS_DISTANCE = 88
const LOCK_DISTANCE = 12

export default function QgScreen({
  help = true,
  variant = 'flow',
  brand,
  title,
  stepLabel,
  back,
  backAriaLabel = 'Go back',
  close,
  dismiss,
  aux,
  auxAriaLabel,
  auxOnClick,
  children,
  footer,
}: {
  help?: boolean
  variant?: 'welcome' | 'flow' | 'progress' | 'success' | 'scan' | 'unlock'
  brand?: boolean
  title?: string
  stepLabel?: string
  back?: () => void
  backAriaLabel?: string
  close?: () => void
  dismiss?: () => void
  aux?: ReactNode
  auxAriaLabel?: string
  auxOnClick?: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const { setup } = useContext(VaultContext)
  const advanced = setup?.protectionTier === 'advanced'
  const numberedStep = stepLabel?.match(/^(\d) of 6$/)
  const displayedStep = numberedStep
    ? `${Number(numberedStep[1]) - (!advanced && Number(numberedStep[1]) > 3 ? 1 : 0)} of ${advanced ? 7 : 6}`
    : stepLabel === 'Backup'
      ? `${advanced ? 7 : 6} of ${advanced ? 7 : 6}`
      : stepLabel
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const focusFrameRef = useRef(0)
  const focusGenerationRef = useRef(0)
  const previousTitle = useRef(title)
  const drag = useRef({ id: -1, startY: 0, startX: 0, dy: 0, active: false, locked: false, suppressClick: false })
  const sheet = Boolean(dismiss && !back && !close)
  const activate = (fn?: () => void) => () => {
    hapticLight()
    fn?.()
  }

  useLayoutEffect(() => {
    if (previousTitle.current === title) return
    previousTitle.current = title
    return animateScreenEntrance(mainRef.current, 'translateY(8px)')
  }, [title])

  useEffect(() => {
    const heading = rootRef.current?.querySelector('h1, [data-testid="screen-title"]') as HTMLElement | null
    if (!heading) return
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }, [title, variant])

  useEffect(() => {
    if (!sheet) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return
      hapticLight()
      dismiss?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheet, dismiss])

  useEffect(() => {
    const ensureFocusedFieldVisible = () => {
      const main = mainRef.current
      const target = document.activeElement
      if (!main || !(target instanceof HTMLElement) || !main.contains(target)) return
      if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') return
      const generation = focusGenerationRef.current
      if (focusFrameRef.current) window.cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = 0
        if (generation !== focusGenerationRef.current || document.activeElement !== target || !target.isConnected) {
          return
        }
        revealFocusedField(main, target)
      })
    }
    window.visualViewport?.addEventListener('resize', ensureFocusedFieldVisible)
    return () => {
      focusGenerationRef.current += 1
      if (focusFrameRef.current) window.cancelAnimationFrame(focusFrameRef.current)
      window.visualViewport?.removeEventListener('resize', ensureFocusedFieldVisible)
    }
  }, [])

  useEffect(() => {
    if (!sheet) return
    const node = rootRef.current
    if (!node) return
    const onTouchMove = (event: TouchEvent) => {
      if (drag.current.locked) event.preventDefault()
    }
    node.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => node.removeEventListener('touchmove', onTouchMove)
  }, [sheet])

  const resetSheet = () => {
    const node = rootRef.current
    if (!node) return
    node.style.transform = ''
    node.style.transition = ''
  }

  const canStartDismiss = (event: PointerEvent<HTMLElement>) => {
    const header = headerRef.current
    const target = event.target as Element
    return Boolean(header?.contains(target) && !target.closest('button, input, a, textarea, select'))
  }

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!sheet || event.button !== 0 || event.isPrimary === false) return
    drag.current.suppressClick = false
    if (!canStartDismiss(event)) return
    drag.current = {
      id: event.pointerId,
      startY: event.clientY,
      startX: event.clientX,
      dy: 0,
      active: true,
      locked: false,
      suppressClick: false,
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current.active || drag.current.id !== event.pointerId) return
    const dy = event.clientY - drag.current.startY
    const dx = event.clientX - drag.current.startX
    if (!drag.current.locked) {
      if (dy < -LOCK_DISTANCE || (Math.abs(dx) > LOCK_DISTANCE && Math.abs(dx) > dy)) {
        drag.current.active = false
        drag.current.suppressClick = true
        return
      }
      if (dy < LOCK_DISTANCE) return
      drag.current.locked = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    const travel = Math.max(0, dy)
    drag.current.dy = travel
    const node = rootRef.current
    if (!node) return
    node.style.transition = 'none'
    node.style.transform = `translateY(${travel * 0.7}px)`
  }

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (drag.current.id !== event.pointerId) return
    if (!drag.current.active) return
    const dy = drag.current.dy
    const locked = drag.current.locked
    drag.current.active = false
    drag.current.locked = false
    drag.current.suppressClick = locked
    if (locked && dy >= DISMISS_DISTANCE) {
      hapticLight()
      resetSheet()
      dismiss?.()
      return
    }
    drag.current.locked = false
    const node = rootRef.current
    if (!node) return
    node.style.transition = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'none'
      : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)'
    node.style.transform = 'translateY(0)'
  }

  const onPointerCancel = () => {
    drag.current.active = false
    drag.current.locked = false
    drag.current.suppressClick = true
    drag.current.dy = 0
    resetSheet()
  }

  return (
    <div
      ref={rootRef}
      className={`qg-screen qg-screen-${variant}${sheet ? ' is-sheet' : ''}`}
      onPointerDown={sheet ? onPointerDown : undefined}
      onPointerMove={sheet ? onPointerMove : undefined}
      onPointerUp={sheet ? onPointerUp : undefined}
      onPointerCancel={sheet ? onPointerCancel : undefined}
      onClickCapture={(event) => {
        if (!drag.current.suppressClick) return
        event.preventDefault()
        event.stopPropagation()
        drag.current.suppressClick = false
      }}
    >
      {brand ? (
        <header className='qg-brand'>
          <QgMark />
          <strong>Vaulted</strong>
          {help ? <WalletHelp /> : null}
          <small>{import.meta.env.VITE_VAULT_RELEASE_NETWORK === 'mainnet' ? 'BITCOIN' : 'MUTINYNET'}</small>
        </header>
      ) : variant === 'progress' || variant === 'success' || variant === 'unlock' ? (
        help ? (
          <div className='qg-corner-help'>
            <WalletHelp />
          </div>
        ) : null
      ) : (
        <header ref={headerRef} className={sheet ? 'qg-header qg-header-sheet' : 'qg-header'}>
          {sheet ? (
            <button
              type='button'
              aria-label={backAriaLabel}
              data-testid='header-back'
              onClick={() => {
                if (drag.current.locked || drag.current.dy >= DISMISS_DISTANCE) return
                activate(dismiss)()
              }}
            >
              <ArrowLeft />
            </button>
          ) : back || close ? (
            <button
              type='button'
              aria-label={close ? 'Return home' : backAriaLabel}
              data-testid={close ? 'header-close' : 'header-back'}
              onClick={activate(back || close)}
            >
              {close ? <span aria-hidden='true'>×</span> : <ArrowLeft />}
            </button>
          ) : (
            <span />
          )}
          {title ? <h2 data-testid='screen-title'>{title}</h2> : <span />}
          {help ? <WalletHelp /> : null}
          {sheet ? (
            <span className='qg-handle' aria-hidden='true' />
          ) : aux ? (
            <button
              type='button'
              className='qg-header-aux'
              aria-label={auxAriaLabel}
              data-testid='header-aux-btn'
              disabled={!auxOnClick}
              onClick={activate(auxOnClick)}
            >
              {aux}
            </button>
          ) : stepLabel ? (
            <small>{displayedStep}</small>
          ) : !help ? (
            <span />
          ) : null}
        </header>
      )}
      <main
        ref={mainRef}
        className='qg-main'
        onFocus={(event) => {
          const target = event.target
          if (!(target instanceof HTMLElement)) return
          if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') return
          const generation = ++focusGenerationRef.current
          if (focusFrameRef.current) window.cancelAnimationFrame(focusFrameRef.current)
          focusFrameRef.current = window.requestAnimationFrame(() => {
            focusFrameRef.current = 0
            if (generation !== focusGenerationRef.current || document.activeElement !== target || !target.isConnected) {
              return
            }
            const main = mainRef.current
            if (main) revealFocusedField(main, target)
          })
        }}
        onBlur={() => {
          focusGenerationRef.current += 1
          if (focusFrameRef.current) window.cancelAnimationFrame(focusFrameRef.current)
          focusFrameRef.current = 0
        }}
      >
        {children}
      </main>
      {footer ? <footer className='qg-footer'>{footer}</footer> : null}
    </div>
  )
}
