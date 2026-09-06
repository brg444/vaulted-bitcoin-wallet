import { contractHandlers, timelockToSequence, type ContractHandler } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { LIGHT_PROGRAM, LightScript, validateLightScriptParams, type LightScriptParams } from './contract'

// Register explicitly when loading a Light wallet; generic SDK selection stays disabled.
export const LightContractHandler: ContractHandler<LightScriptParams, LightScript> = {
  type: LIGHT_PROGRAM,
  createScript(params) {
    return new LightScript(this.deserializeParams(params))
  },
  serializeParams(params) {
    const valid = validateLightScriptParams(params)
    return { ...valid, exitDelaySeconds: String(valid.exitDelaySeconds) }
  },
  deserializeParams(params) {
    const expected = ['network', 'ownerPub', 'cosignerPub', 'operatorPub', 'exitDelaySeconds']
    if (Object.keys(params).length !== expected.length || expected.some((key) => typeof params[key] !== 'string')) {
      throw new Error('Light contract fields do not match')
    }
    if (!/^[1-9][0-9]*$/.test(params.exitDelaySeconds)) throw new Error('Light exit delay must be canonical seconds')
    return validateLightScriptParams({
      ...params,
      network: params.network as LightScriptParams['network'],
      ownerPub: params.ownerPub,
      cosignerPub: params.cosignerPub,
      operatorPub: params.operatorPub,
      exitDelaySeconds: Number(params.exitDelaySeconds),
    })
  },
  selectPath: () => null,
  getAllSpendingPaths: (script, _contract, context) => {
    const owner = script.params.ownerPub
    if (context.collaborative || (context.walletDescriptor !== `tr(${owner})` && context.walletPubKey !== owner))
      return []
    return [
      {
        leaf: script.exit(),
        sequence: timelockToSequence({ type: 'seconds', value: BigInt(script.params.exitDelaySeconds) }),
      },
    ]
  },
  getSpendablePaths: () => [],
  isGenericallySpendable: () => false,
}

export function registerLightContractHandler() {
  if (!contractHandlers.has(LIGHT_PROGRAM)) contractHandlers.register(LightContractHandler)
}
export function lightContract(script: LightScript, address: string) {
  return {
    type: LIGHT_PROGRAM,
    label: 'Spending',
    params: LightContractHandler.serializeParams(script.params),
    script: hex.encode(script.pkScript),
    address,
    state: 'active' as const,
  }
}
