# Vendored @arkade-os/sdk

Source provenance for the SDK archive consumed by the wallet and swap package.

- Base: `arkade-os/ts-sdk` commit `f0fd58d5`, package version 0.4.66.
  This lineage owns Vaulted boarding (`createBoardingProgramScript`, worker-owned identity, worker stop).
- Cherry-picked from `@arkade-os/sdk@0.4.67` (`613bacbf`):
  - `packages/ts-sdk/src/script/vhtlc.ts` — ninth leaf `nonInteractiveRefund.withoutReceiver`
  - `packages/ts-sdk/src/contracts/handlers/vhtlcV2.ts` — persist `nonInteractiveRefundWithoutReceiver=1`
  - `packages/ts-sdk/src/wallet/contractSecrets.ts` — `provisionRefundKey` reuses wallet identity and returns `pkScript`/`address`

Published npm 0.4.67 lacks the required Vaulted boarding interfaces.
npm 0.4.68 / swap 0.0.11 changes the VHTLC interface to `nonInteractiveParameters` and requires an adapter update.

## Signed boarding integration

- Rebuilt from `0481df63db88f4de6fa527d27e472fa6bf97755b`.
- Parent `b85d9de6` preserves the three compatibility source files listed above on the original `f0fd58d5` base.
- Named boarding now submits the final signed VTXO tree, retaining the captured batch identity, commitment, expiry, recipients, and tree topology. Guardian verifies the aggregate signatures before co-signing.
- Archive rebuilt with Node 24.15.0. Build: `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm -C packages/ts-sdk pack --pack-destination <output>`. The pack hook builds runtime and declarations and runs the distribution smoke check.
- Tarball SHA-256: `8d8de2d60576433fd981c8f469adfa11a566741e35f218e398414d8f3c5ce6e8`.
