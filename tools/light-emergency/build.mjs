import { createRequire } from 'node:module'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const output = resolve(process.env.LIGHT_RECOVERY_OUTPUT || '.vault-browser-tests/light-recovery')
for (const network of ['mainnet', 'mutinynet']) {
  const dir = resolve(output, network)
  await mkdir(dir, { recursive: true })
  const built = await build({
    metafile: true,
    entryPoints: ['tools/light-emergency/recover.ts'],
    outfile: resolve(dir, 'recovery.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['safari18', 'chrome132'],
    sourcemap: true,
    define: {
      'import.meta.env': JSON.stringify({ VITE_VAULT_RELEASE_NETWORK: network, PROD: true }),
      __VAULT_E2E_OPERATOR_ORIGIN__: '""',
    },
  })
  await copyFile('tools/light-emergency/index.html', resolve(dir, 'index.html'))
  const sha256 = createHash('sha256')
    .update(readFileSync(resolve(dir, 'recovery.js')))
    .digest('hex')
  await writeFile(
    resolve(dir, 'manifest.json'),
    JSON.stringify(
      {
        network, sha256,
        wallet: 'brg444/vaulted-bitcoin-wallet',
        walletRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
        entry: 'tools/light-emergency/recover.ts',
        inputs: Object.fromEntries(Object.keys(built.metafile.inputs).filter((path) => !path.startsWith('<')).sort().map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
        defines: { 'import.meta.env': { VITE_VAULT_RELEASE_NETWORK: network, PROD: true }, __VAULT_E2E_OPERATOR_ORIGIN__: '' },
        buildScriptSha256: createHash('sha256').update(readFileSync('tools/light-emergency/build.mjs')).digest('hex'),
        htmlSha256: createHash('sha256').update(readFileSync(resolve(dir, 'index.html'))).digest('hex'),
        sourceMapSha256: createHash('sha256').update(readFileSync(resolve(dir, 'recovery.js.map'))).digest('hex'),
      },
      null,
      2,
    ) + '\n',
  )
}
