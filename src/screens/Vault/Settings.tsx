import { useContext, useEffect, useState } from 'react'
import { useToast } from '../../components/Toast'
import { gitCommit } from '../../_gitCommit'
import { copyToClipboard } from '../../lib/clipboard'
import { prettyAgo, prettyAmount, prettyLongText } from '../../lib/format'
import { hapticLight, hapticSubtle } from '../../lib/haptics'
import { clearLogs, getLogs, type LogLine } from '../../lib/logs'
import { Themes } from '../../lib/types'
import {
  loadVaultHaptics,
  loadVaultPrivacyLock,
  loadVaultTheme,
  resolveVaultTheme,
  saveVaultHaptics,
  saveVaultPrivacyLock,
  saveVaultTheme,
  systemTheme,
} from '../../lib/vault/prefs'
import { setSessionLocked } from '../../lib/vault/enrollmentStore'
import { reloadIfNewerWallet } from '../../lib/vault/update'
import type { VaultStatus } from '../../lib/vault/types'
import { VaultContext } from '../../vault/context'
import { useVaultReadiness } from '../../vault/useVaultReadiness'
import { HubGroup, HubRow } from './ui'
import QgScreen, { QgCheck, QgPrimary } from './qg/QgScreen'

type View = 'menu' | 'theme' | 'about' | 'haptics' | 'logs' | 'reset' | 'diagnostics'

const THEME_OPTIONS: { value: Themes; testId: string; label: (theme: Themes) => string }[] = [
  { value: Themes.Auto, testId: 'select-option-0', label: () => `Auto (${systemTheme()})` },
  { value: Themes.Dark, testId: 'select-option-1', label: () => 'Dark' },
  { value: Themes.Light, testId: 'select-option-2', label: () => 'Light' },
]

function SettingsRow({
  label,
  value,
  onClick,
  danger,
  testId,
}: {
  label: string
  value?: string
  onClick: () => void
  danger?: boolean
  testId?: string
}) {
  return (
    <HubRow
      title={label}
      status={value}
      danger={danger}
      testId={testId}
      onClick={() => {
        hapticSubtle()
        onClick()
      }}
    />
  )
}

function LogsView({ onBack }: { onBack: () => void }) {
  const { toast } = useToast()
  const [logs, setLogs] = useState<LogLine[]>(() => getLogs())

  return (
    <QgScreen
      title='Logs'
      back={onBack}
      aux={<span>Clear</span>}
      auxAriaLabel='Clear'
      auxOnClick={() => {
        clearLogs()
        setLogs([])
      }}
    >
      {logs.length === 0 ? (
        <p className='qg-copy'>No logs yet. They appear as you use this vault.</p>
      ) : (
        <HubGroup>
          {[...logs].reverse().map((line) => (
            <HubRow
              key={`${line.time}${line.msg}${line.level}`}
              title={Date.now() - new Date(line.time).getTime() < 60_000 ? 'Just now' : prettyAgo(line.time)}
              detail={prettyLongText(line.msg.replace('...', ''), 12)}
              danger={line.level === 'error'}
              chevron={false}
              onClick={() => {
                void copyToClipboard(line.msg)
                toast('Copied to clipboard')
              }}
            />
          ))}
        </HubGroup>
      )}
    </QgScreen>
  )
}

function ResetView({ onBack, onReset }: { onBack: () => void; onReset: () => void }) {
  const [ok, setOk] = useState(false)
  return (
    <QgScreen title='Sign out' back={onBack} footer={<QgPrimary onClick={onReset} disabled={!ok} label='Sign out' />}>
      <div className='vault-security'>
        <section className='vault-security-hero' aria-label='Sign out of this browser'>
          <div className='vault-security-hero-head'>
            <strong>This browser</strong>
          </div>
          <h2>Sign out of this browser.</h2>
          <p>
            Coins stay on the vault. Sign in again with your passkey. This does not close the vault or delete the
            passkey.
          </p>
        </section>
        <label className='qg-consent'>
          <input
            type='checkbox'
            data-testid='checkbox'
            checked={ok}
            onChange={(event) => setOk(event.target.checked)}
          />
          <span>I understand</span>
        </label>
      </div>
    </QgScreen>
  )
}

