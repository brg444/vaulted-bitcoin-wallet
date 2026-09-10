import QgGuidance from './qg/QgGuidance'
import { useContext, useState, type ReactNode } from 'react'
import { Fingerprint, FileKey, Server, ShieldCheck } from 'lucide-react'
import { formatMoney } from '../../lib/vault/fiatDisplay'
import { useBalanceDenomination } from './AccountBalance'
import { shortKey } from '../../lib/vault/setupPlan'
import { VaultContext } from '../../vault/context'
import { useVaultReadiness } from '../../vault/useVaultReadiness'
import { HubGroup, HubRow } from './ui'
import RecoveryExplanation from './qg/RecoveryExplanation'
import QgScreen from './qg/QgScreen'
import SecurityOverview from './SecurityOverview'
import ConnectorSetup from './ConnectorSetup'
import ConnectorDeposit from './ConnectorDeposit'
import { isConnectorTemplate } from '../../lib/vault/program/connector'

function SecurityTile({
  icon,
  label,
  value,
  detail,
  tone = 'paper',
  onClick,
  testId,
}: {
  icon: ReactNode
  label: string
  value: string
  detail?: string
  tone?: 'paper' | 'green' | 'orange'
  onClick?: () => void
  testId?: string
}) {
  const body = (
    <>
      <span className='vault-security-tile-icon' aria-hidden>
        {icon}
      </span>
      <span className='vault-security-tile-copy'>
        <span className='vault-security-tile-label'>{label}</span>
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </>
  )
  return onClick ? (
    <button type='button' className={`vault-security-tile is-${tone}`} onClick={onClick} data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className={`vault-security-tile is-${tone}`} data-testid={testId}>
      {body}
    </div>
  )
}

