import { useState } from 'react'
import { parseRecoveryKit, type RecoveryKit } from '../../lib/vault/program/kit'
import type { ProtectionTier } from '../../lib/vault/protectionTier'
import type { Claimant } from '../../lib/vault/program/constants'
import RecoveryExplanation from './qg/RecoveryExplanation'
import QgScreen, { QgSecondary } from './qg/QgScreen'

type Scenario = 'passkey' | 'hardware' | 'both' | 'service'
const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: 'passkey', label: 'I can’t use my passkey' },
  { id: 'hardware', label: 'I can’t use my hardware wallet' },
  { id: 'both', label: 'Both keys are unavailable' },
  { id: 'service', label: 'The service is unavailable' },
]

// Viewing a kit here never enrolls, restores, unlocks, or changes a wallet.
export default function RecoveryHelp({
  onBack,
  onDismiss,
  protectionTier,
  mainnet = false,
  onPrepare,
}: {
  onBack?: () => void
  onDismiss?: () => void
  protectionTier?: ProtectionTier
  mainnet?: boolean
  onPrepare?: (claimant: Claimant) => void
}) {
  const [scenario, setScenario] = useState<Scenario | null>(null)
  const [kit, setKit] = useState<RecoveryKit | null>(null)
  const [fileError, setFileError] = useState('')
  const [reading, setReading] = useState(false)
  const tier = protectionTier || kit?.protectionTier
  const isMainnet = kit ? kit.descriptor.network === 'mainnet' : mainnet
  const claimant: Claimant | null =
    scenario === 'passkey'
      ? 'hardware'
      : scenario === 'hardware'
        ? 'phone'
        : scenario === 'both' && tier === 'advanced'
          ? 'recovery'
          : null

  return (
    <QgScreen
      help={false}
      title={scenario ? SCENARIOS.find((item) => item.id === scenario)?.label : 'Access and recovery'}
      back={scenario ? () => setScenario(null) : onBack}
      dismiss={scenario ? undefined : onDismiss}
    >
      {!scenario ? (
        <>
          <p className='qg-eyebrow'>Find your next step</p>
          <h1>What do you still have access to?</h1>
          <p className='qg-copy'>
            Keep any working device, key backups, and your Recovery Kit. Avoid clearing app data while you work out how
            to regain access.
          </p>
          <div className='qg-choice-list is-keys qg-help-choices' role='radiogroup' aria-label='Access problem'>
            {SCENARIOS.map(({ id, label }) => (
              <button
                key={id}
                type='button'
                role='radio'
                aria-checked={scenario === id}
                onClick={() => setScenario(id)}
              >
                <span>
                  <strong>{label}</strong>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
      {scenario ? (
        <section className='qg-guidance-body qg-backup-status' aria-label='Recovery guidance' aria-live='polite'>
          {scenario === 'passkey' ? (
            <>
              <h2>Check passkey access first</h2>
              <p>
                Try the original device and the passkey provider you used during setup. Your browser may offer another
                device or a saved passkey; availability depends on that provider and the required unlock support.
              </p>
              <p>
                If passkey access cannot be restored, your hardware key can start delayed Savings recovery with approval
                from both recovery services. You also need the Recovery Kit and compatible signing software.
              </p>
            </>
          ) : scenario === 'hardware' ? (
            <>
              <h2>Check your hardware backup</h2>
              <p>
                If you have a hardware wallet backup, follow its maker’s instructions to restore the same key on a
                compatible device. Keep seed words and private keys out of this app.
              </p>
              <p>
                If that key cannot be restored, working passkey access can unlock the wallet key for delayed Savings
                recovery. Starting it also needs both recovery services and your Recovery Kit.
              </p>
            </>
          ) : scenario === 'both' ? (
            <>
              <h2>Your protection choice matters</h2>
              <p>
                {tier === 'standard'
                  ? 'This kit uses Standard protection. If neither normal key can be restored, there is no separate key that can recover Savings.'
                  : tier === 'advanced'
                    ? 'Advanced provides a delayed Savings path using the separate recovery key chosen during setup. You still need that key, your Recovery Kit, compatible signing software, and approval from both recovery services.'
                    : 'Advanced can provide a path with the separate recovery key chosen during setup. Standard has no separate key for this situation. Check your saved Recovery Kit to identify your setup.'}
              </p>
              <p>
                A Recovery Kit contains public vault information. It cannot replace a missing private key or a lost
                passkey.
              </p>
            </>
          ) : (
            <>
              <h2>Keep keys and saved recovery data</h2>
              <p>
                Both normal keys can approve an ordinary Savings transfer without the recovery services, using
                compatible signing software. Starting a new delayed recovery requires both services.
              </p>
              <p>
                If a recovery transaction is already confirmed, its initiating key can claim after the Bitcoin waiting
                period without the services. Check the confirmed transaction and which key started it before taking
                action.
              </p>
              <p>
                Spending and incoming deposits use different recovery paths and may require saved transaction data. A
                Savings Recovery Kit alone does not guarantee their recovery.
              </p>
            </>
          )}
          {claimant && onPrepare && tier ? (
            <QgSecondary label='Review recovery preparation' onClick={() => onPrepare(claimant)} />
          ) : null}
        </section>
      ) : null}
      {scenario && !protectionTier ? (
        <details className='qg-guidance'>
          <summary>Check a saved Recovery Kit</summary>
          <div className='qg-guidance-body'>
            <p>
              Choose the public JSON kit you saved for this vault. This check reads the file on this device; it does not
              restore access or prove that you control the keys.
            </p>
            <label className='qg-field'>
              <span>Recovery Kit file</span>
              <input
                type='file'
                accept='.json,application/json'
                disabled={reading}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  setKit(null)
                  setFileError('')
                  if (file.size > 1024 * 1024) {
                    setFileError('That file is too large. Choose a Recovery Kit JSON file smaller than 1 MB.')
                    return
                  }
                  setReading(true)
                  void file
                    .text()
                    .then((text) => setKit(parseRecoveryKit(JSON.parse(text))))
                    .catch(() =>
                      setFileError(
                        'This file could not be read as a supported Recovery Kit. Choose the original JSON file.',
                      ),
                    )
                    .finally(() => setReading(false))
                }}
              />
            </label>
            {reading ? <p role='status'>Reading kit…</p> : null}
            {fileError ? <p role='alert'>{fileError}</p> : null}
            {kit ? (
              <p role='status'>
                {kit.protectionTier === 'advanced' ? 'Advanced' : 'Standard'} · Vault{' '}
                {kit.descriptor.vaultId.slice(0, 8)}… · {kit.descriptor.network}. This describes the selected file; it
                has not been matched to an account.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
      {tier ? <RecoveryExplanation advanced={tier === 'advanced'} mainnet={isMainnet} /> : null}
      <details className='qg-guidance'>
        <summary>What happens during Savings recovery?</summary>
        <div className='qg-guidance-body'>
          <ol>
            <li>Prepare the recovery transaction using your vault’s kit and the key you still control.</li>
            <li>Sign with that key, obtain both recovery service approvals, and submit the transaction to Bitcoin.</li>
            <li>
              After Bitcoin confirms it, wait for the required number of blocks. Eligible remaining keys can cancel
              during this period.
            </li>
            <li>
              Once the wait is complete, use the initiating key to sign and send a separate transfer to your chosen
              Bitcoin address.
            </li>
          </ol>
          <p>
            The app can prepare these transactions, but preparation alone does not sign or send them. You need
            compatible signing software to finish the external steps.
          </p>
          <p>
            There is no continuous recovery monitoring. Check this app while open, and review any recovery you did not
            start.
          </p>
        </div>
      </details>
    </QgScreen>
  )
}
