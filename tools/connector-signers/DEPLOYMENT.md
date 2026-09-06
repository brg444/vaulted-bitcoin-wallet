# Connector qualification and the contingency

The [canonical reconciliation](https://github.com/brg444/arkade-runtime/blob/codex/operator-gated-contingency/docs/contingency/connector-reconciliation.md)
assigns future Savings implementation and timelocked recovery to the native
contingency branch. This connector branch remains an isolated L1 experiment;
its contract is excluded from the native implementation.

Retain the [Sparrow](SPARROW.md) and [Electrum](README.md) adapters as reusable
qualification tools. Their current results cover a conventional P2WPKH/BIP86
input with finalized foreign Savings, not an admitted native transaction. Native
input ancestry, signing order, actual destination review, and complete recovery
require fresh tests. The reconciliation also keeps the original strict
hardware-compromise test separate from the later accepted honest-cosigner model.

The old L1 transaction builder, fixed reserve, output positions, fee layout, and
contract identity remain experimental choices. They impose no requirement on
the new design. Direct native signing can remove the connector if the selected
wallet demonstrates the same destination approval and transaction binding.

Existing funded vaults keep their enrolled scripts and recovery artifacts.
A new contract requires an intentionally authorized transfer into a new
enrollment. Neither this evidence nor the contingency preparation activates
connector enrollment, deploys a service, or establishes native signer support.
