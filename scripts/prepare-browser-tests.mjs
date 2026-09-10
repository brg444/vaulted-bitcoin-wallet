import { readdirSync, existsSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

// These Node-side fixtures import wallet modules containing Vite's import.meta.env.
// Bundle only the test harness; the browser still loads the real application through Vite.
const require = createRequire(import.meta.url)
const viteRequire = createRequire(require.resolve('vite/package.json'))
const { build } = viteRequire('esbuild')
const tests = readdirSync('src/test/e2e-vault').filter((name) => name.endsWith('.test.ts'))
if (existsSync('.vault-browser-tests'))
  for (const name of readdirSync('.vault-browser-tests'))
    if (name.endsWith('.test.ts') && !tests.includes(name)) unlinkSync(resolve('.vault-browser-tests', name))
for (const name of ['globalSetup.ts', ...tests]) {
  await build({
    entryPoints: [resolve(`src/test/e2e-vault/${name}`)],
    outfile: resolve(`.vault-browser-tests/${name}`),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
    define: { 'import.meta.env': '{}' },
  })
}
