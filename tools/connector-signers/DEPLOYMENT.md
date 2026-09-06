# Savings connector release preparation

The [accepted implementation sequence](https://github.com/brg444/arkade-runtime/blob/codex/hardware-connector-rc/docs/connector-first.md)
ships the onchain Savings connector against the current Guardian stack first.
The later Guardian refactor replaces its forked execution/signing code with the
upstream embedded engine after PR 102 merges. It is independent of this work.
Native Savings and the direct multisig proposal are inactive; fund migration is
deferred.

Retain the [Sparrow](SPARROW.md) and [Electrum](README.md) adapters as qualification
tools for conventional P2WPKH/BIP86 inputs beside finalized Savings. Their
results cover component tests; physical hardware compatibility and a complete
live payment flow remain separate qualifications.

The candidate integrates versioned enrollment, a public-descriptor signer
import, authenticated Guardian authorization, the existing external Emulator,
and complete payment screens. The wallet persists the exact candidate and
phone signature before dispatch, finalizes Savings before exporting, and saves
the verified raw transaction before broadcast. Reload and lost responses resume
that retained operation.

The schema-3 Guardian ledger authenticates connector origins and operation rows
before use. It records authorization before signing, advances the independent
policy sequence, and resolves reservations only from canonical transaction
evidence. Timeouts and unconfirmed conflicts preserve ownership. Spending
allowances remain specific to Spending.

Connector Recovery Kits and version-5 passkey bindings preserve the full
Savings and boarding identity. The standalone recovery companion reconstructs
the actual connector Savings tree and existing recovery paths. Legacy kits,
version-4 bindings, original Savings, and Light state retain their contracts.

The [RC deployment runbook](https://github.com/brg444/arkade-runtime/blob/codex/hardware-connector-rc/docs/connector-rc-deployment.md)
requires paired runtime and wallet revisions, an operator-assisted Guardian
unlock, and a funded check against the production broadcast endpoint before
opening enrollment. Schema 3 requires a compatible runtime; an old binary and
an older database snapshot cannot safely replace issued authorization history.

Connector enforcement requires at least one honest online cosigner. Phone plus
all required online signing keys can bypass the program; that accepted
limitation remains covered by the original counterexample tests. The later
Guardian engine refactor must preserve both successful connector fixtures and
these trust-boundary results.

Existing funded wallets retain their scripts and recovery tooling. No connector
enrollment or release activation follows from documentation or local tests.
