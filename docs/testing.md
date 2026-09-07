# Testing

Use the Node.js and pnpm versions configured in [CI](../.github/workflows/vault.yml).
Initialize submodules and install the locked dependencies first.

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit --maxWorkers=2
pnpm exec playwright install chromium webkit
pnpm test:e2e
pnpm build:mutinynet
pnpm build:mainnet
node scripts/verify-mainnet-build.mjs
pnpm audit --prod
```

The named build commands select the same network for the app and worker.
An unqualified `pnpm build` needs an explicit network setting.

## Coverage

Unit tests cover program reconstruction, policy digests, transaction and
signature validation, durable operation state, backup integrity, and balances.
Cross-language fixtures bind the wallet and Guardian to the same scripts and
canonical data. Recovery companion checks use its pinned submodule.

Playwright tests use virtual authenticators and deterministic service fixtures.
They cover enrollment, PRF unlock, cancellation, restoration, worker isolation,
interrupted payments, recovery handoffs, and accessible UI flows. Physical-device behavior and production network settlement require separate
checks.

Some integration tests require an explicitly configured runtime, test network,
or signing application. Read each test's environment requirements before
running it. A skipped test is outside that run's coverage. Test keys and wallets
must remain disposable and separate from personal funds.

## Visual checks

Shared wallet tests compare Standard and Light with identical balances and
history. They cover mobile and desktop, both themes, safe areas, keyboard
viewports, enlarged text, and recovery navigation.

Review deliberate visual changes before updating baselines:

```sh
VAULT_UPDATE_SNAPSHOTS=1 pnpm test:e2e --update-snapshots
```

The workflow's `refresh_snapshots` input generates native Linux baselines.
After reviewing them, ordinary CI compares against the saved images without
regeneration. Keep layout assertions active when updating screenshots.

## Integration limits

Safari, installed-PWA, and physical authenticator checks remain necessary
alongside virtual passkeys. Software and firmware-simulator signing tests qualify only their stated
versions and transaction families. Network integration checks must exercise
confirmation, ambiguous responses, restart, fee funding, timelock maturity, and
recovery from saved data. Local fixtures alone cannot establish these outcomes
on a deployed network.

[Signer tests](../tools/connector-signers/README.md),
[Light qualification tools](../tools/light-qualification/README.md), and
[renewal tools](../tools/guardian-delegation-qualification/README.md) document
reproducible setups. Keep private keys and credentials out of test reports.
