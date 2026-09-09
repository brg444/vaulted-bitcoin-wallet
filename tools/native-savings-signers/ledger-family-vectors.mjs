// Public deterministic vectors shared by wallet and runtime; no signing secrets.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { hex } from '@scure/base'
import { format, resolveConfig } from 'prettier'
const root = fileURLToPath(new URL('../../', import.meta.url))
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})
try {
  const { buildLedgerNativeFamily } = await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativeFamily.ts')
  const { defaultSpendingPolicy } = await vite.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
  const contexts = JSON.parse(
    readFileSync(new URL('../../src/lib/vault/program/ledger-key-vectors.json', import.meta.url)),
  )
  const tree = (t, scripts) => ({
    address: t.address,
    script: hex.encode(t.script),
    ...(t.walletPolicy ? { walletPolicy: t.walletPolicy } : {}),
    scripts: scripts.map((s) => hex.encode(s)),
  })
  const vectors = contexts.map(({ input }) => {
    const spendingPolicy = defaultSpendingPolicy(input.network)
    const f = buildLedgerNativeFamily(input, spendingPolicy)
    return {
      input,
      spendingPolicy,
      walletPolicy: f.walletPolicy,
      receive: tree(f.receive, [f.receive.admin, ...f.receive.initiate]),
      change: tree(f.change, [f.change.admin, ...f.change.initiate]),
      recovery: Object.fromEntries(
        Object.entries(f.recovery).map(([role, r]) => [
          role,
          {
            claimant: r.claimant,
            guardians: r.guardians,
            delay: r.delay,
            pending: tree(r.pending, [r.pending.claim, ...r.pending.clawbacks, r.pending.cancel]),
            quarantine: tree(r.quarantine, [r.quarantine.admin]),
            initiateProgram: hex.encode(r.initiateProgram),
            clawbackProgram: hex.encode(r.clawbackProgram),
          },
        ]),
      ),
    }
  })
  writeFileSync(
    new URL('../../src/lib/vault/program/ledger-family-vectors.json', import.meta.url),
    await format(JSON.stringify(vectors), {
      ...(await resolveConfig(root + 'src/lib/vault/program/ledger-family-vectors.json')),
      parser: 'json',
    }),
  )
} finally {
  await vite.close()
}
