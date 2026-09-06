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

The next integration stages are exact two-input Guardian authorization, durable
wallet handoff state, versioned enrollment and Recovery Kit support, then payment
screens and complete funded qualification. Signed candidates must survive
reload and lost responses without releasing their inputs or replacing their
recipient. The existing whole-transaction signature verification remains the
boundary for signer responses.

Connector enforcement requires at least one honest online cosigner. Phone plus
all required online signing keys can bypass the program; that accepted
limitation remains covered by the original counterexample tests. The later
Guardian engine refactor must preserve both successful connector fixtures and
these trust-boundary results.

Existing funded wallets retain their scripts and recovery tooling. No connector
enrollment or release activation follows from documentation or local tests.
