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

Candidate parents are synthetic. These tests establish simulator registration, derivation and normal signing, while funded acceptance, recovery and physical review remain separate release requirements. Wallet tests now cover subsequent change spending, mixed receive/change inputs, malicious metadata rejection and adapter cancellation. Device and funded lifecycle qualification remain required. The recovery programs in the generator are mathematical fixtures from the existing family; service signing with the new derived keys and the complete recovery contract remain unimplemented.

`ledger-key-vectors.mjs` regenerates the reviewed public derivation vectors at `src/lib/vault/program/ledger-key-vectors.json`. The same bytes live in the runtime's `internal/vault/savings/testdata/ledger-key-vectors.json`. Wallet and Go tests independently verify account derivations, program parents, policy templates and output scripts, including private/public derivation agreement. Fixture regeneration requires comparing both repositories; changed golden values represent a contract change.

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

Physical registration, persistent wallet reload, actual screen review, QR/SD exchange, cancellation, and the complete funded recovery lifecycle remain release gates. Passing a signing-engine or source-level test does not satisfy those gates.

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
