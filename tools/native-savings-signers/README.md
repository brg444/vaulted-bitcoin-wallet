# Native Savings tests

These isolated regtest and source-level tests assess the original `phone-hww-recovery-savings-v1` contract; [the assessment](../../docs/native-savings-signers.md) records the results and remaining release gates.

The separate `ledger-candidate.*` harness assesses a new Ledger-compatible contract described in [the candidate design](../../docs/ledger-native-savings-design.md). It calls the wallet's new key and native policy constructors. The new contract changes derived keys and addresses and remains outside live enrollment and execution.

The recorded results use the wallet's actual tree generator. `core.mjs` maps its CHECKSIG leaves to an exact full descriptor, checks script equality, signs funded regtest spends and tests recipient mutation. `specter.py` executes Specter DIY's parser, wallet manager review preparation, and streaming PSBT signing with public HD fixtures. Its GUI and persistence are stubbed; its signing functions are unchanged. `verify-specter.mjs` merges the returned partial PSBT with the original and validates the complete transaction in Core.

## Core and Specter

Install the wallet's pinned dependencies and use Node 24. Start a disposable Core container with no network:

```sh
docker run -d --name vaulted-native-core-qualification --network none \
  btcpayserver/bitcoin:31.0 bitcoind -regtest -server -networkactive=0 \
  -rpcuser=native-fixture -rpcpassword=disposable-local-test \
  -fallbackfee=0.00001 -txindex=1
node tools/native-savings-signers/core.mjs
```

The RPC password above is a public fixture value for this isolated container. No RPC port is published. Container startup must finish before the script runs. The script creates fresh fixture wallets on each run; transaction IDs change as the regtest chain advances.

Clone Specter DIY at `b2d87e55338289a258ee985b26c7b064d5b49132`, initialize its `f469-disco` submodule and that submodule's `libs/common/embit`. Use Python with the source dependencies available. The harness puts the pinned embit submodule ahead of installed packages.

```sh
python tools/native-savings-signers/specter.py /absolute/path/to/specter-diy
node tools/native-savings-signers/verify-specter.mjs
```

Inspect `evidence/core.json` and `evidence/specter.json`. The hardware fixture derives from 32 bytes of `0x42`; phone and cosigner fixtures are public scalars from the repository. Never substitute a user seed. The descriptor uses the real HD parent and the enrolled index zero, preserving the native Savings script at that index. Other descriptor indices are not valid enrolled Vaulted destinations.

## Ledger

The existing [Ledger build instructions](../connector-signers/LEDGER.md) describe the Speculos app used here. They document a different contract's tests; only the evidence in this directory concerns native Savings registration.

Copy `ledger.py` and `evidence/ledger-inputs.json` into the fixture container as `/native-savings-20260908/ledger.py` and `/native-savings-20260908/core.json`. Run the Python script inside that container using the qualified app ELF at `/app/build/nanos2/bin/app.elf`, then retrieve `/native-savings-20260908/ledger.json` for inspection.

The script expects three registration failures and one successful derived-policy control. The control is not a Savings contract. Its success proves the simulator can register supported policies; it does not establish native Savings signing or recipient display. The recorded Ledger inputs use the original scalar hardware fixture, while the later Core/Specter fixtures use the public HD fixture. Both use the same contract generator and complete tree shape.

## New Ledger candidate

The [Guardian-only qualification record](evidence/ledger-guardian-qualification.json)
identifies current source hashes, test results and remaining release gates.

Generate the complete Standard and Advanced candidate policies and PSBTs with public fixtures:

```sh
node tools/native-savings-signers/ledger-candidate.mjs
docker cp tools/native-savings-signers/ledger-candidate.py vaulted-ledger-speculos:/native-savings-20260908/ledger-candidate.py
docker cp tools/native-savings-signers/evidence/ledger-candidate-inputs.json vaulted-ledger-speculos:/native-savings-20260908/ledger-candidate-inputs.json
docker exec vaulted-ledger-speculos python /native-savings-20260908/ledger-candidate.py
docker cp vaulted-ledger-speculos:/native-savings-20260908/ledger-candidate-all.json tools/native-savings-signers/evidence/ledger-candidate.json
node tools/native-savings-signers/verify-ledger-candidate.mjs
```

