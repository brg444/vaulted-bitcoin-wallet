# VTXO boarding

Spending contains `vault-policy-v1` VTXOs. An Arkade-aware sender can create a
VTXO directly. Bitcoin received onchain first enters a boarding output, appears
as pending Spending, and becomes spendable after the official Arkade SDK
settles it into the enrolled Spending contract.

```text
Savings spend or onchain receive
  -> boarding output appears as pending Spending
    -> output confirms on Bitcoin
      -> official SDK joins a batch
        -> vault-policy-v1 VTXO becomes spendable
```

The Spending receive view publishes one BIP21 request containing the Arkade
address and Bitcoin boarding address. Moving Savings to Spending uses the same
boarding address. The displayed balance includes observed boarding outputs,
while sends and Lightning funding select only indexed, unspent Spending VTXOs.
When the destination VTXO appears before Esplora marks the boarding output
spent, transaction identity prevents the same value from being counted twice.

## Program

`vault-board-v1` is the only supported boarding program. Its cooperative leaf
requires three distinct keys:

1. a worker-owned boarding key scoped to the vault, network, and named program;
2. the VaultBoardCosigner held by the Vault service;
3. the release-pinned Arkade Operator signer.

Its recovery leaf is the enrolled phone key behind a 604672-second CSV delay.
Both the wallet and service reconstruct the exact tree, address, and script.
The current release accepts one boarding input and one BTC recipient, which
must be the enrolled `vault-policy-v1` Spending address.

The boarding key is derived only after the existing passkey PRF unlock
succeeds. It is written to a dedicated per-vault IndexedDB store and never
crosses `postMessage`. Enrollment stages the key before the service commits the
descriptor, then activates it only after the returned descriptor matches every
release pin. A later passkey unlock can reproduce a missing local key from the
same enrolled facts.

## SDK ownership

The scoped service worker owns one persistent SDK Wallet, Contract Manager,
VtxoManager, intent repository, batch lifecycle, and retry loop. The browser uses
the SDK service-worker proxy for balances, activity, contract state, and reload
events. It does not build registration proofs, poll the Operator, call
`settle`, or maintain a second boarding state machine.

The Vault adapter supplies four typed phases:

- prepare one exact confirmed input and Spending recipient;
- submit the SDK registration proof after VaultBoardCosigner authorization;
- release a retained prior intent when the service requires it;
- submit the SDK-validated commitment, Batch Output expiry, tree, forfeits, and
  exact recipient evidence.

The service submits those artifacts through the stock public Operator API and
never returns its signature to the browser. Ambiguous responses remain blocked
until the next SDK reconciliation proves finalization or obtains an
acknowledged release.

## Activity and balance

One activity feed uses two states: Pending and Confirmed. An observed boarding
output is a received Pending transaction even when its Bitcoin confirmation is
already present, because it is not yet a Spending VTXO. The detected unspent
output supplies that row before an Operator intent exists. When the SDK reports
the settled activity, the resulting VTXO row is Confirmed and replaces the
boarding row.

The displayed Spending balance is:

```text
unspent vault-policy-v1 VTXOs + unspent boarding outputs
```

The spendable balance contains only the first term. Worker and page reloads
read the persistent SDK state and public indexer state again. Those sources
remain authoritative when an event is delayed or missed.

## Logout and interruption

Logout locks the interface immediately, asks the SDK worker to stop new work,
waits through its normal drain window, unregisters the worker, then deletes the
persisted boarding key. A teardown failure retains the registration and key so
the application never reports cleanup it could not confirm.

Browser APIs provide no method to forcibly terminate an executing service
worker. One settlement that already crossed exact server validation may finish
after logout. It remains bound to the confirmed input, fixed fee and Batch
Output policy, and this vault's Spending recipient; it cannot authorize another
operation or redirect funds. Reload or wake starts normal reconciliation from
the SDK repository.

Service workers may be suspended by the browser when no execution event keeps
them alive. The worker-owned key removes Face ID from settlement, but it does
not create a browser background guarantee. Opening or focusing the wallet
wakes the official SDK lifecycle and resumes from persisted intent state.

## Delayed recovery

After the 604672-second recovery delay matures, the Backups screen may
offer an explicit recovery action for current, confirmed, unspent
`vault-board-v1` outputs. The recovery command owner coalesces that action and
checks session freshness. Face ID unlocks the enrolled phone key for a new
attempt only; cancellation is passed through unlock, and a key returned after
cancellation is wiped without signing. The wallet calls the SDK's
`recoverBoardingProgram` helper, which verifies the exact named tree, maturity,
phone-controlled Taproot destination, fee-rate cap, and absolute fee cap. The
supplied `OnchainProvider` persists the exact signed transaction and its locally
derived transaction ID before dispatch. The phone scalar is cleared when the
helper returns or fails.

A saved attempt is bound to the admitted vault, network, boarding descriptor,
immutable input set, destination and fee authority. Restore and retry validate
those facts and the saved bytes. The live path may sweep several mature inputs
in one transaction. Independent recovery keeps the existing
`vaulted-boarding-recovery` v1 single-input file and adds
`vaulted-mature-boarding-recovery` v1 for the signed multi-input evidence. The
live journal wraps that evidence as `vaulted-mature-boarding-attempt` v1 and is
copied into the complete recovery file when present.

Phases are `signed`, `dispatched`, `uncertain`, `conflict` and `confirmed`. A
lost broadcast response or missing indexer read stays uncertain and retries the
same bytes. Absence from an indexer or archive cannot prove consumption or
authorize a replacement attempt. Positive outspend evidence of a different
transaction is a conflict. The recovery command retires the journal only after
the exact transaction is confirmed, the committed recovery file contains the
same signed bytes, and history shows a received amount equal to the saved
destination output. That received amount is the recovered sats after fees. A
sent row, including an outflow of the boarding inputs, does not retire this
sweep. The command captures that signed record before acknowledgment. An
absent or stale file, delayed history, uncertain chain read, different
transaction or failed storage keeps the operation. After retirement, later
mature inputs may be swept, including after reload.

This path is not automatic and does not construct a parallel Vault transaction
lifecycle. It does not recover an immature, foreign, or already-spent output.
The existing per-vault boarding recovery lock remains the cross-tab financial
lock. A failed durable write prevents dispatch and leaves the previous valid
record and complete recovery archive in place.
