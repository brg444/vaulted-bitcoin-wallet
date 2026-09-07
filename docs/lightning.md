# Lightning send

Outbound BOLT11 uses the published `@arkade-os/swap` package to request and
verify an Arkade-to-Lightning quote. The package decodes the invoice facts,
derives the VHTLC, checks the solver's lockup address, and registers the
contract with the official Arkade SDK before any funding transaction is built.

The Vault adapter opens a standard SDK wallet with the enrolled phone identity
and the existing per-vault SDK repositories. It changes only `getAddress()` so
the package commits every refund to the exact `vault-policy-v1` Spending
address. The adapter verifies that address against the signed enrollment
binding, advertised Spending script, network, and Operator signer. A standard
swap repository and `RfqSwapManager` own restart, resolution, and refund state.
The adapter closes the temporary manager, wallet, and repositories after each
bounded wallet operation.

Funding remains an ordinary Vault VTXO send to the package-verified lockup
address. The Vault service applies the same per-transaction cap, rolling
allowance, fee bounds, input reservation, transaction verification, and
ambiguous-submission recovery used for every other Spending transfer. It does
not expose Lightning-specific routes or reinterpret the VHTLC.

## Durable send lifecycle

The wallet stores the package RFQ record and complete recovery profile before
it reveals a funding target. The record includes:

- invoice and locally decoded amount, payment hash, network, and expiry;
- RFQ identifier, solver identity, and signed solver card identity;
- quote validity, refund locktime, funding amount, and corridor fee;
- lockup address, VHTLC script, and exact `vault-policy-v1` refund address;
- SDK contract-registration identity, sender signing descriptor, and funding
  transaction identity when one exists.

The invoice and quote are checked again immediately before funding. A quote
that expires before the user authorizes the ordinary VTXO reservation must be
discarded without creating a second operation. An ambiguous funding response
resumes through the existing VTXO operation and the official SDK
pending-transaction interface.

The package manager restores nonterminal records at startup. An unfunded quote
can be cancelled or retired after expiry. Once the funding target is exposed,
the record remains until the payment resolves or refunds because an absent
broadcast response does not prove that no funds moved.

## Refunds

The
VHTLC's noninteractive refund path uses the server, solver, and mainnet
Emulator to return value directly to `vault-policy-v1`. Package-level tests
rebuild the persisted contract and verify that this leaf contains the exact
Spending script.

Reload and focus reconciliation are watch-only. They can recognize settlement
or show that a refund is available, but they cannot sign one. Returning an
expired payment to Spending requires a separate Face ID approval; only that
bounded operation installs the package refunder. Payment and refund availability depend on the configured solver and required services.

## Build capability

`VITE_VAULT_LIGHTNING_SEND=true` enables outbound Lightning. The mainnet build
sets it explicitly; other builds must opt in. Solver cards are bundled and
signature-verified. Lightning receive is not implemented in the wallet.
