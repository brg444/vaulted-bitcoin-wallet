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
- Previous tarball SHA-256: `8d8de2d60576433fd981c8f469adfa11a566741e35f218e398414d8f3c5ce6e8`.

## Preserve signed tree metadata

The previous archive was built from `552106239d9ebfadd56e79c1a5286951029e97b1`,
whose parent is the signed boarding build `0481df63db88f4de6fa527d27e472fa6bf97755b`.
The [source patch and synthetic regression fixtures](patches/retain-tree-metadata.patch)
retain cosigner and expiry PSBT metadata when batch signature events update a
tree input. Guardian still verifies the signed tree with its existing checks.

Previous tarball SHA-256:
`baf08f891e4a3e9dbad57d8fa731c47c0b57b69662688bb4a163765810c21b9d`.
Build and pack commands remain those listed above. The wallet regression tests
exercise both single-receiver and shared trees through the installed SDK's
batch event handler, checking preserved metadata, signatures and transactions.

SDK qualification passed 71 focused tests, including the signed tree regression,
SQLite migrations, boarding adapters, expiry, recipients and persistence. Fourteen
compatibility-fixture failures in that full SDK suite also reproduced on
the unchanged parent; that checkpoint did not pass the full SDK suite. Synthetic
signed trees passed the unchanged Guardian finalization verifier, while missing
metadata and missing or corrupt signatures were rejected.

## Account settlement sessions

The current archive is built from `62760cc734537f143c72f57f2506503fc857ed7d`,
with the metadata-preserving source above as its parent. The complete
[source patch and tests](patches/account-settlement-session.patch) extract SDK
intent signing and batch execution from Wallet into a reusable settlement
session. Existing Wallet methods call the same implementation, including named
boarding validation and finalization. A settlement session borrows the account's
contract reader and creates no Wallet, repository, manager or observer.

Explicit settlement inputs must all resolve to registered contracts before
signing. Operator network, checkpoint key/delay, batch expiry, recipient, tree
and forfeit checks remain in the SDK. Eight intent proofs and one unsigned
forfeit captured from the unchanged parent provide fixed byte expectations;
tests also verify the resulting signatures independently.

The three 0.4.67 compatibility source files above remain unchanged. Their older
tests now exercise identity-key refunds with one address read, while claim
secrets retain HD allocation and deterministic preimage checks. Foreign signer
rejection remains covered. The skipped self-transfer history fixture now
includes its spent input and verifies the original receipt without another
payment. SDK qualification passes all 2,772 unit tests with zero skips,
typecheck, formatting, source guards, runtime/declaration builds and the
distribution smoke check. SQLite tests require the better-sqlite3 native
binding after installing dependencies with scripts disabled.

Current tarball SHA-256:
`8e348b0f8e77cf9080146447355ad0976f3673949eb09c7080bd7241827c2582`.
Build and pack commands remain those listed above, using Node 24.15.0 and
pnpm 10.25.0. Wallet integration, worker lifecycle, both network builds and
recovery companion qualification must bind this archive before release.
