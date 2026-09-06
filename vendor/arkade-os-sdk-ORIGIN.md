# Vendored @arkade-os/sdk

Exact reviewed pin used by Vaulted Lightning SEND RC.

- Base: `arkade-os/ts-sdk` commit `f0fd58d5` (`codex/vault-board-v2-sdk-seam`), package version 0.4.66.
  This lineage owns Vaulted boarding (`createBoardingProgramScript`, worker-owned identity, worker stop).
- Cherry-picked from `@arkade-os/sdk@0.4.67` (`613bacbf`):
  - `packages/ts-sdk/src/script/vhtlc.ts` — ninth leaf `nonInteractiveRefund.withoutReceiver`
  - `packages/ts-sdk/src/contracts/handlers/vhtlcV2.ts` — persist `nonInteractiveRefundWithoutReceiver=1`
  - `packages/ts-sdk/src/wallet/contractSecrets.ts` — `provisionRefundKey` reuses wallet identity and returns `pkScript`/`address`

Do not replace this with published npm 0.4.67: that release does not export the Vaulted boarding seam.
Do not replace this with npm 0.4.68 / swap 0.0.11: that release refactors VHTLC to `nonInteractiveParameters`.

## Signed boarding recovery evidence

- Rebuilt from `0481df63db88f4de6fa527d27e472fa6bf97755b` on `codex/vaulted-signed-boarding-final`.
- Parent `b85d9de6` preserves the three compatibility source files listed above on the original `f0fd58d5` base.
- Named boarding now submits the final signed VTXO tree, retaining the captured batch identity, commitment, expiry, recipients, and tree topology. Guardian verifies the aggregate signatures before co-signing.
- Candidate rebuilt with Node 24.15.0. Build: `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm -C packages/ts-sdk pack --pack-destination <output>`. The pack hook builds runtime and declarations and runs the distribution smoke check.
- Tarball SHA-256: `8d8de2d60576433fd981c8f469adfa11a566741e35f218e398414d8f3c5ce6e8`.
