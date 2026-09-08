import { CSVMultisigTapscript, MultisigTapscript, VtxoScript, type TapLeafScript } from '@arkade-os/sdk'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes, requireLowerHex } from '../hex'
import { tweakByArkScript } from '../program/tweak'
import { type RollingParameters } from './allowance'
import { compileRollingPrograms } from './compiler'

export interface RollingContractParameters {
  policy: RollingParameters
  tier: 'light' | 'standard' | 'advanced'
  exitDelaySeconds: number
  user: string
  guardian: string
  emulator: string
  operator: string
  hardware?: string
  recovery?: string
}

function publicKey(key: string): Uint8Array {
  requireLowerHex(key, 'contract public key', 33)
  if (!key.startsWith('02') && !key.startsWith('03')) throw new Error('Compressed contract key required')
  secp256k1.Point.fromHex(key)
  return hexToBytes(key.slice(2))
}

/** Full immutable tree; existing funded contracts keep their original version. */
export class RollingAllowanceScript extends VtxoScript {
  readonly spendScript: string
  readonly creditScript: string
  readonly renewScript: string
  readonly cleanupScript: string
  readonly exitScript: string
  readonly programs: ReturnType<typeof compileRollingPrograms>

  constructor(params: RollingContractParameters) {
    const delay = params.exitDelaySeconds
    if (!Number.isSafeInteger(delay) || delay <= 0 || delay % 512 !== 0 || delay / 512 > 65535) {
      throw new Error('Invalid recovery delay')
    }
    const roles = [params.user, params.guardian, params.emulator, params.operator]
    let exitKeys: string[]
    switch (params.tier) {
      case 'light':
        if (params.hardware || params.recovery) throw new Error('Light has one recovery owner')
        exitKeys = [params.user]
        break
      case 'standard':
        if (!params.hardware || params.recovery) throw new Error('Standard requires device and hardware recovery')
        roles.push(params.hardware)
        exitKeys = [params.user, params.hardware]
        break
      case 'advanced':
        if (!params.hardware || !params.recovery) throw new Error('Advanced requires hardware and recovery keys')
        roles.push(params.hardware, params.recovery)
        exitKeys = [params.hardware, params.recovery]
        break
      default:
        throw new Error('Unknown protection tier')
    }
    const seen = new Set<string>()
    for (const key of roles) {
      const xonly = bytesToHex(publicKey(key))
      if (seen.has(xonly) || xonly === params.policy.receiptKey)
        throw new Error('Contract roles must have separate keys')
      seen.add(xonly)
    }
    if (bytesToHex(publicKey(params.policy.delegatePubkey)) === params.policy.receiptKey) {
      throw new Error('Receipt and delegate keys must have separate scopes')
    }
    const programs = compileRollingPrograms(params.policy)
    const collaborative = (code: Uint8Array, renew = false) =>
      MultisigTapscript.encode({
        pubkeys: [
          ...(renew ? [publicKey(params.guardian)] : [publicKey(params.user), publicKey(params.guardian)]),
          publicKey(tweakByArkScript(params.emulator, code)),
          publicKey(params.operator),
        ],
      })
    const spend = collaborative(programs.spend)
    const credit = collaborative(programs.credit)
    const renew = collaborative(programs.renew, true)
    const cleanup = MultisigTapscript.encode({
      pubkeys: [
        publicKey(params.guardian),
        publicKey(tweakByArkScript(params.emulator, programs.cleanup)),
        publicKey(params.operator),
      ],
    })
    const exit = CSVMultisigTapscript.encode({
      pubkeys: exitKeys.map(publicKey),
      timelock: { type: 'seconds', value: BigInt(delay) },
    })
    super([spend.script, credit.script, renew.script, cleanup.script, exit.script])
    this.spendScript = bytesToHex(spend.script)
    this.creditScript = bytesToHex(credit.script)
    this.renewScript = bytesToHex(renew.script)
    this.cleanupScript = bytesToHex(cleanup.script)
    this.exitScript = bytesToHex(exit.script)
    this.programs = programs
  }

  spend(): TapLeafScript {
    return this.findLeaf(this.spendScript)
  }
  credit(): TapLeafScript {
    return this.findLeaf(this.creditScript)
  }
  renew(): TapLeafScript {
    return this.findLeaf(this.renewScript)
  }
  cleanup(): TapLeafScript {
    return this.findLeaf(this.cleanupScript)
  }
  exit(): TapLeafScript {
    return this.findLeaf(this.exitScript)
  }
}
