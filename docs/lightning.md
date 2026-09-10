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
production activation. A qualification build can also set
`VITE_VAULT_LIGHTNING_RECEIVE_VAULT` to one enrolled Vault ID; receive is then
visible only for that wallet. The flag scopes availability without changing the
wallet's contract or recovery rules.

## Receive and invoice fees

The wallet asks the bundled solver for the exact amount the recipient wants in
Spending. The signed card currently advertises a 500–50,000 sat receive range.
The quote's invoice amount is the payer's total; the difference from the amount
received is the all-in quoted fee. The payer's own Lightning wallet may charge
an additional routing fee.

The card supplies an estimate, while the returned quote supplies the exact
invoice amount. Vaulted displays the amount received, payer total, fee, and any
excess above that estimate on the invoice page alongside the QR code and copy
action. There is no separate fee-confirmation screen. Invoice validation still
rejects changed amounts, payment hashes, networks, destinations, expired
invoices, and insufficient claim windows.

The wallet creates the payment secret locally, reconstructs both supported
VHTLC layouts, and accepts only the layout whose address exactly matches the
quote. It binds the payout to the enrolled Spending script and checks the
Operator and Emulator signing keys. The Emulator endpoint comes from the
network pins; the enrollment’s cosigner identifier can be a URN and is never
used as an HTTP address. The invoice, secret, and contract are stored and read
back from local IndexedDB before the invoice and its exact fee are displayed.
Creating, sharing, and reopening an invoice require no cloud upload or passkey
prompt. A failed local write keeps the invoice hidden.

Receive Lightning always opens to an empty amount prompt. A request can reuse
an active invoice for that exact amount; earlier payments remain in the journal
for reconciliation and recovery. The current screen displays a receipt when
payment arrives, but reopening Receive Lightning does not restore that receipt.

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

A mainnet invoice paid 504 sats for a 500-sat Spending receipt. The indexed
claim and enrolled payout script were verified, and the recipient confirmed the
balance and corrected receive display. The payer's final status and a restart
during an unresolved payment have not been confirmed.

Incoming recovery fixtures now cover both layouts across Light, Standard, and
Advanced. They reopen the SDK's IndexedDB swap repository, restore the saved
journal into fresh storage, and prepare signed unilateral claims with external
services unavailable. These are controlled fixtures, not the recipient's
funded encrypted backup.

The actual 500-sat Spending output's saved graph contains 19 virtual
transactions rooted in three confirmed Bitcoin commitments. Its graph reloads
and validates offline. At the observed 2 sat/vB estimate, putting the ancestry
onchain requires 13,318 sats across 19 parents and 19 fee-paying children. The
SDK excludes the final sweep as uneconomic: its current minimum is 546 sats
after the sweep fee. This estimate is a failed exit qualification, not a
payable recovery quote, and changes with chain state and fees.

Receive remains restricted to the qualification wallet. General activation
requires a successful funded encrypted-backup restore, a signed recovery
package with an economically viable output, and restart reconciliation during
a pending payment. The existing 500-sat receipt establishes normal receive
behavior but cannot establish a usable standalone onchain exit at that amount.

Validation of this implementation passed with Node 24:

- `pnpm test:unit --maxWorkers=2 --reporter=dot`: 180 files and 1,526 tests passed;
  one existing test was skipped.
- `pnpm typecheck` and `pnpm lint`: passed.
- `VITE_VAULT_LIGHTNING_RECEIVE=true pnpm build:mainnet`: passed.
- Both standalone recovery builds and the portable recovery browser handoff:
  passed.
- Browser fee review and approval at 320, 390, and 1,280 pixels: passed using a
  synthetic, unpayable invoice, with no horizontal overflow or page errors.

## Receive UX follow-up (2026-09-09)

An unfunded live quote probe completed in about 4.2 seconds and returned 1,007
sats paid for 1,000 sats received. This measures the probe's quote flow, not
invoice sharing or a funded payment. The screen runs independent service
checks concurrently. Invoice creation uses local storage;
full recovery uploads are outside the invoice flow.

The wallet's existing background recovery capture continues on wallet activity,
focus, and periodic refresh. Funded transaction paths are saved locally, and
an existing cloud session can synchronize recovery data. The local invoice
record survives reloads but does not provide a separate copy if browser storage
or the device is lost.

Kukks' merged [wallet LNURL integration](https://github.com/arkade-os/wallet/pull/559)
keeps the session and invoice listener at wallet level, so changing screens
does not end receiving. A payer can request an amount through LNURL while the
wallet creates the invoice and handles the payment in the background.
The separate [offline self-claim service](https://github.com/ArkLabsHQ/lnurl-server/pull/22)
adds server-side claims behind its own configuration gate.

Vaulted does not activate either integration in this change. A reusable
Lightning address needs authenticated registration bound to the enrolled
Spending destination, an explicit fee acceptance policy, durable payment
secrets, and qualified claim, restart, and recovery behavior. The existing
Vaulted service design is in the offline-receive review worktree's
`lnurl-server/docs/vaulted-offline-receive.md`. The funded recovery restrictions
above still apply.

Local invoice storage and receive entry were validated with 65 focused tests;
the previous full regression run passed 1,546 tests. Inline fee display is
covered by receive-screen, invoice-validation, and recovery-journal tests.
Browser verification uses real IndexedDB and a synthetic invoice at phone and
desktop widths in both themes, checks that the QR and exact fee appear together
without another confirmation step or passkey request, and reloads pending and
completed payments.
