# Ledger native Savings with Guardian recovery

The retained Savings contract is `phone-ledger-guardian-savings-v1`, with shared
Spending for every account. New Ledger enrollment and RC activation require the
[integration and release gates](ledger-integration-status.md). Qualification
results below identify their original test scope and require rechecking when
their candidate inputs change.

## User flow

Enrollment connects a Ledger through desktop WebHID, reads its BIP86 account
origin and registers one **Vaulted Savings** policy. Vaulted supplies the entire
key vector automatically. The user reviews the policy and verifies the Savings
receive address on the device before funding it.

Normal withdrawals require phone and Ledger signatures on the Savings input.
The device displays the recipient, amount and Bitcoin fee; both signatures commit
to every output. A partial withdrawal returns change to the registered Savings
change script. Normal payment authorization is confined to those two signatures
and the enrolled Savings transaction.

Recovery can require additional policy registrations and timed stages. The same
Ledger seed supplies its recovery keys through separate account branches. The
recovery package retains the policies, origins, phone backups, exact transaction
parents and unresolved operations needed to reconstruct those stages.

## Accepted trust model

The user accepted Guardian-only Savings recovery on September 9. The Guardian
alone cannot spend Savings, while any enrolled recovery claimant and a compromised
Guardian signing key can authorize an arbitrary transaction through that recovery
leaf. That pair can bypass the pending destination and its delay entirely.
The Ledger does not protect funds against this combined compromise when the
attacker uses a phone-authorized recovery leaf.

The Guardian's named authorization capability enforces the intended pending
or quarantine destination, transaction shape, fee limits and user authorization.
These output restrictions are service enforcement. Bitcoin enforces the two
signatures and, after a pending output exists, its recovery scripts and delays.
Removing the public Emulator eliminates an independent enforcement authority and
one service availability dependency for this new Savings contract.

| Action                         | Required authority                        | Result                                         |
| ------------------------------ | ----------------------------------------- | ---------------------------------------------- |
| Normal Savings withdrawal      | Phone and Ledger                          | Reviewed recipient and optional Savings change |
| Start recovery                 | Claimant and Guardian                     | That claimant's enrolled pending output        |
| Claim pending                  | Claimant                                  | Available after its CSV delay                  |
| Cooperative cancellation       | One remaining user authority and Guardian | Enrolled quarantine output                     |
| Cancellation without a service | All remaining user authorities            | User-authorized destination                    |
| Release quarantine             | All remaining user authorities            | User-authorized destination                    |

Hardware claims wait 6 blocks, phone claims 144, and the optional recovery key 288. These delays begin when the pending transaction confirms. Savings itself
has no hardware-only delayed leaf, and the shorter hardware delay is not a
clawback guarantee against compromised initiation signers. Standard has one
remaining user authority after a recovery request; Advanced has two.

Spending retains its existing scripts and service dependencies. Its independent
Bitcoin exit still requires current saved transaction paths and the keys named
by its enrolled contract.

## Policy and key construction

Standard registers four key records: a NUMS internal parent, phone account,
Ledger account and Guardian parent. Advanced adds a recovery account for five
records. Each user origin contains a master fingerprint, BIP86 account path and
public account xpub. Ownership and physical review require signer qualification;
an xpub's syntax alone does not establish either.

The contract digest binds its new identity, network, vault ID, protection tier,
Spending policy digest, account origins, PhoneDirectP256 key and Guardian base.
All hash domains use `vaulted/ledger-guardian-savings-v1`. The Guardian parent uses
that base point and a context-bound chain code. Its secret root must be derived
in a separate per-vault domain, independent of legacy Savings and Spending roots.
Recovery program packets and program-hash key tweaks are absent from this contract.

Receive and change each use index zero, with all other indices rejected by the
wallet and service. The complete tree is registered with Ledger; no hidden or
opaque recovery subtree is substituted during signing.

| Key use                        | User branch         | Guardian branch                              |
| ------------------------------ | ------------------- | -------------------------------------------- |
| Normal phone or Ledger         | 0 receive, 1 change | None                                         |
| Phone initiation               | 2 receive, 3 change | 0 receive, 1 change                          |
| Ledger initiation              | 2 receive, 3 change | 2 receive, 3 change                          |
| Optional recovery initiation   | 0 receive, 1 change | 4 receive, 5 change                          |
| Matured claim                  | 4                   | None                                         |
| Cooperative cancellation       | 6                   | P→H 6, P→R 8, H→P 10, H→R 12, R→P 14, R→H 16 |
| Cancellation without a service | 8                   | None                                         |
| Quarantine release             | 10                  | None                                         |

