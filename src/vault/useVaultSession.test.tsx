import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressPin } from '../lib/vault/pin'
import { emptySetupPlan, type VaultSetupPlan } from '../lib/vault/setupPlan'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import type { VaultStatus } from '../lib/vault/types'
import { useVaultSession } from './useVaultSession'
import { loadStagedEnrollment, saveStagedEnrollment, type StagedEnrollment } from '../lib/vault/enrollmentStore'
import { ledgerRecoveryFixture } from '../lib/vault/recovery/testdata/ledger'
import { hashLedgerSavingsEnrollment } from '../lib/vault/program/ledgerRecoveryDescriptor'

const mocks = vi.hoisted(() => ({
  renew: vi.fn(),
  setupRenewal: vi.fn(),
  discover: vi.fn(),
  openArchive: vi.fn(),
  restoreArchive: vi.fn(),
  liveStatus: vi.fn(),
  enable: vi.fn(),
  enroll: vi.fn(),
  beginLedger: vi.fn(),
  finishLedger: vi.fn(),
  completeLedger: vi.fn(),
  loadPin: vi.fn(),
  makePin: vi.fn(),
  pullMap: vi.fn(),
  recover: vi.fn(),
  savePin: vi.fn(),
  unlock: vi.fn(),
}))

vi.mock('../lib/vault/recovery/backupCodec', async (original) => ({
  ...(await original<typeof import('../lib/vault/recovery/backupCodec')>()),
  openLocalRecoveryBackup: mocks.openArchive,
}))
vi.mock('../lib/vault/recovery/restore', () => ({ restoreVaultRecoveryFile: mocks.restoreArchive }))
vi.mock('../lib/vault/status', async (original) => ({
  ...(await original<typeof import('../lib/vault/status')>()),
  fetchVaultStatus: mocks.liveStatus,
}))

vi.mock('../lib/vault/pin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/vault/pin')>()),
  loadAddressPin: mocks.loadPin,
  pinFromEnrolledStatus: mocks.makePin,
  saveAddressPin: mocks.savePin,
}))

vi.mock('../lib/vault/vtxo/renewalCeremony', () => ({
  renewFromLocalUnlock: mocks.renew,
  setupSpendingRenewals: mocks.setupRenewal,
}))

vi.mock('../lib/vault/signIn', () => ({
  discoverVaultIdFromPasskey: mocks.discover,
  enablePasskeyLogin: mocks.enable,
  signInWithPasskey: mocks.recover,
  unlockLocalEnrollment: mocks.unlock,
}))

vi.mock('../lib/vault/tenantEnrollment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/vault/tenantEnrollment')>()),
  enrollWithPasskey: mocks.enroll,
  beginTenantEnrollment: mocks.beginLedger,
  finishTenantEnrollment: mocks.finishLedger,
  completeLedgerTenantEnrollment: mocks.completeLedger,
}))

vi.mock('../lib/vault/program/kitBackup', async (original) => ({
  ...(await original<typeof import('../lib/vault/program/kitBackup')>()),
  pullMapBackup: mocks.pullMap,
  pushMapBackup: vi.fn(),
}))

vi.mock('../lib/vault/program/kitStore', () => ({ saveLocalKit: vi.fn() }))

const enrollment = {
  vaultId: 'vault-a',
  credId: '00',
  webauthnP256: '02',
  phoneDirectP256: '02',
  phoneBip340Pub: '02',
  nonce: '00',
  ciphertext: '00',
} as EnrollmentSecrets

const status = { enrolled: true, vaultId: 'vault-a' } as VaultStatus
const pin = { vaultId: 'vault-a', savingsAddress: 'tb1psavings' } as AddressPin
const setup = { hardwarePub: '', recoveryPub: '' } as VaultSetupPlan

