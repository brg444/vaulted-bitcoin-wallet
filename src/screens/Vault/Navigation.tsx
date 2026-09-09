import { Landmark, Settings, Shield, Wallet, X } from 'lucide-react'
import { useLauncherPosition } from './qg/useLauncherPosition'
import { useLauncherGlass } from './qg/useLauncherGlass'
import HollowPixelMark from '../../icons/HollowPixelMark'
import { formatMoney, type MoneyDenomination } from '../../lib/vault/fiatDisplay'
import { hapticLight, hapticSubtle } from '../../lib/haptics'
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { VaultContext, type VaultAccount, type VaultScreen } from '../../vault/context'

export type VaultDestination = 'wallet' | 'security' | 'settings'

export function destinationForScreen(screen: VaultScreen): VaultDestination | null {
  if (screen === 'home') return 'wallet'
  return null
}

const ACTIONS: { id: string; label: string; testId: string; icon: ReactNode; screen: VaultScreen }[] = [
  { id: 'security', label: 'Security', testId: 'tab-vault', icon: <Shield />, screen: 'keys' },
  { id: 'settings', label: 'Settings', testId: 'tab-settings', icon: <Settings />, screen: 'settings' },
]

const ACCOUNTS: { id: VaultAccount; label: string; testId: string; icon: ReactNode }[] = [
  { id: 'spend', label: 'Spending', testId: 'account-spend', icon: <Wallet /> },
  { id: 'savings', label: 'Savings', testId: 'account-savings', icon: <Landmark /> },
]

export default function VaultNavigation() {
  const { account, balancesLoaded, navigate, positions, setAccount, balanceUnit, fiatDisplayRate } =
    useContext(VaultContext)
  return (
    <VaultLauncher
      account={account}
      balances={{
        spending: balancesLoaded ? positions.spending.totalSats : null,
        savings: balancesLoaded ? positions.savings.totalSats : null,
      }}
      denomination={{ unit: balanceUnit ?? 'sats', rate: fiatDisplayRate ?? null }}
      onAccount={setAccount}
      actions={ACTIONS.map((action) => ({ ...action, onClick: () => navigate(action.screen) }))}
    />
  )
}

