# Light delegated renewal release preparation

The September 6 release preparation uses the current owner-presigned
delegation model, with routine renewal scheduled during normal wallet use
without a separate expiry-management workflow. Recursive renewal and the
newer emulator opcodes are deferred.

## Guardian can execute delegated renewals

Guardian is a compatible delegate for the existing Light contract. Light's
collaborative script requires the owner, Guardian, and Operator. The stock
SDK delegate script requires the owner, delegate, and Operator. Substituting
Guardian into that delegate position produces the exact existing Light leaf.

Local tests confirm the byte equality on mainnet and Mutinynet. A further
test runs the vendored SDK's actual `DelegateManagerImpl` against the existing
Light tree and an in-memory Guardian provider. It creates the owner-signed
intent and partial forfeit for a known output, with Guardian as tree cosigner,
a future execution time, and the same Light destination. The owner's forfeit
signature verifies under `SIGHASH_ALL | ANYONECANPAY`.

This establishes compatibility of the script and client request construction.
The release candidate now includes the wallet integration and a native
Guardian executor. Activation remains conditional on Guardian advertising the
qualified versioned capability. Funded production renewal has not been
qualified by the synthetic SDK and runtime tests.

The integration uses Guardian's existing per-vault Light
cosigner as the delegate signing authority. It preserves the current address,
two-leaf tree, descriptor, payment authorization, and delayed owner-only exit.
It requires neither an external delegate key nor an additional aggregate
client signature. Guardian still needs the owner's presigned authorization;
its existing cosigner key alone cannot renew or spend.

## The current public service remains a reference

Arkade Wallet currently enables delegation by default and supplies the SDK
with these services:

| Network | Existing service | Verified metadata |
| --- | --- | --- |
| Mainnet | `https://delegate.arkade.money` | Key matches Vaulted's existing pin; fee `0` |
| Mutinynet | `https://delegator.mutinynet.arkade.sh` | Key matches Vaulted's existing pin; fee `0` |

Both `GET /v1/delegator/info` responses were retrieved on September 6 and saved
as public fixtures. `POST /v1/delegate` accepts a signed intent, partial
forfeits, and a replacement preference. The reviewed Fulmine implementation
stores and schedules those requests, then registers the intent, joins a batch,
signs the tree, adds the connector, and submits completed forfeits.

A separate public delegate would require a new Light leaf containing that
service's key. Giving it the ordinary owner/delegate/Operator leaf would also
create a path outside Guardian's payment checks. Fulmine's reviewed forfeit
validator accepts exactly one submitted client signature, so adding a fourth
Guardian signer is not a direct substitution. The experimental aggregate
signature adapter was archived after the Guardian compatibility check.
It is outside the recommended release integration.

Running an unmodified Fulmine instance alongside Guardian would introduce its
own wallet identity, scheduler, and storage. Fulmine uses one delegate identity,
while Guardian derives a distinct Light key per vault. Reuse the reviewed
lifecycle implementation through scoped Guardian capabilities, keeping
Guardian's master and derived signing keys inside its existing key provider.

## Authorization and execution

The client prepares delegation for currently known outputs during a normal
passkey unlock or payment ceremony. It binds the exact inputs, original Light
destination, receiver value, fees, and Guardian tree-signing identity before
the owner key is wiped. Store only the signed intent and partial forfeits for
later execution. The worker remains read-only and the backup session remains
unable to authorize payments.

The current SDK groups outputs by expiry day and schedules at the earliest
expiry minus 10% of remaining lifetime. Its nearby 12-hour comment is stale.
The stock SDK intent contains `valid_at` and sets `expire_at` to zero. The
native adapter rebuilds the same intent with the public SDK `Intent.create`
and `SingleKey.sign`, setting `expire_at` to the owner's operation deadline
before persistence or submission. Its original partial forfeit remains
byte-identical. Guardian validates the complete transaction and its own bounded operation
record, including current input state and fee limits, at scheduling and
dispatch. It must never offer an arbitrary-signature endpoint.

Guardian's existing renewal verifier requires immediate registration
(`valid_at = 0`), a five-minute plan, and a full owner forfeit signature after
the replacement tree is available. Scheduled delegation introduces an
owner-presigned partial forfeit and a server-owned batch session. The native path uses a
versioned delegation operation and semantic signing capability, preserving
the existing verifier's behavior for in-progress foreground renewals.

At execution, Guardian validates the signed replacement tree, amounts,
destination, Operator parameters, connectors, and final forfeit before
releasing its signature. Preserve the existing rule that final forfeits are
released only against a complete, verified replacement recovery path.

## Scheduling, payments, and restart

A scheduled request should leave the funds available for ordinary payments.
Store it as an armed request without releasing Guardian's intent or forfeit
signature. At payment reservation, invalidate overlapping armed requests in
the same ledger transaction. At renewal dispatch, atomically acquire the
inputs and verify that no payment reservation or unresolved signed operation
already owns them.

Once Guardian releases a signature or dispatches to the Operator, retain
exclusive operation ownership until the exact outcome is reconciled.
A timeout alone cannot establish cancellation. After the finite registration
deadline, Guardian can abandon an operation before final forfeit authorization
and enter `cleanup_pending`. The same owner ceremony supplies a separate SDK
delete intent for the original input, bound into the schedule signature. Its
zero expiry permits later cancellation, and its only output is the SDK's
zero-value OP_RETURN proof output. Guardian retains operation ownership until
the Operator acknowledges deletion; a missing registration or lost response
remains pending. Once final authorization exists, uncertainty remains fenced
until reconciled. Tree-signing nonces have single-use handling and durable
operation bindings.