function setupHook(
  session: { enrollment: EnrollmentSecrets | null; status: VaultStatus | null } = { enrollment, status },
) {
  const state = {
    reportError: vi.fn(),
    sealPlan: vi.fn(() => setup),
    setAddressPin: vi.fn(),
    setBusy: vi.fn(),
    setEnrollment: vi.fn(),
    setLocked: vi.fn(),
    setScreen: vi.fn(),
    setStatus: vi.fn(),
  }
  const hook = renderHook(() =>
    useVaultSession({
      enrollment: session.enrollment,
      ...state,
      setup,
      status: session.status,
    }),
  )
  return { ...hook, ...state }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mocks.beginLedger.mockReset()
  mocks.finishLedger.mockReset()
  mocks.completeLedger.mockReset()
  mocks.discover.mockResolvedValue('vault-a')
  mocks.enable.mockResolvedValue(status)
  mocks.pullMap.mockResolvedValue(null)
  mocks.recover.mockResolvedValue({ enrollment, status })
  mocks.makePin.mockReturnValue(pin)
  mocks.savePin.mockReturnValue(pin)
  mocks.unlock.mockResolvedValue({ enrollment, status })
})

describe('Vault session program-pin recovery', () => {
  it('upgrades and pins the signed passkey recovery binding when the local program pin is missing', async () => {
    mocks.loadPin.mockReturnValueOnce(null).mockReturnValueOnce(pin)
    const hook = setupHook()

    await act(async () => hook.result.current.signIn())

    expect(mocks.unlock).not.toHaveBeenCalled()
    expect(mocks.enable).toHaveBeenCalledExactlyOnceWith(enrollment)
    expect(mocks.recover).not.toHaveBeenCalled()
    expect(hook.setAddressPin).toHaveBeenCalledWith(pin)
    expect(hook.setScreen).toHaveBeenCalledWith('home')
  })

  it('keeps the local unlock path when the pinned Vault Program is present', async () => {
    mocks.loadPin.mockReturnValue(pin)
    const hook = setupHook()

    await act(async () => hook.result.current.signIn())

    expect(mocks.unlock).toHaveBeenCalledExactlyOnceWith(enrollment, expect.any(Function))
    expect(mocks.recover).not.toHaveBeenCalled()
    expect(hook.setStatus).toHaveBeenCalledWith(status)
    expect(hook.setScreen).toHaveBeenCalledWith('home')
  })

  it('opens Home without waiting for the optional recovery-map fetch', async () => {
    mocks.loadPin.mockReturnValue(pin)
    let releaseMap!: () => void
    mocks.pullMap.mockReturnValue(
      new Promise<null>((resolve) => {
        releaseMap = () => resolve(null)
      }),
    )
    const hook = setupHook()

    await act(async () => hook.result.current.signIn())

    expect(hook.setScreen).toHaveBeenCalledWith('home')
    releaseMap()
    await act(async () => Promise.resolve())
  })

  it('opens a genuinely fresh recovered session when private browsing rejects durable writes', async () => {
    mocks.loadPin.mockReturnValue(null)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })
    const hook = setupHook({ enrollment: null, status: null })

    await act(async () => hook.result.current.signIn())

    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith('vault-a', expect.any(Function))
    expect(hook.setEnrollment).toHaveBeenCalledWith(enrollment)
    expect(hook.setAddressPin).toHaveBeenCalledWith(pin)
    expect(hook.setStatus).toHaveBeenCalledWith(status)
    expect(hook.setLocked).toHaveBeenCalledWith(false)
    expect(hook.setScreen).toHaveBeenCalledWith('home')
    expect(hook.reportError).not.toHaveBeenCalledWith('Something went wrong. Try again.')

    setItem.mockRestore()
  })
})

