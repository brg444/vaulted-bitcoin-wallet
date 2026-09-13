import { contractHandlers, type ContractHandler } from '@arkade-os/sdk'
import { ROLLING_PROGRAM } from './allowance'
import { RollingAllowanceScript, type RollingContractParameters } from './contract'

function canonicalParams(params: RollingContractParameters): string {
  new RollingAllowanceScript(params)
  const p = params.policy
  return JSON.stringify({
    policy: {
      networkGenesis: p.networkGenesis,
      controllerTxid: p.controllerTxid,
      controllerIndex: p.controllerIndex,
      budget: p.budget,
      recipientCap: p.recipientCap,
      feeCap: p.feeCap,
      renewalWindow: p.renewalWindow,
      feerateCap: p.feerateCap,
      delegatePubkey: p.delegatePubkey,
      receiptKey: p.receiptKey,
      checkpointExit: p.checkpointExit,
    },
    tier: params.tier,
    exitDelaySeconds: params.exitDelaySeconds,
    user: params.user,
    guardian: params.guardian,
    emulator: params.emulator,
    operator: params.operator,
    ...(params.hardware ? { hardware: params.hardware } : {}),
    ...(params.recovery ? { recovery: params.recovery } : {}),
  })
}

export const RollingAllowanceContractHandler: ContractHandler<RollingContractParameters, RollingAllowanceScript> = {
  type: ROLLING_PROGRAM,
  createScript(params) {
    return new RollingAllowanceScript(this.deserializeParams(params))
  },
  serializeParams(params) {
    return { descriptor: canonicalParams(params) }
  },
  deserializeParams(params) {
    if (Object.keys(params).length !== 1 || typeof params.descriptor !== 'string' || params.descriptor.length > 16384) {
      throw new Error('Invalid rolling contract parameters')
    }
    const parsed: RollingContractParameters = JSON.parse(params.descriptor)
    if (canonicalParams(parsed) !== params.descriptor) throw new Error('Noncanonical rolling contract parameters')
    return parsed
  },
  // Every cooperative operation requires the controller, its committed history,
  // and the explicit authorization flow. Generic SDK selection grants none.
  selectPath: () => null,
  getAllSpendingPaths: () => [],
  getSpendablePaths: () => [],
  isGenericallySpendable: () => false,
}

export function registerRollingAllowanceContractHandler(): void {
  if (!contractHandlers.has(ROLLING_PROGRAM)) contractHandlers.register(RollingAllowanceContractHandler)
}
