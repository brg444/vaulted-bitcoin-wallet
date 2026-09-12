# Ledger Savings qualification

Vaulted's retained protected account uses `phone-ledger-guardian-savings-v1`.
Normal Savings payments require phone and Ledger signatures. Recovery initiation
requires a user authority and the Guardian; a compromised pair can bypass the
pending stage. The [design](../../docs/ledger-native-savings-design.md) and
[qualification record](evidence/ledger-guardian-qualification.json) identify the
contract and recorded test scope.

The fixtures use public deterministic keys. Keep user seeds, credentials and
funded-wallet data outside these harnesses. Simulator results establish the
recorded application behavior; physical Ledger review and funded service
lifecycle checks remain separate release gates.

## Wallet and browser checks

Use the wallet's installed, pinned dependencies and Node 24. Initialize the
`tools/offline-recovery` submodule before typecheck or Recovery Kit tests.

```sh
pnpm exec vitest run --maxWorkers=2 src/lib/vault/ledgerSavings.test.ts src/lib/vault/ledgerClient.test.ts src/screens/Vault/LedgerSavingsApproval.test.tsx
pnpm exec vitest run --maxWorkers=1 src/lib/vault/ledgerRecovery.test.ts src/lib/vault/ledgerPhoneBackup.test.ts
node tools/native-savings-signers/ledger-client-browser.mjs
```

The browser harness uses Chromium and a simulated transport to exercise the
client serializer and registration validation. Recovery package tests also
check separate Spending and Savings key envelopes, account origins, saved
registration and exact archive binding for both networks and protection tiers.

## Simulator inputs

Recorded Ledger runs used Bitcoin application 2.4.2 at
`2c7956fe566bd7f6f690288130033441fabc5f10`, compiled for Nano S Plus against
Secure SDK `473fe57b98c24ce9488b1dfecd51ad92fe665d19`, with Speculos 0.27.0.
The harness expects a disposable `vaulted-ledger-speculos` container containing
the application ELF at `/app/build/nanos2/bin/app.elf` and a writable
`/native-savings-20260908` fixture directory. Application build adjustments in
the recorded qualification affected include paths only.

Prepare that environment before running these commands. Normal and recovery
harnesses share emulator ports and run sequentially.

```sh
node tools/native-savings-signers/ledger-candidate.mjs
docker cp tools/native-savings-signers/ledger-candidate.py vaulted-ledger-speculos:/native-savings-20260908/ledger-candidate.py
docker cp tools/native-savings-signers/evidence/ledger-candidate-inputs.json vaulted-ledger-speculos:/native-savings-20260908/ledger-candidate-inputs.json
docker exec vaulted-ledger-speculos python /native-savings-20260908/ledger-candidate.py
docker cp vaulted-ledger-speculos:/native-savings-20260908/ledger-candidate-all.json tools/native-savings-signers/evidence/ledger-candidate.json
node tools/native-savings-signers/verify-ledger-candidate.mjs
```

The runner bounds each tier to 900 seconds and supports
`CANDIDATE_TIER=standard` or `advanced`. Cached registration authorization is
bound to the exact policy and keys. The verifier checks signatures, output
commitments, recipient/amount/fee screen text and finalized transaction size.
Synthetic parent transactions leave funded acceptance outside this check.

```sh
node tools/native-savings-signers/ledger-recovery-candidate.mjs
docker cp tools/native-savings-signers/evidence/ledger-recovery-inputs.json vaulted-ledger-speculos:/native-savings-20260908/ledger-recovery-inputs.json
docker cp tools/native-savings-signers/ledger-recovery.py vaulted-ledger-speculos:/native-savings-20260908/ledger-recovery.py
docker exec vaulted-ledger-speculos python /native-savings-20260908/ledger-recovery.py
docker cp vaulted-ledger-speculos:/native-savings-20260908/ledger-recovery-all.json tools/native-savings-signers/evidence/ledger-recovery.json
node tools/native-savings-signers/verify-ledger-recovery.mjs
```

The recorded recovery run covers fifteen signing cases across ten policies
containing the hardware key, including initiation from receive and change in
both tiers. The verifier checks the hardware signature, displayed destination,
amount and fee before adding the public fixture Guardian signature. This
locally supplied signature leaves the deployed Guardian lifecycle unqualified.

## Independent vectors

Committed expected bytes remain independent of ordinary test execution.
`ledger-key-vectors.mjs`, `ledger-family-vectors.mjs` and
`ledger-recovery-vectors.mjs` are tools for an explicitly reviewed contract
change. Regenerating expectations is excluded from normal cleanup validation.

The wallet and runtime copies of `ledger-key-vectors.json` and
`ledger-family-vectors.json` must match byte-for-byte. Their runtime locations
are in `internal/vault/savings/testdata`. Recovery authorization vectors match
`internal/application/testdata/ledger-recovery-vectors.json` in the runtime.
Compare all affected copies and review changed derived keys, scripts and
signed domains before accepting new expectations.

## Release gates

Qualification binds the source revision, SDK, contract vectors, device
application and recovery artifacts. A changed script or derivation requires
new qualification against that exact contract. Physical registration and
transaction review, persistent reload, cancellation/reconnect behavior,
funded fee handling and recovery from saved data require their documented
hardware or service environments.
