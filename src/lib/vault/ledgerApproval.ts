import {
  connectLedgerSavings,
  registerLedgerSavings,
  signLedgerSavings,
  type LedgerSavingsRegistration,
} from './ledgerClient'
import type { LedgerSavingsContract, LedgerSavingsPayment } from './ledgerSavings'

export type LedgerApprovalPhase = 'idle' | 'connecting' | 'approving' | 'saving' | 'complete' | 'check'

async function withDevice<T>(
  signal: AbortSignal,
  approve: (app: Awaited<ReturnType<typeof connectLedgerSavings>>['app']) => Promise<T>,
) {
  signal.throwIfAborted()
  const device = await connectLedgerSavings()
  try {
    signal.throwIfAborted()
    const result = await approve(device.app)
    signal.throwIfAborted()
    return result
  } finally {
    await device.close().catch(() => undefined)
  }
}

export function approveLedgerRegistration<T>(
  contract: LedgerSavingsContract,
  signal: AbortSignal,
  onDeviceReady: () => void | Promise<void>,
  accept: (registration: LedgerSavingsRegistration) => Promise<T>,
) {
  return withDevice(signal, async (app) => {
    await onDeviceReady()
    signal.throwIfAborted()
    const registration = await registerLedgerSavings(app, contract)
    signal.throwIfAborted()
    return accept(registration)
  })
}

export function approveLedgerPayment<T>(
  payment: LedgerSavingsPayment,
  phonePsbt: string,
  registration: LedgerSavingsRegistration,
  signal: AbortSignal,
  onDeviceReady: () => void | Promise<void>,
  accept: (signedPsbt: string) => Promise<T>,
) {
  return withDevice(signal, async (app) => {
    await onDeviceReady()
    signal.throwIfAborted()
    const signed = await signLedgerSavings(app, payment, phonePsbt, registration)
    signal.throwIfAborted()
    return accept(signed)
  })
}
