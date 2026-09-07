# Dependency checks

Install the locked dependency graph before auditing it:

```sh
pnpm install --frozen-lockfile
pnpm audit --prod
pnpm build:mutinynet
pnpm build:mainnet
```

[package.json](../package.json) contains the current dependency overrides,
including `ws`. [CI](../.github/workflows/vault.yml) runs the production audit.
Use the audit output for the checked-out lockfile; a past result is not a
statement about currently published advisories.

The vendored SDK's provenance and checksum are documented in
[its origin file](../vendor/arkade-os-sdk-ORIGIN.md). Validate both dependency
compatibility and the compiled app and worker when changing that archive.
