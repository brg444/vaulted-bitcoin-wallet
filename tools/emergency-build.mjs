import { createRequire } from 'node:module'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
export async function buildRecoveryArtifacts({ entry, html, output, buildScript }) {
  for (const network of ['mainnet', 'mutinynet']) {
    const dir = resolve(output, network)
    await mkdir(dir, { recursive: true })
    const defines = {
      'import.meta.env': { VITE_VAULT_RELEASE_NETWORK: network, PROD: true },
      __VAULT_E2E_OPERATOR_ORIGIN__: '',
    }
    const built = await build({
      metafile: true,
      entryPoints: [entry],
      outfile: resolve(dir, 'recovery.js'),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: ['safari18', 'chrome132'],
      sourcemap: true,
      define: Object.fromEntries(Object.entries(defines).map(([key, value]) => [key, JSON.stringify(value)])),
    })
    await copyFile(html, resolve(dir, 'index.html'))
    await writeFile(
      resolve(dir, 'manifest.json'),
      JSON.stringify(
        {
          network,
          sha256: digest(resolve(dir, 'recovery.js')),
          wallet: 'brg444/vaulted-bitcoin-wallet',
          walletRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
          entry,
          inputs: Object.fromEntries(
            Object.keys(built.metafile.inputs)
              .filter((path) => !path.startsWith('<'))
              .sort()
              .map((path) => [path, digest(path)]),
          ),
          defines,
          buildScriptSha256: digest(buildScript),
          buildHelperSha256: digest('tools/emergency-build.mjs'),
          htmlSha256: digest(resolve(dir, 'index.html')),
          sourceMapSha256: digest(resolve(dir, 'recovery.js.map')),
        },
        null,
        2,
      ) + '\n',
    )
  }
}