export default function VaultSettings({
  light,
}: {
  light?: {
    status: VaultStatus | null
    busy: boolean
    onClose: () => void
    refresh: () => Promise<void>
    lock: () => void
  }
} = {}) {
  const context = useContext(VaultContext)
  const { reset, setup } = context
  const status = light ? light.status : context.status
  const busy = light ? light.busy : context.busy
  const liveNetwork = light ? status?.network === 'mutinynet' : context.liveNetwork
  const balanceError = light ? '' : context.balanceError
  const refreshingBalance = light ? light.busy : context.refreshingBalance
  const refreshBalance = light ? light.refresh : context.refreshBalance
  const close = light ? light.onClose : () => context.navigate('home')
  const readiness = useVaultReadiness()
  const { toast } = useToast()
  const [view, setView] = useState<View>('menu')
  const [theme, setTheme] = useState(loadVaultTheme)
  const [haptics, setHaptics] = useState(loadVaultHaptics)
  const [privacyLock, setPrivacyLock] = useState(loadVaultPrivacyLock)
  const [checkingUpdate, setCheckingUpdate] = useState(false)

  useEffect(() => {
    if (view !== 'menu') return
    setTheme(loadVaultTheme())
    setHaptics(loadVaultHaptics())
    setPrivacyLock(loadVaultPrivacyLock())
  }, [view])

  if (view === 'theme') {
    return (
      <QgScreen title='Theme' back={() => setView('menu')}>
        <div className='vault-section'>
          <p className='vault-section-label'>Appearance</p>
          <div className='vault-hub' role='radiogroup' aria-label='Theme'>
            {THEME_OPTIONS.map((option) => {
              const selected = theme === option.value
              return (
                <button
                  key={option.value}
                  type='button'
                  role='radio'
                  aria-checked={selected}
                  className={selected ? 'vault-hub-row is-on' : 'vault-hub-row'}
                  data-testid={option.testId}
                  onClick={() => {
                    hapticSubtle()
                    setTheme(option.value)
                    saveVaultTheme(option.value)
                  }}
                >
                  <div className='vault-hub-copy'>
                    <p>{option.label(option.value)}</p>
                  </div>
                  {selected ? (
                    <span className='qg-account-option-check' aria-hidden>
                      <QgCheck />
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
      </QgScreen>
    )
  }

  if (view === 'haptics') {
    return (
      <QgScreen title='Haptics' back={() => setView('menu')}>
        <HubGroup label='This device'>
          <button
            type='button'
            role='switch'
            aria-checked={haptics}
            className='vault-hub-row'
            onClick={() => {
              const next = !haptics
              setHaptics(next)
              saveVaultHaptics(next)
              if (next) hapticLight()
            }}
          >
            <div className='vault-hub-copy'>
              <p>Haptic feedback</p>
              <p>Vibration on taps</p>
            </div>
            <span className={haptics ? 'qg-switch is-on' : 'qg-switch'} aria-hidden />
          </button>
        </HubGroup>
      </QgScreen>
    )
  }

  if (view === 'about') {
    const tier = status?.protectionTier || setup.protectionTier
    const readinessLabel =
      readiness.state === 'checking'
        ? 'Checking…'
        : readiness.state === 'ready'
          ? 'Ready'
          : readiness.state === 'unavailable'
            ? 'Unavailable'
            : 'Can’t reach'
    const rows: [string, string | undefined][] = [
      [
        'Network',
        status?.network === 'mainnet'
          ? 'Bitcoin'
          : status?.network === 'mutinynet' || liveNetwork
            ? 'Mutinynet'
            : 'Unavailable',
      ],
      ['App revision', gitCommit],
      ['Vault', status?.vaultId],
      ['Enrolled template', status?.templateVersion],
      ['Policy version', status?.policyVersion],
      [
        'Protection tier',
        light
          ? 'Light — passkey payments'
          : tier === 'advanced'
            ? 'Advanced — separate recovery key'
            : 'Standard — no separate recovery key',
      ],
      ['Per-payment limit', prettyAmount(status?.txCap || setup.txCapSats)],
      ['Rolling allowance', prettyAmount(status?.periodAllowance || setup.dailyLimitSats)],
      ['Vault service', readinessLabel],
      ['Site', status?.clientOrigin || location.origin],
      ['RP ID', status?.rpId],
    ]
    return (
      <QgScreen title='About' back={() => setView('menu')}>
        <HubGroup label='This vault'>
          {rows.map(([title, value]) =>
            value ? (
              <HubRow
                key={title}
                title={title}
                status={value}
                chevron={false}
                onClick={() => {
                  void copyToClipboard(value)
                  toast('Copied to clipboard')
                }}
              />
            ) : null,
          )}
        </HubGroup>
      </QgScreen>
    )
  }

  if (view === 'diagnostics')
    return (
      <QgScreen title='Diagnostics' back={() => setView('menu')}>
        {' '}
        <HubGroup label='Advanced'>
          <SettingsRow
            label={checkingUpdate ? 'Checking…' : 'Check for update'}
            testId='settings-update'
            onClick={() => {
              if (checkingUpdate) return
              setCheckingUpdate(true)
              void reloadIfNewerWallet()
                .then((reloaded) => {
                  if (!reloaded) toast('You’re up to date')
                })
                .finally(() => setCheckingUpdate(false))
            }}
          />
          <SettingsRow
            label={refreshingBalance || busy ? 'Checking…' : 'Refresh balance'}
            testId='settings-refresh'
            value={balanceError ? 'Failed' : undefined}
            onClick={() => {
              if (refreshingBalance) return
              void refreshBalance()
            }}
          />
          <SettingsRow label='Logs' testId='settings-logs' onClick={() => setView('logs')} />
        </HubGroup>
      </QgScreen>
    )

  if (view === 'logs') return <LogsView onBack={() => setView('diagnostics')} />
  if (view === 'reset') return <ResetView onBack={() => setView('menu')} onReset={reset} />

  return (
    <QgScreen title='Settings' dismiss={close}>
      <div className='vault-security'>
        <HubGroup label='General'>
          <SettingsRow
            label='Theme'
            testId='settings-theme'
            value={theme === Themes.Auto ? `Auto (${resolveVaultTheme(Themes.Auto)})` : theme}
            onClick={() => setView('theme')}
          />
          <SettingsRow
            label='Haptics'
            testId='settings-haptics'
            value={haptics ? 'On' : 'Off'}
            onClick={() => setView('haptics')}
          />
          <SettingsRow label='About' testId='settings-about' onClick={() => setView('about')} />
        </HubGroup>

        <HubGroup>
          <SettingsRow label='Diagnostics' testId='settings-diagnostics' onClick={() => setView('diagnostics')} />
        </HubGroup>

        <HubGroup label='This browser'>
          {light ? (
            <SettingsRow label='Lock wallet' testId='settings-lock' onClick={light.lock} />
          ) : (
            <>
              <button
                type='button'
                role='switch'
                aria-checked={privacyLock}
                className='vault-hub-row'
                data-testid='settings-privacy-lock'
                onClick={() => {
                  const next = !privacyLock
                  setPrivacyLock(next)
                  saveVaultPrivacyLock(next)
                  setSessionLocked(next)
                  if (next) hapticLight()
                }}
              >
                <div className='vault-hub-copy'>
                  <p>Require passkey to open</p>
                  <p>Hide balances until this device approves</p>
                </div>
                <span className={privacyLock ? 'qg-switch is-on' : 'qg-switch'} aria-hidden />
              </button>
              <SettingsRow label='Sign out' testId='settings-signout' danger onClick={() => setView('reset')} />
            </>
          )}
        </HubGroup>
      </div>
    </QgScreen>
  )
}
