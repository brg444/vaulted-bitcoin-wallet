import { mnemonicToSeedSync } from '@scure/bip39'
import { Transaction, type OnchainProvider } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { p2tr } from '@scure/btc-signer'
import { ledgerBip32Versions, type LedgerSavingsKeyContext } from '../program/ledgerNativeKeys'
import {
  buildLedgerRecoveryDescriptor,
  hashLedgerSavingsEnrollment,
  LEDGER_ENROLLMENT_SCHEMA,
  type LedgerSavingsEnrollmentDescriptor,
} from '../program/ledgerRecoveryDescriptor'
import { buildRecoveryKit } from '../program/kit'
import { scalarSecret } from '../program/fixtures'
import vectors from '../program/ledger-key-vectors.json'
import { recoveryFixture } from '../recovery/testdata/helpers'
import { vaultRecoveryBinding } from './recoveryArchive'
import { prepareVaultSpendingRecovery } from './spendingRecovery'
import { defaultSpendingPolicy } from '../spendingPolicy'
import { networkPins } from '../networkPins'
import { ledgerRecoveryFeeWallet, type LedgerRecoveryFeeRequest } from './ledgerRecoveryFee'

export const seed = mnemonicToSeedSync(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
)
export const otherSeed = mnemonicToSeedSync(
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
)
const fixtureCache = new Map<string, Promise<LedgerRecoveryFeeRequest>>()
function derive(network: 'mainnet' | 'mutinynet', input: Uint8Array, path: number[]) {
  const nodes: HDKey[] = []
  let key = HDKey.fromMasterSeed(input, ledgerBip32Versions(network))
  nodes.push(key)
  const fingerprint = key.fingerprint.toString(16).padStart(8, '0')
  for (const index of path) {
    key = key.deriveChild(index)
    nodes.push(key)
  }
  return { fingerprint, key, wipe: () => nodes.forEach((node) => node.wipePrivateData()) }
}
export function chain(): OnchainProvider {
  return {
    getCoins: async () => [],
    getFeeRate: async () => 1,
    getTxStatus: async () => ({ confirmed: true, blockTime: 1, blockHeight: 1 }),
    getChainTip: async () => ({ height: 10000, time: 2_000_000_000, hash: '01'.repeat(32) }),
    getTxOutspends: async () => [{ spent: false }],
    getTransactions: async () => [],
    watchAddresses: async () => () => {},
    broadcastTransaction: async () => {
      throw new Error('offline test cannot broadcast')
    },
  }
}
export async function fixture(advanced = false, network: 'mainnet' | 'mutinynet' = 'mutinynet') {
  const key = `${network}/${advanced}`
  if (!fixtureCache.has(key))
    fixtureCache.set(
      key,
      (async () => {
        const context = structuredClone(
          vectors.find((v) => v.input.network === network && Boolean(v.input.recovery) === advanced)!.input,
        ) as LedgerSavingsKeyContext
        const h = derive(network, seed, context.hardware.path)
        context.hardware = { xpub: h.key.publicExtendedKey, fingerprint: h.fingerprint, path: context.hardware.path }
        const hExit = derive(network, seed, [...context.hardware.path, 12, 0])
        h.wipe()
        let rExit: ReturnType<typeof derive> | undefined
        if (advanced) {
          const r = derive(network, otherSeed, context.recovery!.path)
          context.recovery = { xpub: r.key.publicExtendedKey, fingerprint: r.fingerprint, path: context.recovery!.path }
          rExit = derive(network, otherSeed, [...context.recovery.path, 12, 0])
          r.wipe()
        }
        try {
          const old = recoveryFixture(advanced, network, context.phoneDirectP256, undefined, undefined, {
            hardwarePub: '02' + hex.encode(hExit.key.publicKey!.slice(1)),
            ...(rExit ? { recoveryPub: '02' + hex.encode(rExit.key.publicKey!.slice(1)) } : {}),
          })
          const s = old.status,
            pins = networkPins(network)
          const composite: LedgerSavingsEnrollmentDescriptor = {
            schema: LEDGER_ENROLLMENT_SCHEMA,
            vaultId: context.vaultId,
            savings: { context, spendingPolicy: defaultSpendingPolicy(network) },
            spendingAuthorities: {
              phoneBip340Pub: s.phoneBip340Pub!,
              externalOwnerWalletPub: s.externalOwnerWalletPub!,
              recoveryKeyPub: s.recoveryPub || '',
              vaultCosignerBasePub: s.vaultCosignerBasePub!,
              arkadeCosignerBasePub: s.arkadeCosignerBasePub!,
              phoneDirectP256: s.phoneDirectP256!,
              vtxoVaultCosignerPub: s.vtxoVaultCosignerPub!,
              operatorPub: pins.operatorSignerPub,
              vtxoDelegatePub: pins.delegatePub,
              vtxoExitDelay: pins.policyExitDelay,
              vtxoExitDelayUnit: 'seconds',
              spendingArkAddress: s.spendingArkAddress!,
              spendingArkScript: s.spendingArkScript!,
            },
            boarding: s.vtxoBoardingDescriptor!,
          }
          const descriptor = buildLedgerRecoveryDescriptor(composite),
            kit = buildRecoveryKit(descriptor)
          Object.assign(s, {
            templateVersion: context.templateVersion,
            savingsAddress: descriptor.savings.address,
            savingsScript: descriptor.savings.script,
            ledgerSavings: { ...composite.savings, descriptorHash: hashLedgerSavingsEnrollment(composite) },
            vtxoBoardingDescriptorHash: hashLedgerSavingsEnrollment(composite),
          })
          const archive = {
            ...old.archive,
            kit,
            status: s,
            spending: { ...old.archive.spending, descriptorHash: vaultRecoveryBinding(kit, s).descriptorHash },
          }
          const file = await prepareVaultSpendingRecovery(
            archive,
            descriptor.savings.address,
            async ({ psbt }) => {
              const tx = Transaction.fromPSBT(hex.decode(psbt))
              tx.sign(hExit.key.privateKey!)
              tx.sign(rExit ? rExit.key.privateKey! : scalarSecret(3))
              return hex.encode(tx.toPSBT())
            },
            chain(),
          )
          const wallet = ledgerRecoveryFeeWallet(descriptor)
          const payment = p2tr(hex.decode(wallet.publicKey).slice(1))
          const funding = new Transaction({ version: 2 })
          funding.addInput({ txid: '42'.repeat(32), index: 0 })
          funding.addOutput({ amount: 20_000n, script: payment.script })
          const step = file.exitPackage.steps.find((step) => step.kind === 'bump')!
          if (step.kind !== 'bump') throw new Error('fixture graph requires bump')
          return {
            role: 'hardware' as const,
            file,
            parentTxid: step.parentTxid,
            feeAddress: wallet.feeAddress,
            feeRate: file.exitPackage.feeRate,
            fundingCoins: [
              { txid: funding.id, vout: 0, value: 20_000, parentTxHex: hex.encode(funding.toBytes(true, true)) },
            ],
          }
        } finally {
          hExit.wipe()
          rExit?.wipe()
        }
      })(),
    )
  return structuredClone(await fixtureCache.get(key)!)
}