describe('Vault session enrollment passkey install', () => {
  const readySetup: VaultSetupPlan = {
    ...emptySetupPlan(),
    acceptedDesign: true,
    hardwarePub: '02' + '11'.repeat(32),
    complete: true,
    connector: {
      descriptor: 'fixture',
      address: 'fixture',
      selectedPath: 'fixture',
      connectorPub: '02' + '11'.repeat(32),
      connectorType: 'p2wpkh',
      connectorFingerprint: 1,
      connectorPath: [0x80000054, 0x80000001, 0x80000000, 0, 0],
    },
  }

  it('requires a new descriptor even when a previous vault is enrolled', async () => {
    const reportError = vi.fn()
    const setScreen = vi.fn()
    const hook = renderHook(() =>
      useVaultSession({
        enrollment,
        status,
        setup: { ...readySetup, connector: undefined },
        reportError,
        setScreen,
        sealPlan: vi.fn(() => readySetup),
        setAddressPin: vi.fn(),
        setBusy: vi.fn(),
        setEnrollment: vi.fn(),
        setLocked: vi.fn(),
        setStatus: vi.fn(),
      }),
    )
    await act(async () => hook.result.current.enroll())
    expect(mocks.enroll).not.toHaveBeenCalled()
    expect(setScreen).toHaveBeenCalledWith('hardware')
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('public wallet descriptor'))
  })

  it.each([null, { ...status, externalOwnerWalletPub: '03' + '22'.repeat(32) }])(
    'enrolls the new descriptor independently of a previous vault status %j',
    async (previousStatus) => {
      mocks.enroll.mockResolvedValue({ enrollment, status })
      mocks.enable.mockRejectedValue(new Error('authorizer did not persist passkey sign-in recovery data'))
      mocks.makePin.mockReturnValue(pin)
      const state = {
        reportError: vi.fn(),
        sealPlan: vi.fn(() => readySetup),
        setAddressPin: vi.fn(),
        setBusy: vi.fn(),
        setEnrollment: vi.fn(),
        setLocked: vi.fn(),
        setScreen: vi.fn(),
        setStatus: vi.fn(),
      }
      const hook = renderHook(() =>
        useVaultSession({
          enrollment: null,
          ...state,
          setup: readySetup,
          status: previousStatus,
        }),
      )

      await act(async () => hook.result.current.enroll('a'.repeat(32)))

      expect(mocks.enroll).toHaveBeenCalledWith(
        'a'.repeat(32),
        expect.objectContaining({
          hardwarePub: readySetup.hardwarePub,
          connector: expect.objectContaining({ connectorPub: readySetup.hardwarePub }),
        }),
      )
      expect(mocks.enable).toHaveBeenCalledTimes(2)
      expect(state.setAddressPin).toHaveBeenCalledWith(pin)
      expect(state.setScreen).toHaveBeenCalledWith('created')
      expect(state.setScreen).not.toHaveBeenCalledWith('problem')
      expect(state.reportError).toHaveBeenCalledWith(expect.stringMatching(/sign-in after a restart is not on yet/i))
    },
  )
})

describe('local archive restore with unavailable live status', () => {
  it('retains imported data without publishing an empty unlocked session, then retries online', async () => {
    const file = { header: { enrollment, status, binding: { vaultId: enrollment.vaultId } } }
    mocks.restoreArchive.mockImplementation(async () => {
      localStorage.setItem('restored-archive-fixture', JSON.stringify(file))
    })
    mocks.openArchive.mockImplementation(async (_raw, restore) => {
      await restore(file, new Uint8Array(32))
      return file
    })
    mocks.liveStatus.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce(status)
    const hook = setupHook({ enrollment: null, status: null })
    await act(async () => {
      await expect(hook.result.current.restoreRecoveryArchive({ name: 'encrypted-fixture' })).rejects.toThrow(
        'Failed to fetch',
      )
    })
    expect(mocks.restoreArchive).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('restored-archive-fixture')).toBe(JSON.stringify(file))
    expect(hook.setEnrollment).not.toHaveBeenCalled()
    expect(hook.setAddressPin).not.toHaveBeenCalled()
    expect(hook.setLocked).not.toHaveBeenCalled()
    expect(hook.setStatus).not.toHaveBeenCalled()
    expect(hook.setScreen).not.toHaveBeenCalled()
    expect(hook.reportError).toHaveBeenLastCalledWith(
      'Recovery data is saved on this device. Live balances could not be loaded.',
    )
    expect(hook.setBusy).toHaveBeenLastCalledWith(false)
    await act(async () => hook.result.current.restoreRecoveryArchive({ name: 'encrypted-fixture' }))
    expect(hook.setEnrollment).toHaveBeenCalledWith(enrollment)
    expect(hook.setStatus).toHaveBeenCalledWith(status)
    expect(hook.setScreen).toHaveBeenCalledWith('home')
  })
})

