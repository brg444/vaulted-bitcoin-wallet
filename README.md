# Vaulted

Vaulted is a Bitcoin wallet with passkey access, Spending limits, and separate
Savings. It supports mainnet and Mutinynet builds. Available setup choices and
admission requirements come from the connected Guardian.

[Open Vaulted RC](https://rc.getvaulted.xyz) · [Documentation](docs/README.md)
· [Guardian](https://github.com/brg444/arkade-runtime)
· [Emergency recovery](https://github.com/brg444/vaulted-emergency-recovery)

## Wallet modes

| Mode     | Spending                                                                       | Savings                                                              |
| -------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Light    | Passkey-owned Spending with an immutable policy and a delayed owner exit       | Watch-only Bitcoin account                                           |
| Standard | Policy-controlled Spending; delayed exit requires the device and hardware keys | Savings with device, external signer, and enrolled service approvals |
| Advanced | Policy-controlled Spending; delayed exit requires hardware and recovery keys   | Savings with an additional, separate recovery key                    |

Standard and Advanced Spending support Arkade payments and onchain receipt
through the enrolled boarding program. Their outbound Lightning support is a
build-enabled capability; the mainnet build enables it. Light receives and pays
through Arkade. Lightning receive is unavailable.

New Savings connector enrollments use two 500-sat signer reserves. The external
signer approves the transaction before the passkey and online services. Existing
vaults retain the scripts and signing order selected at enrollment. See
[programs](docs/program.md) and [signer compatibility](docs/connector-signers.md)
for the differences and device requirements.

Per-payment and rolling 24-hour limits are fixed at enrollment. Admission may
be open or invitation-based; the wallet follows the Guardian's advertised mode.
Standard and Advanced require a public signer descriptor, imported by QR,
file upload, or an explicitly selected paste field. Private hardware and
recovery keys remain in their signing devices.

## Backups and recovery

The Security page provides keys, backups, limits, renewal coverage, and recovery
access. Light creates an encrypted cloud backup during automatic setup.
Standard and Advanced can save encrypted recovery archives and public Recovery
Kits. Keep a separate copy and preserve access to the original passkey.

An archive covers its capture time. Later receipts, payments, and renewals need
updated transaction paths. A public Recovery Kit cannot replace missing paths
or a missing key. Recovery may require Bitcoin fees, waiting periods, and
additional signing keys or existing service approvals.

Follow [recovery with saved files](docs/emergency-recovery.md) for the supported
paths and the standalone companion. The [security model](docs/security.md)
explains the online cosigner, browser, backup, and hardware assumptions.

## Development

Use the Node.js version in [CI](.github/workflows/vault.yml), pnpm as pinned in
[package.json](package.json), and a checkout with its recovery submodule:

```sh
git clone --recurse-submodules https://github.com/brg444/vaulted-bitcoin-wallet.git
cd vaulted-bitcoin-wallet
pnpm install --frozen-lockfile
pnpm start
```

The development server listens at `http://localhost:3003`. The development
configuration targets Mutinynet. A local Guardian gateway secret, when needed,
is supplied as `VAULT_GATEWAY_SECRET`; never prefix a private secret with
`VITE_`, because those variables are compiled into browser code.

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
pnpm exec playwright install chromium webkit
pnpm test:e2e
pnpm build:mutinynet
pnpm build:mainnet
```

Generic `pnpm build` requires an explicit network. Use the named build commands
above to select it for both the app and worker. [Testing](docs/testing.md)
describes browser fixtures, visual baselines, and optional integration tests.
[Dependencies](docs/upstream-alignment.md) records the vendored SDK boundary.

Report vulnerabilities through [SECURITY.md](SECURITY.md).