`P→H` means cancellation of phone-initiated recovery by the hardware authority.
Each actual recovery coordinate uses index zero. Odd partner branches in recovery
policy expressions satisfy Ledger's policy grammar and are not enrolled outputs.
Nonhardened Guardian children share one compromise domain; knowing a child secret
and the parent xpub can expose the parent and sibling keys.

## Recovery authorization and fees

An initiation or cooperative cancellation has one verified input and one output,
uses version 2, locktime zero, sequence `0xfffffffd` and DEFAULT signatures.
The named Guardian capability reconstructs the enrolled family and validates
the complete parent transaction, prevout, leaf, control block, user signature,
exact destination and final witness size before deriving a private child.
Phone operations also require a detached PhoneDirectP256 proof bound to the
contract, purpose, roles, exact transaction and prevout. A passkey session alone
cannot replace that transaction authorization.

The candidate uses fee replacement without an anchor. Increasing the fee requires
fresh signatures from the same acting user and Guardian, with the same enrolled
destination and release fee caps. Guardian unavailability before confirmation can
therefore prevent a fee increase. There is no independent anchor for a third party
to sponsor, and a CSV claim cannot spend an unconfirmed parent before maturity.
Congestion beyond the fee caps remains a liveness limit requiring explicit
release review.

The recovery replay ledger must never associate a replacement sighash with the
previous transaction's signatures. An interrupted replacement stays unsigned
until that exact transaction is signed; retries and lost responses preserve its
original destination and operation identity. A late signing completion cannot
overwrite a newer completed replacement. Failure/restart, lost-response and
concurrent-signing tests cover these distinctions.

## Qualification and integration

The [qualification record](../tools/native-savings-signers/evidence/ledger-guardian-qualification.json)
identifies the checked source and evidence files. The wallet and Go runtime
share complete vectors for both networks and tiers.
Bitcoin authority tests deliberately bypass the Guardian using public fixture
keys, including a test proving the accepted phone-plus-Guardian compromise.
The Core harness exercises funded leaves, CSV maturity, output substitution and
replacement of recovery initiation without an anchor. Service authorization is
tested separately against the named signing capability.

Ledger qualification uses Bitcoin Test 2.4.2 from source
`2c7956fe566bd7f6f690288130033441fabc5f10`, Speculos 0.27.0 and Python client 0.4.0.
The ELF SHA256 is
`db1608c935989d39fda91054bfff5e02460d6cfc79d21ca0646a7dc5a6ec03b9`.
The [harness](../tools/native-savings-signers/README.md) records normal payment and
recovery registration, destination display, signatures and finalized sizes.
Physical devices and distributed production app binaries require separate
qualification. Evidence from the earlier two-service candidate belongs to that
contract and cannot establish this contract's compatibility.

The Guardian-only normal simulator run passed all four withdrawals: full payments
with one Taproot recipient measured 169 vB, and partial payments with Taproot
recipient and Savings change measured 212 vB. These sizes include both signatures.
All fifteen recovery signing cases across ten policies also passed destination,
amount, fee and signature checks in the same simulator build. Four supplemental
cases started hardware recovery from receive and change, reusing the two normal
policies. Ledger signed the canonical unsigned transaction before the fixture
Guardian added its signature; the original eleven captures remain unchanged.
The funded Core
run accepted all 37 contract paths and ten recovery initiation
replacements, with early CSV claims and output substitutions rejected. The
Guardian validates 14 independently generated wallet transaction/proof vectors;
112 key-metadata substitutions are rejected. Full runtime tests and the focused
race suite passed. The integrated wallet suite passed 348 tests, with an additional
67 tests for the new recovery builder; its first parallel run had a worker timeout,
then the serial rerun passed without unhandled errors.

