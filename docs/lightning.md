# Lightning payments

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
Send and receive share the persistent per-vault wallet, contract manager,
and swap repository. Bounded operations reuse that graph under the existing
Lightning lifecycle lock.

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
signature-verified.

`VITE_VAULT_LIGHTNING_RECEIVE=true` enables amount-specific receive into
Spending for Light, Standard, and Advanced wallets. This flag is off by default,
including in `build:mainnet`. Funded qualification is still required before
production activation.

## Receive and fee confirmation

The wallet asks the bundled solver for the exact amount the recipient wants in
Spending. The signed card currently advertises a 500–50,000 sat receive range.
The quote's invoice amount is the payer's total; the difference from the amount
received is the all-in quoted fee. The payer's own Lightning wallet may charge
an additional routing fee.

The card supplies an estimate, while the returned quote supplies the exact
invoice amount. Vaulted displays the amount received, payer total, fee, and any
excess above that estimate. The user must select **Confirm fee and show invoice**
before the QR code or copy action becomes available. Invoice validation still
rejects changed amounts, payment hashes, networks, destinations, expired
invoices, and insufficient claim windows.

The wallet creates the payment secret locally, reconstructs both supported
VHTLC layouts, and accepts only the layout whose address exactly matches the
quote. It binds the payout to the enrolled Spending script and checks the
Operator and Emulator signing keys. Recovery data is stored and read back
before the quote is displayed; the encrypted backup must succeed before an
approved invoice can be shared. Failed backup attempts keep the invoice hidden,
including during subsequent status refreshes.

## Incoming claims and recovery

Keep Vaulted open while the payment completes. The foreground receive flow has
no always-online claim delegate or reusable Lightning address. The deployed
solver requires a sealed claim packet; this client encrypts it to a disposable
public key whose secret is discarded. Only the wallet retains the payment
secret, so that packet does not provide an offline claim service.

Once one spendable funding output covers the quoted receive amount, the wallet
checks its parent transaction and prepares a noninteractive claim paying the
full output value to Spending. Several underfunded outputs cannot be combined
to justify revealing the secret. The exact claim is saved and read back before
submission to the Emulator. A lost response keeps that transaction pending;
only the indexed payout at its expected transaction and output can mark the
receive complete. Missing funding outputs alone never establish success.

The shared encrypted Lightning journal includes incoming contracts and secrets
alongside outgoing payments for every wallet tier. The standalone program
recovery source supports incoming unilateral claims using the phone key,
payment secret, saved exit graph, and the contract's claim delay. Recovery can
require onchain fees and timelock maturity. A backup taken before funding must
be refreshed to capture the funded transaction graph; the initial secret backup
alone cannot supply transactions that did not yet exist.

## Qualification evidence (2026-09-08)

An unfunded mainnet probe against the supplied beta solver returned a verified
quote of 1,006 sats paid for 1,000 sats received. The probe checked the invoice,
payment hash, and locally reconstructed contract. It neither paid nor exposed
the invoice. Run `pnpm test:lightning-quote` to request another unfunded quote.

Automated fixtures exercise both contract layouts across all three wallet
tiers, fee approval, backup failures, underfunding, lost submission responses,
payout evidence, and preparation of a funded unilateral recovery graph with
Guardian and Operator access unavailable. Funded Lightning qualification remains
outstanding. Before enabling receive in production, verify a paid
invoice through claim and Spending credit, restart during payment, and recovery
from the resulting funded backup using the rebuilt standalone recovery tool.

Validation of this implementation passed with Node 24:

- `pnpm test:unit --maxWorkers=2 --reporter=dot`: 180 files and 1,526 tests passed;
  one existing test was skipped.
- `pnpm typecheck` and `pnpm lint`: passed.
- `VITE_VAULT_LIGHTNING_RECEIVE=true pnpm build:mainnet`: passed.
- Both standalone recovery builds and the portable recovery browser handoff:
  passed.
- Browser fee review and approval at 320, 390, and 1,280 pixels: passed using a
  synthetic, unpayable invoice, with no horizontal overflow or page errors.