The executor runs inside Guardian's existing operating boundary and uses
per-vault task records. Guardian restart, unlock, and service outages become
renewal availability dependencies; retry status and approaching expiry need
operational monitoring. A locked Guardian cannot execute pending renewals.

## Offline behavior and recovery data

An already accepted, owner-presigned request can execute while the browser is
closed. Guardian cannot create the owner's signature for a newly received
output or the next renewal generation. Those outputs need delegation during
a subsequent normal passkey ceremony. This is a limit of the current model
regardless of whether the delegate is Guardian or the public service.

Automatic scheduling during normal use removes the separate renewal action,
but it does not provide indefinite renewal for a wallet that is never
unlocked again. Keep coverage status accurate for outputs that have not yet
been delegated. An unannounced additional passkey prompt, retained owner key,
or hidden transfer of owner signing authority is outside this preparation.

Guardian can capture replacement recovery data as part of its batch execution,
which is simpler than observing an external delegate after the fact. The
current encrypted backup uploader still requires a client-held AES key.
Persisting public transaction data in Guardian's operation journal does not
automatically update the user's encrypted archive.

For the current backup format, reconcile and upload current paths on the next
unlock, retaining the previous complete archive and identifying its capture
time. Offline production of encrypted recovery snapshots would require a
separate encryption-only public-key mechanism and companion support.
Until that extension is implemented, an old cloud archive retains its dated
snapshot and can omit a renewal completed while the browser was closed.

## Source and qualification

| Source | Reviewed revision |
| --- | --- |
| [Arkade Wallet](https://github.com/arkade-os/wallet/tree/be14ac556427d62743793924b28aca0a08d8eb3e) | `be14ac556427d62743793924b28aca0a08d8eb3e` |
| [SDK 0.4.69 reference](https://github.com/arkade-os/ts-sdk/tree/45a53690aa80dbc3fd058f3fa4c250c262cc566b) | `45a53690aa80dbc3fd058f3fa4c250c262cc566b` |
| [Fulmine](https://github.com/ArkLabsHQ/fulmine/tree/73967552d9c73e6add84da5a456c45694ff0de04) | `73967552d9c73e6add84da5a456c45694ff0de04` |

The compatibility test uses the wallet's current vendored SDK, based on the
`f0fd58d5` lineage with the documented Lightning patches. Upgrading the full
SDK package to the public release is outside this preparation because it
would remove the current Vaulted boarding integration.

Relevant implementation files are SDK `wallet/delegate.ts`,
`providers/delegate.ts`, and `script/delegate.ts`; Fulmine
`delegate_service.go` and `delegate_batch_handler.go`; and runtime
`light_renewal_keys.go`, `light_renewal_verify.go`,
`light_renewal_final.go`, and `key_provider.go`.

## Wallet integration and qualification

`delegationRequest.ts` uses the pinned SDK `DelegateManagerImpl` and the finite
intent adapter. The one-output request binds the original Light script,
receiver amount, Guardian key, and dispatch deadline. Scheduling follows the
SDK's 10% margin, with a 30-day horizon, a maximum one-day dispatch window,
and an input-expiry margin. The wallet checks exact input and output fees at
the scheduled time; the pinned SDK's receiver-output fee omission causes a
preflight rejection when the signed amount differs from the required fee.

`guardianDelegation.ts` discovers remote schedules, stores each exact signed
request in IndexedDB before submission, and reconciles ambiguous replies.
Committed received outputs and payment change are eligible even when the SDK
marks them preconfirmed, provided their expiry and complete committed ancestry
are available. Reserved payment inputs remain excluded. New change created by
the current payment waits for the next owner ceremony.

Normal cloud unlock, local unlock, enrollment, cloud restore, and reviewed
payments invoke renewal authorization before their existing owner-key wipe.
Recovery-only backup opening does not opt in. Status requests use owner-signed
five-minute capabilities held in memory; locking clears them. The Security
screen reports per-output coverage, pending execution, cancellation awaiting
confirmation, and the last check.
A scheduling work budget leaves additional outputs pending for the next normal
owner ceremony, without another passkey prompt.

`delegationRecovery.ts` independently checks the replacement against the
Indexer, pinned Operator, same Light recipient, batch delay, tree ancestry,
MuSig aggregate keys, and completed Schnorr signatures. Valid paths enter the
canonical SDK repository, then the existing complete-archive capture and
encrypted backup flow. A failed import retains the earlier complete archive.

The request and lifecycle tests use the actual vendored SDK with synthetic
inputs. They cover both networks, finite intent expiry, fees, committed
preconfirmed inputs, durable retry, fresh-browser discovery, reserved inputs,
read-capability expiry, and key disposal. The native runtime's synthetic signed
MuSig tree also supplies the cross-language recovery-import fixture.

Release qualification still requires a funded browser-closed renewal and
subsequent owner ceremony, payment coordination, restart and locked-Guardian
behavior, fee changes, ambiguous final submission, and an exit from the saved
replacement paths. The optional capability must remain disabled until the
required runtime qualification is complete. The stock Operator API cannot
prove that a missing cached registration was never selected for a batch, so
ambiguous cleanup can still delay payments. These local tests use synthetic transactions. Each subsequent renewal
generation still requires an ordinary owner ceremony.
