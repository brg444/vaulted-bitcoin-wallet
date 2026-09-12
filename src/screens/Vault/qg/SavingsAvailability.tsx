import { LEDGER_NATIVE_TEMPLATE } from '../../../lib/vault/program/ledgerNativeKeys'

export default function SavingsAvailability({ templateVersion }: { templateVersion?: string }) {
  if (templateVersion !== LEDGER_NATIVE_TEMPLATE) return null
  return (
    <p>
      Your passkey and Ledger approve ordinary Savings payments without the Guardian. Starting delayed recovery needs a
      remaining user key and the Guardian. The Guardian cannot spend alone, but a compromised user key together with a
      compromised Guardian can bypass the recovery delay.
    </p>
  )
}
