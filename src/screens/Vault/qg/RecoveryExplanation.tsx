import QgGuidance from './QgGuidance'
import { PROGRAM_CSV } from '../../../lib/vault/program/constants'
import './guidance.css'
import SavingsAvailability from './SavingsAvailability'

export default function RecoveryExplanation({
  advanced,
  mainnet = false,
  templateVersion,
}: {
  advanced: boolean
  mainnet?: boolean
  templateVersion?: string
}) {
  return (
    <QgGuidance title='Keys, waiting periods, and service availability'>
      <p>These paths recover Savings. Starting a new recovery requires approval from the recovery services.</p>
      <dl>
        <dt>Passkey access lost</dt>
        <dd>
          Use your hardware key. Wait {PROGRAM_CSV.hardware} blocks{mainnet ? ' (about an hour)' : ''}.
        </dd>
        <dt>Hardware key lost</dt>
        <dd>
          Use the wallet key unlocked by your passkey. Wait {PROGRAM_CSV.phone} blocks
          {mainnet ? ' (about a day)' : ''}.
        </dd>
        <dt>Both keys lost</dt>
        <dd>
          {advanced
            ? `Use your separately stored recovery key. Wait ${PROGRAM_CSV.recovery} blocks${mainnet ? ' (about two days)' : ''}.`
            : 'Standard has no separate key to recover Savings if both normal keys are lost.'}
        </dd>
      </dl>
      <p>The wait begins when the recovery transaction confirms on Bitcoin. Block times vary.</p>
      <p>
        Eligible remaining keys can cancel a pending recovery. The keys required depend on who started it and whether
        the recovery services are available.
      </p>
      <SavingsAvailability templateVersion={templateVersion} />
      <p>
        The app checks for recovery activity while open. Continuous monitoring and guaranteed notifications are
        unavailable.
      </p>
      <p>Spending and incoming deposits have separate recovery rules.</p>
    </QgGuidance>
  )
}
