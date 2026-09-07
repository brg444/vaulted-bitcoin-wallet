# SDK and dependency integration

The wallet and swap package resolve one vendored `@arkade-os/sdk` build through
[package.json](../package.json) and [pnpm-lock.yaml](../pnpm-lock.yaml).
The archive is [vendor/arkade-os-sdk.tgz](../vendor/arkade-os-sdk.tgz).
Its source revisions, compatibility patches, and checksum are recorded in
[the provenance file](../vendor/arkade-os-sdk-ORIGIN.md).

The SDK supplies persistent Wallet and Contract Manager behavior, VTXO and
transaction repositories, intents, batch coordination, and Operator transport.
The vendored build includes the named boarding and worker identity interfaces
used by Vaulted. The current swap dependency is `@arkade-os/swap` 0.0.10.

## Required integration behavior

Dependency changes must preserve these contracts:

1. Protected Spending outputs remain excluded from generic SDK spending.
2. Worker identity and storage remain isolated by wallet and named program.
3. Boarding settles only to the enrolled Spending destination and supplies the
   signed final transaction tree required by Guardian verification.
4. Intent persistence and ambiguous submission recovery use stock Operator
   interfaces and retain the same transaction identity.
5. The page's unlocked device key is not persisted in the worker repositories.
6. Recovery capture retains complete transaction paths, and Lightning refunds
   remain bound to the enrolled Spending script.

A published SDK version is not interchangeable solely because its version
number is newer. Check the interfaces and rerun the contract, worker,
transaction, and recovery tests when replacing the archive. Preserve upstream
license and provenance files.
