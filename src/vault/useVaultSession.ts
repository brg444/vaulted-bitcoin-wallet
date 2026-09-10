import { renewFromLocalUnlock, setupSpendingRenewals } from '../lib/vault/vtxo/renewalCeremony'
import { openRecoveryCloudBackup } from '../lib/vault/recovery/cloudBackup'
import { openLocalRecoveryBackup } from '../lib/vault/recovery/backupCodec'
import { restoreVaultRecoveryFile } from '../lib/vault/recovery/restore'
import { fetchVaultStatus } from '../lib/vault/status'
import { useCallback, type Dispatch, type SetStateAction } from 'react'
import {
  findStoredEnrollment,
  loadSelectedVaultId,
  saveEnrollment,
  saveSelectedVaultId,
  setSessionLocked,
  loadStagedEnrollment,
} from '../lib/vault/enrollmentStore'
import { humanizeVaultError } from '../lib/vault/humanize'
import { loadAddressPin, pinFromEnrolledStatus, saveAddressPin, type AddressPin } from '../lib/vault/pin'
import {
  discoverVaultIdFromPasskey,
  enablePasskeyLogin,
  signInWithPasskey,
  unlockLocalEnrollment,
} from '../lib/vault/signIn'
import { planReady, setupSpendingPolicy, type VaultSetupPlan } from '../lib/vault/setupPlan'
import {
  beginTenantEnrollment,
  completeLedgerTenantEnrollment,
  enrollWithPasskey,
  finishTenantEnrollment,
  type EnrollmentSecrets,
} from '../lib/vault/tenantEnrollment'
import type { LedgerSavingsRegistration } from '../lib/vault/ledgerClient'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'
import { canonicalLedgerValue } from '../lib/vault/program/ledgerEnrollment'
import {
  connectorPinFromVerifiedStatus,
  saveConnectorEnrollmentPin,
  loadConnectorEnrollmentPin,
  verifyConnectorStatus,
  connectorKitFromVerifiedStatus,
  saveConnectorRecoveryKit,
} from '../lib/vault/program/connectorEnroll'
import { isConnectorTemplate } from '../lib/vault/program/connector'
import type { VaultStatus } from '../lib/vault/types'
import { kitFromFacts, pullMapBackup, pushMapBackup } from '../lib/vault/program/kitBackup'
import { saveLocalKit } from '../lib/vault/program/kitStore'
import type { VaultScreen } from './context'

interface VaultSessionOptions {
  enrollment: EnrollmentSecrets | null
  reportError: (message: string) => void
  sealPlan: () => VaultSetupPlan
  setAddressPin: Dispatch<SetStateAction<AddressPin | null>>
  setBusy: Dispatch<SetStateAction<boolean>>
  setEnrollment: Dispatch<SetStateAction<EnrollmentSecrets | null>>
  setLocked: Dispatch<SetStateAction<boolean>>
  setScreen: Dispatch<SetStateAction<VaultScreen>>
  setStatus: Dispatch<SetStateAction<VaultStatus | null>>
  setup: VaultSetupPlan
  status: VaultStatus | null
}

async function restoreMap(enrollment: EnrollmentSecrets, status: VaultStatus, setup: VaultSetupPlan) {
  try {
    const pulled = status.vaultId ? await pullMapBackup(status.vaultId) : null
    const kit =
      pulled?.kit ||
      kitFromFacts({
        enrollment,
        status,
        hardwarePub: setup.hardwarePub,
        recoveryPub: setup.recoveryPub || status.recoveryPub,
      })
    if (kit) saveLocalKit(kit)
  } catch {
    // Authentication is independent of the optional recovery-map backup.
  }
}

function restoreConnectorPin(status: VaultStatus): void {
  if (!isConnectorTemplate(status.templateVersion)) return
  const existing = loadConnectorEnrollmentPin(status.vaultId)
  if (existing) verifyConnectorStatus(status, existing)
  else saveConnectorEnrollmentPin(connectorPinFromVerifiedStatus(status))
  saveConnectorRecoveryKit(connectorKitFromVerifiedStatus(status))
}

function bestEffortBrowserWrite(write: () => void) {
  try {
    write()
  } catch {
    // A verified in-memory session remains usable when a private or embedded
    // browser refuses durable storage. The next reload will ask for the
    // passkey again instead of turning this successful login into an error.
  }
}