export function VaultLauncher({
  account,
  balances,
  denomination,
  onAccount,
  actions,
  disabled = false,
}: {
  disabled?: boolean
  account: VaultAccount
  balances: { spending: number | null; savings: number | null }
  denomination?: MoneyDenomination
  onAccount: (account: VaultAccount) => void
  actions: { id: string; label: string; testId: string; icon: ReactNode; onClick: () => void }[]
}) {
  const money: MoneyDenomination = denomination ?? { unit: 'sats', rate: null }
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [pull, setPull] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const restoreTriggerFocus = useRef(false)

  useEffect(() => {
    if (open || closing || !restoreTriggerFocus.current) return
    restoreTriggerFocus.current = false
    triggerRef.current?.focus()
  }, [open, closing])

  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => setClosing(false), 180)
    return () => window.clearTimeout(timer)
  }, [closing])

  useEffect(() => {
    if (!open && !closing) return
    const content = layerRef.current?.previousElementSibling as HTMLElement | null
    if (content) content.inert = true
    if (open) navRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true })
    return () => {
      if (content) content.inert = false
    }
  }, [open, closing])

  useEffect(() => {
    if (!open) return
    const collapse = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        restoreTriggerFocus.current = true
        setOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const buttons = navRef.current?.querySelectorAll<HTMLButtonElement>('button')
      if (!buttons?.length) return
      const next = event.shiftKey ? buttons[buttons.length - 1] : buttons[0]
      const edge = event.shiftKey ? buttons[0] : buttons[buttons.length - 1]
      if (document.activeElement === edge) {
        event.preventDefault()
        next.focus()
      }
    }
    window.addEventListener('keydown', collapse)
    return () => window.removeEventListener('keydown', collapse)
  }, [open])

  const close = () => {
    hapticSubtle()
    restoreTriggerFocus.current = true
    setPull(0)
    setClosing(!window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    setOpen(false)
  }

  const openLauncher = () => {
    hapticLight()
    setClosing(false)
    setPull(0)
    setOpen(true)
  }

  const select = (onClick: () => void) => {
    hapticLight()
    setOpen(false)
    onClick()
  }

  const chooseAccount = (next: VaultAccount) => {
    onAccount(next)
    close()
  }

  const placement = useLauncherPosition(layerRef, setPull, openLauncher)
  useLauncherGlass(layerRef)

  const progress = open ? 1 : pull
  const peeking = !open && pull > 0

  const closeButton = (
    <button
      type='button'
      className='qg-launcher-close vault-navigation-close'
      aria-label='Close navigation'
      onClick={close}
      tabIndex={open ? undefined : -1}
    >
      <X />
    </button>
  )

  const stack = (
    <nav
      ref={navRef}
      className='qg-launcher-stack'
      aria-label='Main navigation'
      id='vault-main-navigation'
      style={peeking ? { transform: `translateX(${Math.round((1 - progress) * 72)}px)` } : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      {placement.upper ? closeButton : null}
      {ACCOUNTS.map((item) => {
        const balance = item.id === 'spend' ? balances.spending : balances.savings
        const on = account === item.id
        return (
          <button
            key={item.id}
            type='button'
            className={on ? 'qg-launcher-item is-on' : 'qg-launcher-item'}
            onClick={() => chooseAccount(item.id)}
            disabled={disabled}
            aria-label={item.label}
            aria-pressed={on}
            data-testid={item.testId}
            tabIndex={open ? undefined : -1}
          >
            <span className='qg-launcher-copy'>
              <span className='qg-launcher-label'>{item.label}</span>
              <span className='qg-launcher-amt'>{balance !== null ? formatMoney(balance, money) : 'Loading…'}</span>
            </span>
            <span className='qg-launcher-icon' aria-hidden='true'>
              {item.icon}
            </span>
          </button>
        )
      })}
      {actions.map((action) => (
        <button
          key={action.id}
          type='button'
          className='qg-launcher-item'
          onClick={() => select(action.onClick)}
          disabled={disabled}
          aria-label={action.label}
          data-testid={action.testId}
          tabIndex={open ? undefined : -1}
        >
          <span className='qg-launcher-label'>{action.label}</span>
          <span className='qg-launcher-icon' aria-hidden='true'>
            {action.icon}
          </span>
        </button>
      ))}
      {placement.upper ? null : closeButton}
    </nav>
  )

  return (
    <div
      ref={layerRef}
      data-placement={placement.upper ? 'upper' : 'lower'}
      className={
        open
          ? 'qg-launcher is-open'
          : closing
            ? 'qg-launcher is-closing'
            : peeking
              ? 'qg-launcher is-peeking'
              : 'qg-launcher'
      }
    >
      {open || peeking || closing ? (
        <div
          className='qg-launcher-backdrop'
          aria-hidden={!open}
          onClick={open ? close : undefined}
          style={peeking ? { opacity: progress, pointerEvents: 'none' } : undefined}
        >
          {stack}
        </div>
      ) : null}
      {open || closing ? null : (
        <button
          ref={triggerRef}
          type='button'
          className={['qg-launcher-trigger vault-navigation-trigger', peeking ? 'is-pulling' : '']
            .filter(Boolean)
            .join(' ')}
          aria-label='Open navigation'
          aria-expanded={open}
          aria-controls='vault-main-navigation'
          style={peeking ? { transform: `translateX(${Math.round(-progress * 28)}px)` } : undefined}
          onPointerDown={placement.onPointerDown}
          onClick={placement.onClick}
          onKeyDown={placement.onKeyDown}
          aria-description='Drag up or down to reposition. Alt plus Arrow Up or Arrow Down also moves the tab.'
          onContextMenu={(event) => event.preventDefault()}
        >
          <span className='qg-launcher-mark' aria-hidden='true'>
            <HollowPixelMark />
          </span>
        </button>
      )}
    </div>
  )
}
