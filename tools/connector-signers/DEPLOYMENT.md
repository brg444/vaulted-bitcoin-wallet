# Savings connector release preparation

Deploy the wallet, Guardian and pinned offline recovery companion as a reviewed
release. New connector enrollments use `savings-connector-dual-v2`; existing
wallets continue to use their enrolled scripts, signer origins and recovery
paths. This release requires no fund migration or Emulator change.

[Ledger approval](LEDGER.md) documents the hardware-first flow, independent
Emulator proof, transaction layout and qualification limits. The first prepared
Savings deposit includes two 500-sat reserves. After hardware approval, the
wallet fills the packet and persists the final candidate before requesting
passkey and service signatures. Retries retain all three input reservations.

## Release gates

Require wallet unit, type, formatting, lint, build and browser checks, plus the
Guardian check, race, lint, vulnerability and image gates. Both repositories
must carry identical network Contract Packs. Verify the shared connector
vectors and current-Emulator qualification; retain the v1 vectors unchanged.

The offline companion must pass its complete suite with `WALLET_ROOT` pointing
to the installed release wallet. Build both network bundles from clean wallet
source into a temporary output directory, then copy them into the companion.
Verify each manifest's revision, input hashes and bundle hash before committing
the companion and updating the wallet submodule pointer.

## Activation

Stage and hash the Linux Guardian binary while the current service remains
running. Preserve the existing client origin, RP ID, network and signer pins,
database, and independent policy sequence. Take and verify a consistent SQLite
backup; never roll the independent sequence backward.

Guardian removes its plaintext signing key after loading it. Stopping it
requires the operator to run the existing interactive unlock procedure before
service can resume. Once the operator is present, stop the service, install the
verified staged binary and run `/usr/local/sbin/vaulted-guardian-unlock` in a real
SSH terminal. Passphrases belong only in those prompts.

Require mainnet readiness with schema 5 and the new connector capability before
promoting the paired wallet. Verify its compiled network policy and release
identity, then check that an existing v1 wallet still opens correctly. Keep
every enrolled contract intact throughout activation.

Use a separate v2 enrollment for the funded Ledger qualification: compare the
signer address, prepare the combined deposit, and wait for confirmation. Verify
the displayed recipient, amount, change and fee during approval. Exercise a
withdrawal and a reload or lost-response retry, confirm acceptance by the real
broadcast endpoint, then spend the returned reserves again. Physical-device
approval and production relay acceptance require this funded check.

After a v2 enrollment or authorization has been issued, retain a Guardian
version that understands it. Reverting only the web deployment does not erase
those contracts or their operation history; an older runtime is not a safe
rollback target.
