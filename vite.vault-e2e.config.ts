import { defineConfig, mergeConfig } from 'vite'
import baseConfig from './vite.config'
import { vaultWorkerBuildFixture } from './src/test/e2e-vault/fixtures/vaultWorkerBuilds'

const config = mergeConfig(baseConfig, { plugins: [vaultWorkerBuildFixture()] })
export default defineConfig({
  ...config,
  // mergeConfig ignores null overrides; assign after merging to disable the
  // watcher during funded drills and preserve active passkey/batch sessions.
  server: { ...config.server, ...(process.env.VAULT_LIGHT_LIVE === 'mutinynet' ? { watch: null, hmr: false } : {}) },
})
