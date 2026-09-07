import { buildRecoveryArtifacts } from '../emergency-build.mjs'
await buildRecoveryArtifacts({
  entry: 'tools/program-emergency/recover.ts',
  html: 'tools/program-emergency/index.html',
  output: process.env.PROGRAM_RECOVERY_OUTPUT || '.vault-browser-tests/program-recovery',
  buildScript: 'tools/program-emergency/build.mjs',
})