The container uses the same pinned Ledger build described above, with the native fixture directory created before copying files. The generator needs this wallet's installed dependencies. The runner bounds each tier to 900 seconds and can select one tier with `CANDIDATE_TIER=standard` or `advanced`, writing the corresponding result filename. It caches successful registration authorization inside the disposable container and binds reuse to the exact policy and keys.

The current `ledger-candidate.json` records the implementation's complete simulator run. `ledger-candidate-initial.json` preserves the earlier prototype's diagnostic trace, whose ad hoc chain codes differ from the implementation. The verifier independently checks the signatures, DEFAULT/ALL restriction, exact recipient/amount/fee screen text, output-mutation failures and finalized sizes. Both tiers passed full and partial signing, measuring 169 and 212 vB respectively.

Candidate parents are synthetic. These tests establish simulator registration, derivation and normal signing, while funded acceptance, recovery and physical review remain separate release requirements. Wallet tests now cover subsequent change spending, mixed receive/change inputs, malicious metadata rejection and adapter cancellation. Device and funded lifecycle qualification remain required. The generator now uses the complete new recovery family. The Guardian named authorization capability and complete lifecycle remain separate qualification gates.

`ledger-key-vectors.mjs` regenerates the reviewed public derivation vectors at `src/lib/vault/program/ledger-key-vectors.json`. The same bytes live in the runtime's `internal/vault/savings/testdata/ledger-key-vectors.json`. Wallet and Go tests independently verify account derivations, Guardian parents, policy templates and output scripts, including private/public derivation agreement. Fixture regeneration requires comparing both repositories; changed golden values represent a contract change.

```sh
node tools/native-savings-signers/ledger-key-vectors.mjs
pnpm exec prettier --write src/lib/vault/program/ledger-key-vectors.json
pnpm exec vitest run --maxWorkers=2 src/lib/vault/program src/lib/vault/savingsSpend.test.ts
```

Initialize the pinned `tools/offline-recovery` submodule before running the wallet's Recovery Kit tests or typecheck. Copy the formatted vector file into the runtime fixture path before running `go test -race ./internal/vault/savings` and `go vet ./internal/vault/savings` there.

## Sparrow and Electrum

Build the pinned Sparrow 2.5.4 Drongo classpath as described in [SPARROW.md](../connector-signers/SPARROW.md). Run `SparrowNative.java` with JDK 25, the generated classpath and a complete descriptor on standard input. Both raw descriptors from `evidence/ledger-inputs.json` were rejected. `evidence/sparrow.json` records the output; no GUI signing test followed the failed import.

For Electrum 4.8.1, call `electrum.descriptor.parse_descriptor` on the complete descriptors from `evidence/core.json` in its Python environment. `evidence/electrum.json` records the failure. Parser rejection is a compatibility result, not a failure of Bitcoin validation.

BitBox, Jade, COLDCARD, Krux and Trezor findings rely on the pinned source reviews linked in the assessment, with firmware execution remaining outside this harness.

## Remaining qualification

The Ledger candidate still requires physical registration and screen review, persistent wallet reload, cancellation/reconnect handling and an integrated recovery lifecycle using the signing services. Its chosen transport is desktop WebHID. Other signer assessments retain their own transport-specific qualification requirements.

## Native wallet client and UI checks

The candidate PSBT generator calls `ledgerSavings.ts`, including its parent checks
and phone HD signing. `ledgerClient.ts` uses the official JavaScript client;
registration metadata is tied to the exact policy and reconstructed addresses.
Its Node tests avoid the separate typed-array realms introduced by jsdom.

```sh
pnpm exec vitest run --maxWorkers=2 src/lib/vault/ledgerSavings.test.ts src/lib/vault/ledgerClient.test.ts src/screens/Vault/LedgerSavingsApproval.test.tsx
node tools/native-savings-signers/ledger-client-browser.mjs
```

