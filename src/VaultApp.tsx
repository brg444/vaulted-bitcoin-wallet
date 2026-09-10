import { spendingScreens } from './screens/Vault/SpendingScreens'
import VaultLedgerPayment from './screens/Vault/LedgerPayment'
import { useContext, useEffect, useRef } from 'react'
import { VaultContext } from './vault/context'
import './screens/Vault/vault.css'
import './screens/Vault/vault-system.css'
import './screens/Vault/quiet-guardian-flows.css'
import './screens/Vault/qg/layout.css'
import './screens/Vault/quiet-guardian-screens.css'
import VaultHandoff from './screens/Vault/Handoff'
import VaultWelcome from './screens/Vault/Welcome'
import VaultUnlock from './screens/Vault/Unlock'
import VaultKeys from './screens/Vault/Keys'
import VaultSettings from './screens/Vault/Settings'
import VaultConditions from './screens/Vault/onboard/Conditions'
import VaultCreated from './screens/Vault/onboard/Created'
import VaultCreating from './screens/Vault/onboard/Creating'
import VaultDesign from './screens/Vault/onboard/Design'
import VaultHardware from './screens/Vault/onboard/Hardware'
import { LedgerHardware, LedgerRecoveryKey, LedgerEnrollmentRegistration } from './screens/Vault/onboard/Ledger'
import VaultKit from './screens/Vault/onboard/Kit'
import VaultPasskey from './screens/Vault/onboard/Passkey'
import VaultPlan from './screens/Vault/onboard/Plan'
import VaultProblem from './screens/Vault/onboard/Problem'
import VaultReady from './screens/Vault/onboard/Ready'
import VaultRecovery from './screens/Vault/onboard/Recovery'
import VaultRecover from './screens/Vault/Recover'
import VaultSignIn from './screens/Vault/onboard/SignIn'
import VaultNavigation, { destinationForScreen } from './screens/Vault/Navigation'
import { bootVaultPrefs } from './lib/vault/prefs'
import { bootVaultFrame } from './lib/vault/pwaFrame'
import { reloadIfNewerWallet } from './lib/vault/update'
import { useIntentPress } from './screens/Vault/qg/useIntentPress'
import { useScreenMotion } from './screens/Vault/qg/useScreenMotion'

export default function VaultApp() {
  const { screen, account, ledgerAvailable, setup } = useContext(VaultContext)
  const root = useRef<HTMLDivElement>(null)
  const scope = `${screen}:${account}`
  const intentPress = useIntentPress(scope)
  useScreenMotion(root, scope)
  useEffect(() => {
    document.title = 'Vaulted, a Bitcoin wallet'
    bootVaultPrefs()
    void reloadIfNewerWallet()
    return bootVaultFrame()
  }, [])
  const launcher = destinationForScreen(screen)
  const pages = {
    ...spendingScreens,
    welcome: <VaultWelcome />,
    unlock: <VaultUnlock />,
    handoff: <VaultHandoff />,
    'ledger-sign': <VaultLedgerPayment />,
    design: <VaultDesign />,
    hardware: ledgerAvailable ? <LedgerHardware /> : <VaultHardware />,
    'ledger-register': <LedgerEnrollmentRegistration />,
    recovery: setup.ledger ? <LedgerRecoveryKey /> : <VaultRecovery />,
    recover: <VaultRecover />,
    conditions: <VaultConditions />,
    plan: <VaultPlan />,
    passkey: <VaultPasskey />,
    creating: <VaultCreating />,
    created: <VaultCreated />,
    kit: <VaultKit />,
    ready: <VaultReady />,
    problem: <VaultProblem />,
    keys: <VaultKeys />,
    settings: <VaultSettings />,
    signin: <VaultSignIn />,
  }
  const page = pages[screen] || <VaultWelcome />
  const className = ['page', `vault-screen-${screen}`, launcher ? 'has-vault-navigation' : ''].filter(Boolean).join(' ')
  return (
    <div ref={root} className={className} data-testid='vault-app' {...intentPress}>
      {page}
      {launcher ? <VaultNavigation /> : null}
    </div>
  )
}
