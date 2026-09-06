import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
await build({
  entryPoints: ['tools/light-qualification/run.ts'],
  outfile: '.vault-browser-tests/light-drill.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  define: { 'import.meta.env': '{"VITE_VAULT_RELEASE_NETWORK":"mutinynet"}', __VAULT_E2E_OPERATOR_ORIGIN__: '""' },
})
