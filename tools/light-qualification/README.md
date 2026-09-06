# Funded Light contract recovery drill

This opt-in tool funds a fresh Mutinynet Light script and exercises the application's recovery implementation with the pinned SDK. It does not perform runtime enrollment, policy-authorized payments, or renewal, so its result covers contract recovery only.

The tool creates random test keys and saves them in a private directory before requesting faucet funds. Nothing from that directory belongs in Git or a build artifact. Every action rejects non-Mutinynet state. Use a new absolute directory for a new drill and retain it until the recovered test funds have been accounted for.

```bash
node tools/light-qualification/build.mjs
export VAULT_LIGHT_DRILL_DIRECTORY=/absolute/private/test-directory
node .vault-browser-tests/light-drill.mjs prepare
node .vault-browser-tests/light-drill.mjs fund-fees
node .vault-browser-tests/light-drill.mjs execute
```

`prepare` requests 50,000 test sats once, discovers the actual output, and prepares an owner-signed exit package. It prints the Bitcoin fee address and estimated costs. Repeated preparation reuses the funded state and replaces the package, so wait until the active exit has stopped before preparing again.

`fund-fees` requests 10,000 test sats onchain. When that faucet route is unavailable, `offboard-fees` uses a separate disposable SDK wallet to receive 10,000 test sats and settle them to the fee address. Light outputs remain in their own contract. This command needs Node's EventSource support:

```bash
node --experimental-eventsource .vault-browser-tests/light-drill.mjs offboard-fees
```

Funding and submission attempts are recorded before dispatch. An uncertain attempt stops automatic repetition. Inspect the saved operation and provider state before retrying it; a failed HTTP response does not establish that no transaction was submitted.

`execute` reads the saved file and secret and rejects every network request outside the Mutinynet Bitcoin explorer. It records public execution events and request URLs in `events.json`, preserving the distinction between broadcasts, timelock waits, failures, and confirmed sweeps. Interrupting it stops iteration; executing the same file again resumes by checking the chain.

`status` reports the script's indexed outputs. Completion requires every sweep to confirm and the destination to receive the expected amount. Preserve transaction IDs and relevant logs as qualification evidence, while keeping the saved keys private.

## Funded mobile browser check

`playwright.light-live.config.ts` runs only with `VAULT_LIGHT_LIVE=mutinynet` and an absolute `VAULT_LIGHT_DRILL_DIRECTORY`. Its loopback HTTPS application uses the real public Mutinynet Operator and Bitcoin explorer. The Go browser harness must use `VAULT_LIGHT_BROWSER_LIVE=mutinynet`, address `127.0.0.1:18899`, and origin `https://localhost:3120`.

Use a fresh private directory for the enrollment and payment test. It saves the virtual passkey, owner backup, recovery secret, and destination key before requesting faucet funds. The second test uses those saved files to prepare an exit for the resulting change with no passkey. Run that test separately to resume qualification without requesting more faucet funds.

```bash
HTTPS=true VAULT_E2E_PORT=3120 VAULT_E2E_OPERATOR_PORT=18900 VAULT_LIGHT_LIVE=mutinynet pnpm exec playwright test -c playwright.light-live.config.ts --project='Mobile Chrome'
```

Set `VAULT_LIGHT_TEST_RENEWAL=1` to include fee review, real batch participation, reload/unlock, and recovery of the renewed output. The live configuration selects Mobile Chrome only. It disables hot reload so source edits cannot interrupt an active signing session. Each funding directory has an exclusive funding-attempt marker; a failed test must be investigated before another funded wallet is created.

For restart qualification, set the runtime's `VAULT_LIGHT_BROWSER_DIRECTORY` to an absolute private directory and retain it across harness restarts. This Mutinynet-only mode saves a random test cosigner key, the SQLite ledger, and a test policy sequence. Its integrity key remains a public test fixture, so this directory is unsuitable for a real deployment. The harness stops after 45 minutes. `VAULT_LIGHT_BROWSER_DISABLE_ENROLLMENT=1` starts it with Light enrollment disabled while retaining existing wallets.

Retain browser backups and prepared exit files after the harness ends. The virtual passkey export is diagnostic data; importing it into a new Chromium authenticator does not recreate the original PRF secret. Original-passkey restoration is checked with the original authenticator; all-passkeys-lost recovery uses the saved file and secret.


For an already prepared exit whose prerequisite has confirmed and whose owner-only delay is still pending, `VAULT_LIGHT_TEST_WAITING_EXIT=1` enables the focused browser check named `Light explains and pauses an existing Bitcoin recovery delay`. It imports `browser-offline-change-recovery.json`, verifies the visible deadline and confirmed step, then pauses and checks that the secret is cleared. Every Bitcoin POST is blocked during this UI check; the independent executor owns the funded exit.
