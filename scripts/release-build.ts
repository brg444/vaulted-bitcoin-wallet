import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { loadEnv, type Plugin } from 'vite'
import { configuredReleaseNetwork } from '../src/lib/vault/network'

export function releaseCommit(): string {
  // Source uploads omit .git; hosted builds receive the exact uploaded revision.
  const commit = process.env.VERCEL_GIT_COMMIT_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Release requires a full Git commit SHA')
  return commit
}

// Both the app and worker must select a network before compiling policy code.
export function releaseBuild(emitManifest = false): Plugin {
  let network: string | undefined
  let features: Record<string, boolean> | undefined
  return {
    name: 'vault-release-network',
    config(_config, { command, mode }) {
      if (command !== 'build') return
      const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
      network = configuredReleaseNetwork(env.VITE_VAULT_RELEASE_NETWORK, true)
      if (env.VAULT_RELEASE_NETWORK && env.VAULT_RELEASE_NETWORK !== network) {
        throw new Error('Browser and gateway release networks disagree')
      }
      if (env.VERCEL) {
        if (!env.VAULT_RELEASE_NETWORK) throw new Error('Vercel requires VAULT_RELEASE_NETWORK')
        const config = JSON.parse(readFileSync('vercel.json', 'utf8'))
        if (
          config.buildCommand !== `pnpm build:${network}` ||
          (config.env?.VAULT_RELEASE_NETWORK && config.env.VAULT_RELEASE_NETWORK !== network)
        ) {
          throw new Error('Canonical vercel.json does not match the release network')
        }
      }
      const define: Record<string, string> = {
        'import.meta.env.VITE_VAULT_RELEASE_NETWORK': JSON.stringify(network),
      }
      if (network === 'mainnet') {
        // Local and hosted builds use the same checked-in feature configuration.
        // Missing shell flags must never switch the released wallet to older UI.
        const release = JSON.parse(readFileSync('vercel.mainnet.json', 'utf8')).env
        const flags = {
          lightOnlyEnrollment: 'VITE_VAULT_LIGHT_ONLY_ENROLLMENT',
          lightningSend: 'VITE_VAULT_LIGHTNING_SEND',
          lightningReceive: 'VITE_VAULT_LIGHTNING_RECEIVE',
          lightningAddress: 'VITE_VAULT_LNURL',
        }
        features = {}
        for (const [name, flag] of Object.entries(flags)) {
          if (!['true', 'false'].includes(release[flag])) throw new Error(`Release flag must be explicit: ${flag}`)
          define[`import.meta.env.${flag}`] = JSON.stringify(release[flag])
          features[name] = release[flag] === 'true'
        }
        // Guardian authenticates every enrolled wallet; the release has no per-wallet rollout list.
        define['import.meta.env.VITE_VAULT_LIGHTNING_RECEIVE_VAULT'] = 'undefined'
      }
      return { define }
    },
    generateBundle() {
      if (!emitManifest || !network) return
      const worker = readFileSync('public/vault-wallet-service-worker.mjs')
      this.emitFile({
        type: 'asset',
        fileName: 'release.json',
        source: JSON.stringify({
          network,
          commit: releaseCommit(),
          features,
          workerSha256: createHash('sha256').update(worker).digest('hex'),
        }),
      })
    },
  }
}