export default function VaultKeys() {
  const denomination = useBalanceDenomination()
  const money = (value: number) => formatMoney(value, denomination)
  const {
    busy,
    spendingRenewals,
    enablePasskeyLogin,
    hasLocalEnrollment,
    navigate,
    openRecover,
    savingsAddress,
    setup,
    spendingArkAddress,
    status,
  } = useContext(VaultContext)
  const [selectedView, setSelectedView] = useState<'overview' | 'keys' | 'limits' | 'renewal' | 'signer' | 'deposit'>(
    'overview',
  )
  const view =
    !isConnectorTemplate(status?.templateVersion) && (selectedView === 'signer' || selectedView === 'deposit')
      ? 'overview'
      : selectedView
  const phoneCovered = Boolean(status?.enrolled)
  const devicesCovered = Boolean(status?.passkeyLoginAvailable)
  const canEnableOther = hasLocalEnrollment && status?.enrolled && !status.passkeyLoginAvailable
  const hardwarePub = status?.externalOwnerWalletPub || setup.hardwarePub
  const recoveryPub = status?.recoveryPub || setup.recoveryPub
  const hasRecovery = Boolean(recoveryPub)
  const light = status?.protectionTier === 'light'
  const addressCovered = Boolean(spendingArkAddress && (light ? status.vtxoBoardingAddress : savingsAddress))
  const readiness = useVaultReadiness()
  const protectionTier = status?.protectionTier || setup.protectionTier
  const limit = status?.periodAllowance || setup.dailyLimitSats
  const perPayment = status?.txCap || setup.txCapSats
  const readinessLabel =
    readiness.state === 'checking'
      ? 'Checking…'
      : readiness.state === 'ready'
        ? 'Ready'
        : readiness.state === 'unavailable'
          ? 'Unavailable'
          : 'Can’t reach'
  const vaultReady = phoneCovered && addressCovered && readiness.state === 'ready'

  if (view === 'signer' && status && isConnectorTemplate(status.templateVersion))
    return (
      <ConnectorSetup
        status={status}
        onBack={() => setSelectedView('overview')}
        onDeposit={() => setSelectedView('deposit')}
      />
    )
  if (view === 'deposit' && status && isConnectorTemplate(status.templateVersion))
    return <ConnectorDeposit status={status} onBack={() => setSelectedView('signer')} />

  return (
    <QgScreen
      title={
        view === 'overview'
          ? 'Security'
          : view === 'keys'
            ? 'Keys and access'
            : view === 'limits'
              ? 'Spending limits'
              : 'Automatic renewal'
      }
      dismiss={view === 'overview' ? () => navigate('home') : undefined}
      back={view !== 'overview' ? () => setSelectedView('overview') : undefined}
    >
      {view === 'overview' ? (
        <SecurityOverview
          title={light ? 'Light wallet' : protectionTier === 'advanced' ? 'Advanced vault' : 'Standard vault'}
          description={
            light
              ? 'Passkey payments · watch-only Savings'
              : hasRecovery
                ? 'Passkey, hardware and recovery key'
                : 'Passkey + hardware wallet'
          }
          notice={!vaultReady ? 'Check keys and service access' : 'Vault service available'}
          attention={!vaultReady}
          access={{
            value: !phoneCovered ? 'Passkey needed' : devicesCovered ? 'Passkey available' : 'This device only',
            attention: !phoneCovered,
            onClick: () => setSelectedView('keys'),
          }}
          backup={{
            value: 'Review saved copies',
            attention: false,
            onClick: () => openRecover('kit', 'keys'),
            testId: 'security-kit',
          }}
          limits={{ value: `${money(perPayment)} each`, onClick: () => setSelectedView('limits') }}
          renewal={{
            value: spendingRenewals?.error
              ? 'Needs attention'
              : spendingRenewals?.available
                ? `${Object.values(spendingRenewals.operations).filter((operation) => operation.status?.state === 'armed' && operation.status.expiresAt * 1000 > Date.now()).length} scheduled`
                : 'Unavailable',
            attention: Boolean(spendingRenewals?.error),
            onClick: () => setSelectedView('renewal'),
            testId: 'security-readiness',
          }}
        >
          <HubGroup>
            {isConnectorTemplate(status?.templateVersion) ? (
              <HubRow title='Savings signer setup' onClick={() => setSelectedView('signer')} />
            ) : null}
            <HubRow
              title={light ? 'Recover Spending' : 'I lost a key'}
              onClick={() => openRecover('lost', 'keys')}
              testId='security-lost'
            />
          </HubGroup>
        </SecurityOverview>
      ) : view === 'keys' ? (
        <>
          <HubGroup label='Keys'>
            <HubRow
              icon={<Fingerprint />}
              title='Your passkey'
              status={!phoneCovered ? 'Needed' : devicesCovered ? 'Ready' : 'This device only'}
            />
            {!light ? (
              <HubRow
                icon={<ShieldCheck />}
                title='Hardware wallet'
                detail='Independent approval for Savings'
                status='Savings approval'
              />
            ) : null}
            {hasRecovery ? (
              <HubRow
                icon={<FileKey />}
                title='Recovery key'
                detail='Spending recovery if you lose your phone'
                status='Separate key'
              />
            ) : null}
          </HubGroup>
          {canEnableOther ? (
            <button type='button' className='qg-primary' disabled={busy} onClick={() => void enablePasskeyLogin()}>
              {busy ? 'Waiting for passkey…' : 'Use on another device'}
            </button>
          ) : null}
          {!light ? (
            <QgGuidance title='Key details'>
              <p>Hardware wallet: {shortKey(hardwarePub)}</p>
              {hasRecovery ? <p>Recovery key: {shortKey(recoveryPub)}</p> : null}
            </QgGuidance>
          ) : null}
          {light ? (
            <p className='qg-copy'>
              Keep a recovery package and access to your original passkey. Your saved device key can recover Spending
              and pending Bitcoin deposits after their waiting periods.
            </p>
          ) : (
            <RecoveryExplanation
              advanced={protectionTier === 'advanced'}
              mainnet={status?.network === 'mainnet'}
              templateVersion={status?.templateVersion}
            />
          )}
          {!addressCovered && status?.enrolled ? (
            <p className='qg-copy'>Vault addresses are not restored on this device. Sign in again to restore them.</p>
          ) : null}
        </>
      ) : view === 'limits' ? (
        <>
          <section className='qg-summary'>
            <div>
              <span>Per payment</span>
              <strong>{money(perPayment)}</strong>
            </div>
            <div>
              <span>Rolling 24 hours</span>
              <strong>{money(limit)}</strong>
            </div>
          </section>
          <p className='qg-copy'>
            These limits were fixed during setup. Each payment leaves the rolling allowance after 24 hours.
          </p>
        </>
      ) : (
        <>
          <SecurityTile
            icon={<Server />}
            label='Vault service'
            value={readinessLabel}
            detail='Enforces limits and assists recovery'
          />
          {spendingRenewals?.available ? (
            <SecurityTile
              icon={<Server />}
              label='Automatic renewal'
              value={
                spendingRenewals.error
                  ? 'Checking coverage'
                  : `${Object.values(spendingRenewals.operations).filter((operation) => operation.status?.state === 'armed' && operation.status.expiresAt * 1000 > Date.now()).length} scheduled`
              }
              detail='Guardian renews authorized Spending outputs while this wallet is closed.'
              testId='spending-renewal-status'
            />
          ) : (
            <p className='qg-copy'>
              Automatic renewal is unavailable for this wallet. Keep the app open to check the status of your Spending.
            </p>
          )}
        </>
      )}
    </QgScreen>
  )
}
