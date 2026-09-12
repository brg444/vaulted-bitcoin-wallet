import { defineConfig, mergeConfig, searchForWorkspaceRoot } from 'vite'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import baseConfig from './vite.config'
import { vaultWorkerBuildFixture } from './src/test/e2e-vault/fixtures/vaultWorkerBuilds'

const config = mergeConfig(baseConfig, { plugins: [vaultWorkerBuildFixture()] })
export default defineConfig({
  ...config,
  // mergeConfig ignores null overrides; assign after merging to disable the
  // watcher during funded drills and preserve active passkey/batch sessions.
  server: {
    ...config.server,
    fs: {
      ...config.server?.fs,
      // Dedicated worktrees can share the installed packages through a symlink.
      // Vite must serve the resolved font files as well as optimized modules.
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        realpathSync(fileURLToPath(new URL('./node_modules', import.meta.url))),
      ],
    },
    ...(process.env.VAULT_LIGHT_LIVE === 'mutinynet' ? { watch: null, hmr: false } : {}),
  },
})