// useVaultSession owns enrollment and passkey session transitions. A verified
// session is usable in memory even when private browsing refuses persistence.
export function useVaultSession({
  enrollment,
  reportError,
  sealPlan,
  setAddressPin,
  setBusy,
  setEnrollment,
  setLocked,
  setScreen,
  setStatus,
  setup,
}: VaultSessionOptions) {
  const acceptEnrollment = useCallback(
    async (result: { enrollment: EnrollmentSecrets; status: VaultStatus }) => {
      setEnrollment(result.enrollment)
      saveEnrollment(result.enrollment)
      saveSelectedVaultId(result.enrollment.vaultId)
      setStatus(result.status)
      const enrolledPin = pinFromEnrolledStatus(result.status)
      setAddressPin(enrolledPin)
      bestEffortBrowserWrite(() => saveAddressPin(enrolledPin))
      sealPlan()
      try {
        const kit = kitFromFacts({
          enrollment: result.enrollment,
          status: result.status,
          hardwarePub: setup.hardwarePub,
          recoveryPub: setup.recoveryPub || result.status.recoveryPub,
        })
        if (!kit) throw new Error('vault service did not return the committed Recovery Kit facts')
        saveLocalKit(kit)
        await pushMapBackup(kit.descriptor.vaultId, kit)
      } catch {
        // Enrollment already saved the server-proposed kit locally. Remote
        // backup remains best effort and never replaces that committed map.
      }
      try {
        setStatus(await enablePasskeyLogin(result.enrollment))
      } catch {
        try {
          setStatus(await enablePasskeyLogin(result.enrollment))
        } catch {
          reportError(
            'This device has the vault, but sign-in after a restart is not on yet. Open Settings, tap Allow other devices, and approve Face ID. Do not clear this browser until that succeeds.',
          )
        }
      }
      await setupSpendingRenewals(result.status, result.enrollment)
      setScreen('created')
    },
    [setEnrollment, setStatus, setAddressPin, sealPlan, setup, reportError, setScreen],
  )

  const enroll = useCallback(
    async (token = '') => {
      if (!planReady(setup)) {
        reportError('Finish setup first.')
        return
      }
      if (setup.protectionTier !== 'light' && !setup.connector && !setup.ledger) {
        reportError('Add a supported public wallet descriptor before creating this vault.')
        setScreen('hardware')
        return
      }
      setBusy(true)
      reportError('')
      setScreen('creating')
      try {
        const roles = {
          protectionTier: setup.protectionTier,
          hardwarePub: setup.hardwarePub,
          ...(setup.recoveryPub ? { recoveryPub: setup.recoveryPub } : {}),
          ...(setup.connector
            ? {
                connector: {
                  connectorPub: setup.connector.connectorPub,
                  connectorType: setup.connector.connectorType,
                  connectorFingerprint: setup.connector.connectorFingerprint,
                  connectorPath: [...setup.connector.connectorPath],
                },
              }
            : {}),
          ...(setup.ledger ? { ledger: setup.ledger } : {}),
          spendingPolicy: setupSpendingPolicy(setup),
        }
        if (setup.ledger) {
          const staged = loadStagedEnrollment()
          if (staged?.ledgerSavingsDraft) {
            const context = staged.ledgerSavingsDraft.contract.context
            if (
              canonicalLedgerValue(context.hardware) !== canonicalLedgerValue(setup.ledger.hardware) ||
              canonicalLedgerValue(context.recovery) !== canonicalLedgerValue(setup.ledger.recovery) ||
              canonicalLedgerValue(staged.spendingPolicy) !== canonicalLedgerValue(roles.spendingPolicy)
            )
              throw new Error('Finish or cancel the Ledger setup already in progress.')
            if (staged.ledgerSavings && staged.inviteToken) {
              await acceptEnrollment(await finishTenantEnrollment(staged.inviteToken))
              return
            }
          } else await beginTenantEnrollment(token, roles)
          setScreen('ledger-register')
          return
        }
        const result = await enrollWithPasskey(token, roles)
        await acceptEnrollment(result)
      } catch (error) {
        reportError(humanizeVaultError(error))
        setScreen('problem')
      } finally {
        setBusy(false)
      }
    },
    [reportError, setBusy, setScreen, setup, acceptEnrollment],
  )

  const completeLedgerEnrollment = useCallback(
    async (registration: LedgerSavingsRegistration) => {
      setBusy(true)
      reportError('')
      try {
        await acceptEnrollment(await completeLedgerTenantEnrollment(registration))
      } catch (error) {
        reportError(humanizeVaultError(error))
        throw error
      } finally {
        setBusy(false)
      }
    },
    [acceptEnrollment, reportError, setBusy],
  )

  const enableOtherDevices = useCallback(async () => {
    if (!enrollment) {
      reportError('Finish setup first.')
      return
    }
    setBusy(true)
    reportError('')
    try {
      setStatus(await enablePasskeyLogin(enrollment))
    } catch (error) {
      reportError(humanizeVaultError(error))
    } finally {
      setBusy(false)
    }
  }, [enrollment, reportError, setBusy, setStatus])

  const signIn = useCallback(async () => {
    setBusy(true)
    reportError('')
    try {
      const local = enrollment || findStoredEnrollment()
      const localPin = local ? loadAddressPin(localStorage, local.vaultId) : null
      if (local && localPin) {
        const unlocked = await unlockLocalEnrollment(local, (live, auth, canAuthorizeNew, record) =>
          renewFromLocalUnlock(live, record, auth, canAuthorizeNew),
        )
        restoreConnectorPin(unlocked.status)
        setEnrollment(unlocked.enrollment)
        setLocked(false)
        const live = unlocked.status
        setStatus(live)
        setAddressPin(localPin)
        setScreen('home')
        bestEffortBrowserWrite(() => saveEnrollment(unlocked.enrollment))
        bestEffortBrowserWrite(() => saveSelectedVaultId(unlocked.enrollment.vaultId))
        bestEffortBrowserWrite(() => setSessionLocked(false))
        if (isConnectorTemplate(live.templateVersion) || live.templateVersion === LEDGER_NATIVE_TEMPLATE)
          await setupSpendingRenewals(live, unlocked.enrollment)
        void restoreMap(unlocked.enrollment, live, setup)
        return
      }
      if (local) {
        const live = await enablePasskeyLogin(local)
        restoreConnectorPin(live)
        const livePin = pinFromEnrolledStatus(live)
        setEnrollment(local)
        setLocked(false)
        setStatus(live)
        setAddressPin(livePin)
        setScreen('home')
        bestEffortBrowserWrite(() => saveAddressPin(livePin))
        bestEffortBrowserWrite(() => saveEnrollment(local))
        bestEffortBrowserWrite(() => saveSelectedVaultId(local.vaultId))
        bestEffortBrowserWrite(() => setSessionLocked(false))
        await setupSpendingRenewals(live, local)
        void restoreMap(local, live, setup)
        return
      }
      const selected = loadSelectedVaultId()
      const vaultId = selected || (await discoverVaultIdFromPasskey())
      const result = await signInWithPasskey(vaultId, (live, auth, canAuthorizeNew, record) =>
        renewFromLocalUnlock(live, record, auth, canAuthorizeNew),
      )
      restoreConnectorPin(result.status)
      const recoveredPin = pinFromEnrolledStatus(result.status)
      setEnrollment(result.enrollment)
      setLocked(false)
      setStatus(result.status)
      setAddressPin(recoveredPin)
      setScreen('home')
      bestEffortBrowserWrite(() => saveAddressPin(recoveredPin))
      bestEffortBrowserWrite(() => saveEnrollment(result.enrollment))
      bestEffortBrowserWrite(() => saveSelectedVaultId(result.enrollment.vaultId))
      bestEffortBrowserWrite(() => setSessionLocked(false))
      await setupSpendingRenewals(result.status, result.enrollment)
      void restoreMap(result.enrollment, result.status, setup)
    } catch (error) {
      reportError(humanizeVaultError(error))
    } finally {
      setBusy(false)
    }
  }, [enrollment, reportError, setAddressPin, setBusy, setEnrollment, setLocked, setScreen, setStatus, setup])

  const restoreRecoveryArchive = useCallback(
    async (raw?: unknown) => {
      setBusy(true)
      reportError('')
      let imported = false
      try {
        const file =
          raw === undefined
            ? (await openRecoveryCloudBackup(undefined, restoreVaultRecoveryFile)).file
            : await openLocalRecoveryBackup(raw, restoreVaultRecoveryFile)
        if (!file) throw new Error('No complete encrypted recovery archive was found')
        imported = true
        const live = await fetchVaultStatus(undefined, file.header.binding.vaultId)
        restoreConnectorPin(live)
        const livePin = pinFromEnrolledStatus(live)
        setEnrollment(file.header.enrollment)
        setAddressPin(livePin)
        setStatus(live)
        setLocked(false)
        bestEffortBrowserWrite(() => setSessionLocked(false))
        setScreen('home')
        await setupSpendingRenewals(live, file.header.enrollment)
      } catch (error) {
        reportError(
          imported
            ? 'Recovery data is saved on this device. Live balances could not be loaded.'
            : humanizeVaultError(error),
        )
        throw error
      } finally {
        setBusy(false)
      }
    },
    [reportError, setBusy, setEnrollment, setAddressPin, setStatus, setLocked, setScreen],
  )

  return { enableOtherDevices, enroll, completeLedgerEnrollment, signIn, restoreRecoveryArchive }
}
