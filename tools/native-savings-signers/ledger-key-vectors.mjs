// Public deterministic fixtures for wallet/runtime agreement; never substitute user keys.
import { createServer } from 'vite'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})
try {
  const keys = await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativeKeys.ts')
  const { buildLedgerNativeSavings } = await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativePolicy.ts')
  const { PROGRAM_FIXTURE_FAMILY } = await vite.ssrLoadModule('/src/lib/vault/program/fixtures.ts')
  const { buildVaultProgramFamily } = await vite.ssrLoadModule('/src/lib/vault/program/trees.ts')
  const { defaultSpendingPolicy, spendingPolicyDigest } = await vite.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
  const rows = []
  for (const network of ['mutinynet', 'mainnet'])
    for (const advanced of [false, true]) {
      const versions = keys.ledgerBip32Versions(network)
      const path = [0x80000056, 0x80000000 + (network === 'mainnet' ? 0 : 1), 0x80000000]
      const account = (fill) => {
        const seed = HDKey.fromMasterSeed(new Uint8Array(32).fill(fill), versions)
        const node = path.reduce((p, i) => p.deriveChild(i), seed)
        return { xpub: node.publicExtendedKey, fingerprint: seed.fingerprint.toString(16).padStart(8, '0'), path }
      }
      const policy = defaultSpendingPolicy(network)
      const input = {
        templateVersion: keys.LEDGER_NATIVE_TEMPLATE,
        network,
        vaultId: PROGRAM_FIXTURE_FAMILY.vaultId,
        policyDigest: spendingPolicyDigest(policy, network),
        phone: account(0x43),
        hardware: account(0x42),
        ...(advanced ? { recovery: account(0x44) } : {}),
        phoneDirectP256: PROGRAM_FIXTURE_FAMILY.phoneDirectP256,
        vaultCosignerBase: PROGRAM_FIXTURE_FAMILY.vaultCosignerBase,
        arkadeCosignerBase: PROGRAM_FIXTURE_FAMILY.arkadeCosignerBase,
      }
      const pub = (origin) => hex.encode(keys.ledgerSavingsChild(keys.ledgerAccountKey(origin, network), 0).publicKey)
      const family = buildVaultProgramFamily({
        ...PROGRAM_FIXTURE_FAMILY,
        network,
        phonePub: pub(input.phone),
        hardwarePub: pub(input.hardware),
        recoveryPub: advanced ? pub(input.recovery) : undefined,
        absoluteFeeCapSats: policy.absoluteFeeCapSats,
        feerateCapSatPerV: policy.feerateCapSatVb,
      })
      const children = (parent, branches) =>
        branches.map((i) => hex.encode(keys.ledgerSavingsChild(parent, i).publicKey))
      const internal = keys.ledgerSavingsInternalParent(input)
      const programParents = []
      for (const claimant of advanced ? ['phone', 'hardware', 'recovery'] : ['phone', 'hardware']) {
        const program = family.initiateAuth['savings-' + claimant]
        for (const cosigner of ['vault', 'arkade']) {
          const parent = keys.ledgerRecoveryProgramParent(input, claimant, cosigner, program)
          programParents.push({
            claimant,
            cosigner,
            program: hex.encode(program),
            xpub: parent.publicExtendedKey,
            children: children(parent, [0, 1]),
          })
        }
      }
      const normal = buildLedgerNativeSavings(
        input,
        Object.fromEntries(programParents.map((p) => [p.claimant, p.program])),
      )
      rows.push({
        input,
        contextDigest: hex.encode(keys.ledgerSavingsContextDigest(input)),
        internal: { xpub: internal.publicExtendedKey, children: children(internal, [0, 1]) },
        accounts: Object.fromEntries(
          ['phone', 'hardware', ...(advanced ? ['recovery'] : [])].map((role) => [
            role,
            children(keys.ledgerAccountKey(input[role], network), [0, 1, 2, 3]),
          ]),
        ),
        programParents,
        normal: {
          walletPolicy: normal.walletPolicy,
          receive: { address: normal.receive.address, script: hex.encode(normal.receive.script) },
          change: { address: normal.change.address, script: hex.encode(normal.change.script) },
        },
      })
    }
  writeFileSync(
    new URL('../../src/lib/vault/program/ledger-key-vectors.json', import.meta.url),
    JSON.stringify(rows, null, 2) + '\n',
  )
  console.log('Generated', rows.length, 'Ledger key vectors with existing recovery programs')
} finally {
  await vite.close()
}