describe('Ledger enrollment session interruption recovery', () => {
  async function nativeSetup(advanced = false) {
    const f = await ledgerRecoveryFixture(advanced)
    const contract = f.composite.savings
    const selected: VaultSetupPlan = {
      ...emptySetupPlan(),
      acceptedDesign: true,
      complete: true,
      protectionTier: advanced ? 'advanced' : 'standard',
      hardwarePub: f.status.externalOwnerWalletPub!,
      recoveryPub: f.status.recoveryPub || '',
      txCapSats: contract.spendingPolicy.txRecipientCapSats,
      dailyLimitSats: contract.spendingPolicy.periodAllowanceSats,
      absoluteFeeCapSats: contract.spendingPolicy.absoluteFeeCapSats,
      feerateCapSatPerV: contract.spendingPolicy.feerateCapSatPerV,
      ledger: {
        hardware: contract.context.hardware,
        ...(contract.context.recovery ? { recovery: contract.context.recovery } : {}),
      },
    }
    const { ledgerSavings, ...phone } = f.enrollment
    const draft = {
      version: ledgerSavings.version,
      contract: ledgerSavings.contract,
      phoneSeedBackup: ledgerSavings.phoneSeedBackup,
    }
    const saved: StagedEnrollment = {
      ...phone,
      handle: 'original-handle',
      userHandle: 'ab',
      clientDataJSON: '01',
      authenticatorData: '02',
      attestationObject: '03',
      hardwareXOnly: selected.hardwarePub.slice(2),
      ...(selected.recoveryPub ? { recoveryXOnly: selected.recoveryPub.slice(2) } : {}),
      inviteToken: 'original-token',
      descriptorHash: hashLedgerSavingsEnrollment(f.composite),
      boardingPub: f.composite.boarding.boardingPub,
      boardingDescriptor: f.composite.boarding,
      boardingDescriptorHash: hashLedgerSavingsEnrollment(f.composite),
      protectionTier: selected.protectionTier,
      spendingPolicy: contract.spendingPolicy,
      spendingPolicyDigest: contract.context.policyDigest,
      ledgerSavingsDraft: draft,
      ledgerSavingsDescriptor: f.composite,
    }
    const render = (plan = selected) => {
      const state = {
        reportError: vi.fn(),
        sealPlan: vi.fn(() => plan),
        setAddressPin: vi.fn(),
        setBusy: vi.fn(),
        setEnrollment: vi.fn(),
        setLocked: vi.fn(),
        setScreen: vi.fn(),
        setStatus: vi.fn(),
      }
      const hook = renderHook(() => useVaultSession({ enrollment: null, status: null, setup: plan, ...state }))
      return { ...hook, ...state }
    }
    return { f, selected, saved, render }
  }

  it.each([false, true])(
    'resumes an unregistered draft after reload without generating another identity (advanced=%s)',
    async (advanced) => {
      const { f, saved, render } = await nativeSetup(advanced)
      mocks.beginLedger.mockImplementation(async () => {
        saveStagedEnrollment(saved)
        return { enrollment: f.enrollment, ledgerDescriptor: f.composite, enrollmentToken: saved.inviteToken }
      })
      const first = render()
      await act(async () => first.result.current.enroll('original-token'))
      expect(mocks.beginLedger).toHaveBeenCalledTimes(1)
      expect(first.setScreen).toHaveBeenLastCalledWith('ledger-register')
      first.unmount()
      const second = render()
      await act(async () => second.result.current.enroll('ignored-new-token'))
      expect(mocks.beginLedger).toHaveBeenCalledTimes(1)
      expect(mocks.finishLedger).not.toHaveBeenCalled()
      expect(mocks.completeLedger).not.toHaveBeenCalled()
      expect(second.setScreen).toHaveBeenLastCalledWith('ledger-register')
      expect(loadStagedEnrollment()).toEqual(saved)
      expect(second.setBusy).toHaveBeenLastCalledWith(false)
    },
  )

  it('retries only finish from a persisted registration after reload', async () => {
    const { f, saved, render } = await nativeSetup(true)
    saveStagedEnrollment({ ...saved, ledgerSavings: f.enrollment.ledgerSavings })
    mocks.finishLedger.mockResolvedValue({ enrollment: f.enrollment, status: f.status })
    mocks.enable.mockResolvedValue(f.status)
    const hook = render()
    await act(async () => hook.result.current.enroll('replacement-token'))
    expect(mocks.finishLedger).toHaveBeenCalledExactlyOnceWith('original-token')
    expect(mocks.beginLedger).not.toHaveBeenCalled()
    expect(mocks.completeLedger).not.toHaveBeenCalled()
    expect(hook.setScreen).toHaveBeenLastCalledWith('created')
    expect(hook.setEnrollment).toHaveBeenCalledWith(f.enrollment)
  })

  it.each(['hardware', 'recovery', 'policy'] as const)(
    'refuses replacing a staged enrollment with changed %s',
    async (field) => {
      const { saved, selected, render } = await nativeSetup(true)
      saveStagedEnrollment(saved)
      const altered = structuredClone(selected)
      if (field === 'policy') altered.txCapSats -= 1
      else altered.ledger![field]!.fingerprint = 'ffffffff'
      const hook = render(altered)
      await act(async () => hook.result.current.enroll())
      expect(mocks.beginLedger).not.toHaveBeenCalled()
      expect(mocks.finishLedger).not.toHaveBeenCalled()
      expect(mocks.completeLedger).not.toHaveBeenCalled()
      expect(hook.reportError).toHaveBeenCalledWith(expect.stringContaining('already in progress'))
      expect(hook.setScreen).toHaveBeenLastCalledWith('problem')
      expect(loadStagedEnrollment()).toEqual(saved)
    },
  )

  it('retains a failed completion for finish retry without another device approval', async () => {
    const { f, saved, render } = await nativeSetup()
    saveStagedEnrollment(saved)
    mocks.completeLedger.mockImplementation(async () => {
      saveStagedEnrollment({ ...saved, ledgerSavings: f.enrollment.ledgerSavings })
      throw new Error('finish response lost')
    })
    const first = render()
    await act(async () => {
      await expect(
        first.result.current.completeLedgerEnrollment(f.enrollment.ledgerSavings.registration),
      ).rejects.toThrow('finish response lost')
    })
    expect(first.setBusy).toHaveBeenLastCalledWith(false)
    expect(first.setScreen).not.toHaveBeenCalledWith('created')
    first.unmount()
    mocks.finishLedger.mockResolvedValue({ enrollment: f.enrollment, status: f.status })
    const resumed = render()
    await act(async () => resumed.result.current.enroll())
    expect(mocks.completeLedger).toHaveBeenCalledTimes(1)
    expect(mocks.finishLedger).toHaveBeenCalledExactlyOnceWith('original-token')
    expect(mocks.beginLedger).not.toHaveBeenCalled()
    expect(resumed.setScreen).toHaveBeenLastCalledWith('created')
  })
})