The browser check uses Chromium and a simulated transport to exercise the real
client serializer and registration validation. Its evidence records that limited
scope. It never opens a USB device or signs with a real wallet. The candidate UI
is prepared for coordinator integration and stays outside live enrollment until
the full recovery and release gates pass.

## Complete Ledger recovery family

`ledger-family-vectors.mjs` generates the complete public contract vectors for
both networks and tiers. Copy `src/lib/vault/program/ledger-family-vectors.json`
unchanged into the runtime Savings testdata directory. These vectors complement
the original key-derivation fixtures.

```sh
node tools/native-savings-signers/ledger-family-vectors.mjs
node tools/native-savings-signers/ledger-recovery-core.mjs
node tools/native-savings-signers/ledger-recovery-candidate.mjs
docker cp tools/native-savings-signers/evidence/ledger-recovery-inputs.json vaulted-ledger-speculos:/native-savings-20260908/ledger-recovery-inputs.json
docker cp tools/native-savings-signers/ledger-recovery.py vaulted-ledger-speculos:/native-savings-20260908/ledger-recovery.py
docker exec vaulted-ledger-speculos python /native-savings-20260908/ledger-recovery.py
docker cp vaulted-ledger-speculos:/native-savings-20260908/ledger-recovery-all.json tools/native-savings-signers/evidence/ledger-recovery.json
node tools/native-savings-signers/verify-ledger-recovery.mjs
```

The Core test requires the isolated container described above and accepts 37
funded spends. It independently compiles each policy into the expected script,
checks CSV maturity and rejects recipient substitutions. It also replaces ten
recovery initiations without an anchor, covering all claimants on receive and
change. Both the acting user and Guardian sign each fee increase. Its cosigner keys are
public fixtures used directly, bypassing service policy evaluation deliberately.

The recovery simulator runner tests eight policies containing the hardware key,
with eleven signing cases. Policies for quarantine after hardware-initiated
recovery belong to the remaining authorities and are exercised by the Core test.
The verifier checks the hardware signature, displayed destination, amount and
fee, output commitment and final transaction construction. Its synthetic parents
and locally supplied Guardian signatures leave the actual service lifecycle
unqualified. Run the normal and recovery simulator harnesses sequentially because
they use the same emulator ports.

The current candidate identity is `phone-ledger-guardian-savings-v1`. Standard
registers four key records and Advanced registers five; recovery needs a user
authority and Guardian. A compromised pair can bypass the pending stage. The
public Emulator has no signature in this new Savings contract, while the earlier
funded contracts retain their original requirements. Re-run every candidate
harness after a script or derivation change; historical JSON cannot qualify a
new contract.

## Guardian transaction and phone backup checks

`ledgerRecovery.ts` prepares one-input, one-output transitions with the exact
pending or quarantine destination, verifies the user approval, and accepts only
the Guardian signature on the retained transaction. The detached phone proof
commits to the same transaction and prevout through a separate digest domain.

```sh
node tools/native-savings-signers/ledger-recovery-vectors.mjs
pnpm exec vitest run --maxWorkers=1 src/lib/vault/ledgerRecovery.test.ts src/lib/vault/ledgerPhoneBackup.test.ts
```

Copy `src/lib/vault/program/ledger-recovery-vectors.json` unchanged to the runtime's
`internal/application/testdata/ledger-recovery-vectors.json`, then run
`go test ./internal/application -run TestLedgerSavingsWalletRecoveryVectors`.
The fourteen vectors establish agreement on phone authorization, canonical
transaction size and user/Guardian key metadata across the two implementations.
The runtime also rejects changed derivation indices, branches, fingerprints
and leaf hashes. Its separate key-capability tests exercise actual signing and
Bitcoin script validation with the new per-vault root.

The phone backup tests cover both networks, tiers and encryption purposes,
wrong context and key material, tampering, exact origin verification and secret
cleanup. These primitives stay outside live enrollment and the existing recovery
package schema until their complete persistence and restore flow is qualified.
