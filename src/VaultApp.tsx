import VaultLedgerPayment from './screens/Vault/LedgerPayment'
import VaultLight from './screens/Vault/Light'
import { loadLightEnrollment } from './lib/vault/light/enrollment'
import { useContext, useEffect, useRef, useState } from 'react'
import { VaultContext } from './vault/context'
import './screens/Vault/vault.css'
import './screens/Vault/vault-system.css'
import './screens/Vault/quiet-guardian-flows.css'
import './screens/Vault/qg/layout.css'
import './screens/Vault/quiet-guardian-screens.css'
import VaultHome from './screens/Vault/Home'
import VaultActivity from './screens/Vault/Activity'
import VaultReceive from './screens/Vault/Receive'
import VaultReview from './screens/Vault/Review'
import VaultSend from './screens/Vault/Send'
import VaultSuccess from './screens/Vault/Success'
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
import VaultTx from './screens/Vault/Tx'
import VaultNavigation, { destinationForScreen } from './screens/Vault/Navigation'
import { bootVaultPrefs } from './lib/vault/prefs'
import { bootVaultFrame } from './lib/vault/pwaFrame'
import { reloadIfNewerWallet } from './lib/vault/update'
import { useIntentPress } from './screens/Vault/qg/useIntentPress'
import { useScreenMotion } from './screens/Vault/qg/useScreenMotion'

export default function VaultApp() {
  const [lightActive, setLightActive] = useState(() => {
    try {
      // A setup preference is not a wallet. Resume unfinished setup only after
      // the user chooses Light, leaving existing vault sign-in accessible.
      return localStorage.getItem('vaulted:active-setup') === 'light' && Boolean(loadLightEnrollment())
    } catch {
      return false
    }
  })
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
    welcome: <VaultWelcome />,
    unlock: <VaultUnlock />,
    handoff: <VaultHandoff />,
    'ledger-sign': <VaultLedgerPayment />,
    design: (
      <VaultDesign
        onChooseLight={() => {
          localStorage.setItem('vaulted:active-setup', 'light')
          setLightActive(true)
        }}
      />
    ),
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
    home: <VaultHome />,
    activity: <VaultActivity />,
    receive: <VaultReceive />,
    send: <VaultSend />,
    review: <VaultReview />,
    success: <VaultSuccess />,
    keys: <VaultKeys />,
    settings: <VaultSettings />,
    signin: <VaultSignIn />,
    tx: <VaultTx />,
  }
  const page = pages[screen] || <VaultWelcome />
  const className = [
    'page',
    `vault-screen-${lightActive ? 'light' : screen}`,
    !lightActive && launcher ? 'has-vault-navigation' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div ref={root} className={className} data-testid='vault-app' {...intentPress}>
      {lightActive ? (
        <VaultLight
          onExit={() => {
            localStorage.removeItem('vaulted:active-setup')
            setLightActive(false)
          }}
        />
      ) : (
        page
      )}
      {!lightActive && launcher ? <VaultNavigation /> : null}
    </div>
  )
}
