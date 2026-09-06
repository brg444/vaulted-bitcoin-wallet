import { useContext, type ReactNode } from 'react'
import { Fingerprint, FileKey, Server, ShieldCheck } from 'lucide-react'
import { prettyAmount } from '../../lib/format'
import { shortKey } from '../../lib/vault/setupPlan'
import { VaultContext } from '../../vault/context'
import { useVaultReadiness } from '../../vault/useVaultReadiness'
import { HubGroup, HubRow } from './ui'
import RecoveryExplanation from './qg/RecoveryExplanation'
import { useBackupConfirmation } from './qg/useBackupConfirmation'
import QgScreen from './qg/QgScreen'

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
  const {
    busy,
    spendingRenewals,
    enablePasskeyLogin,
    hasLocalEnrollment,
    hasRecoveryKit,
    navigate,
    openRecover,
    savingsAddress,
    setup,
    spendingArkAddress,
    status,
  } = useContext(VaultContext)
  const { confirmed } = useBackupConfirmation()
  const phoneCovered = Boolean(status?.enrolled)
  const devicesCovered = Boolean(status?.passkeyLoginAvailable)
  const canEnableOther = hasLocalEnrollment && status?.enrolled && !status.passkeyLoginAvailable
  const hardwarePub = status?.externalOwnerWalletPub || setup.hardwarePub
  const recoveryPub = status?.recoveryPub || setup.recoveryPub
  const hasRecovery = Boolean(recoveryPub)
  const addressCovered = Boolean(savingsAddress && spendingArkAddress)
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

  return (
    <QgScreen title='Security' dismiss={() => navigate('home')}>
      <div className='vault-security'>
        <section className='vault-security-hero' aria-label='Vault protection status'>
          <div className='vault-security-hero-head'>
            <strong>Vault protection</strong>
            <span className={vaultReady ? 'is-ready' : 'is-attention'}>{vaultReady ? 'Ready' : 'Review'}</span>
          </div>
          <h2>{vaultReady ? 'Your vault is available.' : 'Review your vault.'}</h2>
          <p>
            {vaultReady
              ? 'Spending uses your registered limits, and Savings transfers require your passkey and hardware wallet. Check your backup and recovery options below.'
              : 'One or more safeguards needs attention. Check device access, wallet addresses, and service readiness.'}
          </p>
        </section>

        <div className='vault-security-grid'>
          <SecurityTile
            icon={<Fingerprint />}
            label='Protection tier'
            value={protectionTier === 'advanced' ? 'Advanced' : 'Standard'}
            detail={
              protectionTier === 'advanced'
                ? 'Separate key for delayed Savings recovery'
                : 'Savings recovery with one remaining key'
            }
          />
          <SecurityTile
            icon={<FileKey />}
            label='Recovery Kit'
            value={confirmed ? 'Copy confirmed' : hasRecoveryKit ? 'On this device' : 'Review'}
            detail={
              confirmed
                ? 'You confirmed a separate kit copy'
                : hasRecoveryKit
                  ? 'Save a copy outside this device'
                  : 'Retrieve your vault map'
            }
            onClick={() => openRecover('kit', 'keys')}
            testId='security-kit'
          />
          <SecurityTile
            icon={<ShieldCheck />}
            label='Spending limits'
            value={`${prettyAmount(perPayment)} each`}
            detail={`${prettyAmount(limit)} / rolling 24 hours`}
          />
          <SecurityTile
            icon={<Server />}
            label='Vault service'
            value={readinessLabel}
            detail='Enforces limits and assists recovery'
            testId='security-readiness'
          />
        </div>

        <div className='vault-security-groups'>
          <HubGroup label='Keys'>
            <HubRow
              icon={<Fingerprint />}
              title='Your passkey'
              status={!phoneCovered ? 'Needed' : devicesCovered ? 'Ready' : 'This device only'}
              onClick={
                canEnableOther
                  ? () => {
                      if (!busy) void enablePasskeyLogin()
                    }
                  : undefined
              }
            />
            <HubRow
              icon={<ShieldCheck />}
              title='Hardware wallet'
              detail='Independent approval for Savings'
              status={shortKey(hardwarePub)}
            />
            {hasRecovery ? (
              <HubRow
                icon={<FileKey />}
                title='Recovery key'
                detail='Separate key for delayed Savings recovery'
                status={shortKey(recoveryPub)}
              />
            ) : null}
          </HubGroup>

          <RecoveryExplanation advanced={protectionTier === 'advanced'} mainnet={status?.network === 'mainnet'} />
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
              tone={spendingRenewals.error ? 'orange' : 'green'}
              testId='spending-renewal-status'
            />
          ) : null}
          <HubGroup label='Recovery and access'>
            <HubRow title='I lost a key' onClick={() => openRecover('lost', 'keys')} testId='security-lost' />
            {canEnableOther ? (
              <HubRow
                title={busy ? 'Waiting for passkey…' : 'Use on another device'}
                onClick={() => {
                  if (!busy) void enablePasskeyLogin()
                }}
              />
            ) : null}
          </HubGroup>
        </div>

        {!addressCovered && status?.enrolled ? (
          <p className='qg-copy'>Vault addresses are not restored on this device. Sign in again to restore them.</p>
        ) : null}
      </div>
    </QgScreen>
  )
}
