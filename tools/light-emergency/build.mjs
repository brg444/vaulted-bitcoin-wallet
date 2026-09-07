import { buildRecoveryArtifacts } from '../emergency-build.mjs'
await buildRecoveryArtifacts({
  entry: 'tools/light-emergency/recover.ts',
  html: 'tools/light-emergency/index.html',
  output: process.env.LIGHT_RECOVERY_OUTPUT || '.vault-browser-tests/light-recovery',
  buildScript: 'tools/light-emergency/build.mjs',
})
