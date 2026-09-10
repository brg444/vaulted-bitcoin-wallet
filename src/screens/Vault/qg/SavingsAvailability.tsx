import { LEDGER_NATIVE_TEMPLATE } from '../../../lib/vault/program/ledgerNativeKeys'
import { isConnectorTemplate } from '../../../lib/vault/program/connector'
import { isSavingsTemplate } from '../../../lib/vault/program/constants'

export default function SavingsAvailability({ templateVersion }: { templateVersion?: string }) {
  return (
    <p>
      {templateVersion === LEDGER_NATIVE_TEMPLATE
        ? 'Your passkey and Ledger approve ordinary Savings payments without the Guardian. Starting delayed recovery needs a remaining user key and the Guardian. The Guardian cannot spend alone, but a compromised user key together with a compromised Guardian can bypass the recovery delay.'
        : templateVersion && isConnectorTemplate(templateVersion)
          ? 'Connector Savings needs service approvals and your hardware signature. A saved payment can finish if its service approvals were retained. A new payment or delayed recovery needs the services.'
          : templateVersion && isSavingsTemplate(templateVersion)
            ? 'Both normal keys can approve an ordinary Savings transfer without the recovery services, using compatible signing software. Starting a new delayed recovery requires both services.'
            : 'Savings service requirements depend on the enrolled program. Open your Recovery Kit to identify it. Starting a new delayed Savings recovery requires both recovery services.'}
    </p>
  )
}
