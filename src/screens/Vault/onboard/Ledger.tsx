import { useSession } from '../../../vault/sessionContext'
import { useEffect, useState } from 'react'
import { useVaultInteraction, useVaultNavigation } from '../../../vault/appContexts'
import LedgerSavingsApproval from '../LedgerSavingsApproval'
import WalletScreen from '../qg/WalletScreen'
import { QgPrimary } from '../qg/QgScreen'
import QgGuidance from '../qg/QgGuidance'

export function LedgerHardware() {
  const { connectLedgerKey, ledgerAvailable } = useSession()
  const { busy, error } = useVaultInteraction()
  const { navigate } = useVaultNavigation()
  const supported = globalThis.isSecureContext && typeof navigator !== 'undefined' && 'hid' in navigator
  return (
    <WalletScreen
      title='Ledger'
      stepLabel='2 of 6'
      back={() => navigate('design')}
      footer={
        <QgPrimary
          label={busy ? 'Check your Ledger…' : 'Connect Ledger'}
          disabled={busy || !supported || !ledgerAvailable}
          onClick={() => void connectLedgerKey('hardware')}
        />
      }
    >
      <h1>Protect Savings with Ledger</h1>
      <p className='qg-copy'>
        Connect your Ledger and open the Bitcoin app. Vaulted reads its public account; your keys stay on the device.
      </p>
      <p className='qg-copy'>
        After creating your passkey, you’ll register one Savings policy and verify the receiving address on Ledger.
        Payments then show the recipient, amount and fee for your approval.
      </p>
      <QgGuidance title='Keep your seed backup and recovery package'>
        <p>
          Emergency Spending recovery uses your Ledger seed backup in the recovery tool on an offline computer. Ledger’s
          ordinary Bitcoin app cannot sign that exit.
        </p>
        <p>
          The offline computer can access every account under that seed. Use the seed only for an emergency, then move
          remaining funds to a new seed.
        </p>
      </QgGuidance>
      {!ledgerAvailable ? <p role='status'>Ledger Savings setup is unavailable on this deployment.</p> : null}
      {!supported ? <p role='status'>Set up Ledger in a supported desktop browser with USB device access.</p> : null}
      {error ? <p role='alert'>{error}</p> : null}
    </WalletScreen>
  )
}

export function LedgerRecoveryKey() {
  const { connectLedgerKey, applyLedgerRecovery } = useSession()
  const { busy, error } = useVaultInteraction()
  const { navigate } = useVaultNavigation()
  const [value, setValue] = useState('')
  const supported = globalThis.isSecureContext && typeof navigator !== 'undefined' && 'hid' in navigator
  return (
    <WalletScreen
      title='Recovery wallet'
      stepLabel='3 of 6'
      back={() => navigate('hardware')}
      footer={
        <QgPrimary
          label='Use this recovery account'
          disabled={busy || !value.trim()}
          onClick={() => applyLedgerRecovery(value)}
        />
      }
    >
      <h1>Add an independent recovery wallet</h1>
      <p className='qg-copy'>
        Use another wallet with a separate seed backup. It can start Savings recovery with the Guardian if both normal
        keys are lost.
      </p>
      <button
        type='button'
        className='qg-secondary'
        disabled={busy || !supported}
        onClick={() => void connectLedgerKey('recovery')}
      >
        {busy ? 'Check the recovery Ledger…' : 'Connect another Ledger'}
      </button>
      <QgGuidance title='Use a public account from another Ledger'>
        <p>
          Import the Ledger’s public BIP86 account origin, including fingerprint, derivation path and xpub. Keep the
          seed and any seed passphrase offline.
        </p>
        <label className='qg-field'>
          <span>Public recovery account</span>
          <textarea
            aria-label='Public recovery account'
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder='[fingerprint/86h/0h/0h]xpub…'
          />
        </label>
      </QgGuidance>
      <p className='qg-copy'>
        Emergency Spending exit requires both wallet seed backups in the offline recovery tool. Savings recovery retains
        its separate Guardian and waiting-period requirements.
      </p>
      {error ? <p role='alert'>{error}</p> : null}
    </WalletScreen>
  )
}

export function LedgerEnrollmentRegistration() {
  const { approveLedgerEnrollment, cancelLedgerRegistration, ledgerApprovalPhase, enroll, pendingLedgerSetup } =
    useSession()
  useEffect(() => cancelLedgerRegistration, [cancelLedgerRegistration])
  const { navigate } = useVaultNavigation()
  const { busy, error } = useVaultInteraction()
  if (!pendingLedgerSetup)
    return (
      <WalletScreen title='Set up Ledger' back={() => navigate('hardware')}>
        <p>Start Savings setup before registering the Ledger policy.</p>
      </WalletScreen>
    )
  if (pendingLedgerSetup.registered)
    return (
      <WalletScreen
        title='Complete setup'
        back={() => navigate('plan')}
        footer={<QgPrimary label='Complete setup' disabled={busy} onClick={() => void enroll()} />}
      >
        <p>Your Ledger approval is saved. Complete the existing setup to open your wallet.</p>
        {error ? <p role='alert'>{error}</p> : null}
      </WalletScreen>
    )
  return (
    <LedgerSavingsApproval
      mode='register'
      busy={busy}
      phase={ledgerApprovalPhase}
      error={error}
      onApprove={approveLedgerEnrollment}
      onBack={() => navigate('plan')}
    />
  )
}