The JavaScript integration uses Ledger's official client and WebHID transport.
Enrollment now stages the proposed contract, verifies and saves the Ledger
registration before activation, and preserves it across interrupted completion.
A new Savings HD seed stays separate from the existing Spending scalar. The
version-six passkey binding and version-four Recovery Kit retain both identities,
the encrypted Savings seed and the registration. The current recovery schemas preserve both identities and reject historical
program metadata. Candidate qualification includes export and restoration.

### Spending recovery compatibility

The current enrollment reuses `ExternalOwnerWallet` for Spending's hardware exit
authority. Registering the new Savings policy does not qualify that separate
Bitcoin output. The SDK's current `vault-policy-v1` Spending tree uses a fixed
NUMS internal key, fixed Operator and delegate points, and a CSV DROP exit prefix.
The tested Ledger policy compiler requires derived xpub expressions, including
for its internal key, and cannot reproduce that exact exit prefix. Signing checks
the complete reconstructed output, so supplying just the exit leaf is insufficient.

This is a source-level incompatibility with the tested stock policy path. Savings simulator evidence concerns a different output contract. Retained
enrollment uses the offline emergency path described below with the existing
Spending keys and protection model. On September 9, the user accepted offline seed recovery for
emergencies: Standard retains phone plus hardware; Advanced retains hardware plus
recovery. Ledger enrollment derives Spending H and R at account `/12/0`, with their
x-only points canonically encoded as `02` plus the point. Retained account
restoration must recover those exact enrolled authorities.

The separate offline tool accepts a reviewed recovery request and a BIP39 seed
backup, checks the full account origin and the exact transaction, and exports a
partial PSBT. It has no network submission path. Seed entry exposes every account
under that seed to the computer, so users must treat this as an emergency and
replace the affected seeds afterward. The online wallet never receives them.
Spending fee sponsorship belongs to the same complete exit qualification; proving
only the final CSV signature is insufficient.

Sources: [wallet Spending tree](../src/lib/vault/vtxo/script.ts),
[Spending recovery PSBT](../src/lib/vault/vtxo/spendingRecovery.ts), and tested
Ledger [key derivation](https://github.com/LedgerHQ/app-bitcoin/blob/2c7956fe566bd7f6f690288130033441fabc5f10/src/handler/lib/policy.c#L507),
[policy compiler](https://github.com/LedgerHQ/app-bitcoin/blob/2c7956fe566bd7f6f690288130033441fabc5f10/src/handler/lib/policy.c#L181)
and [input recognition](https://github.com/LedgerHQ/app-bitcoin/blob/2c7956fe566bd7f6f690288130033441fabc5f10/src/handler/sign_psbt.c#L189).
The original policy compatibility review used SDK 0.4.66 with tar SHA256
`baf08f891e4a3e9dbad57d8fa731c47c0b57b69662688bb4a163765810c21b9d`.
Current SDK provenance and recovery-input qualification are recorded in
[upstream alignment](upstream-alignment.md) and the companion producer manifest.

### Activation requirements

Software qualification covers authenticated enrollment and interruption, complete
package export and clean-device restore, the recovery coordinator, funded
Guardian authorization and offline Spending exits with fee funding. Physical
Ledger review with the production Bitcoin app remains required before enabling
new enrollments. See the integration checkpoint for exact release evidence.
The public Emulator upgrade is no longer a dependency of this Savings design.

The candidate excludes historical Light, direct-hardware Savings and both
connector generations. Its runtime uses schema 12 and retains the separate
MAC-authenticated Ledger record alongside shared Spending identity. Enrollment
creates the records atomically and binds the Savings account origins, separate
Guardian base, policy and registration. Proposal, finish, duplicate finish,
status and restore must reconstruct the same retained contract.

Recovery files use the current kit and binding versions. Retain both phone
identities, the Ledger policy authorization, receive/change coordinates and
transaction parents; verify them before persisting a restored wallet. Check the
complete binding against the existing 16 KiB limit. The candidate's detached
phone transaction proof needs its own request field because the current session
`DirectProof` authenticates a different challenge. Enabling the template requires
the matched wallet, runtime Contract Pack and companion bundle together.

Wallet recovery primitives return PSBT hex, while the runtime parser and response
use Base64. The HTTP adapter must convert explicitly and retain the same unsigned
transaction and metadata through both representations. Persist the exact
user-signed PSBT and detached phone proof before requesting Guardian signing;
retries reuse those bytes without repeating user approval.
