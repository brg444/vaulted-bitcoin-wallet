# Delegated Spending renewal

Light, Standard, and Advanced can authorize finite renewal requests for current
Spending outputs. When the Guardian advertises the native delegation
capability, it can execute those retained requests while the browser is closed.
Each replacement output or later receipt needs another owner authorization.

## Authorization

The wallet constructs requests with the vendored SDK and binds the exact input,
enrolled script, receiver value, delegate key, fee, and dispatch deadline.
Registration authority has a finite lifetime. A separate input-scoped deletion
proof permits cleanup without authorizing a payment.

Ordinary unlock, restoration, enrollment, and payment ceremonies can authorize
eligible renewal work before the owner key is cleared. Recovery-only backup
opening does not authorize renewals. Reserved payment inputs are excluded;
new change waits for a subsequent owner ceremony. Work beyond the current
scheduling budget remains pending for a subsequent owner ceremony.

The request is persisted before submission. Ambiguous replies reconcile the
same signed bytes and operation ID. Locking discards read and cancellation capabilities, which also expire according
to their bounded authorization lifetime. Security displays reported coverage and errors;
service availability alone does not prove that an output is scheduled.

## Execution and payment coordination

Armed requests leave Spending allowance unchanged. Guardian claims an eligible
input under the shared execution fence and reserves its renewal fee. Principal
returns to the same enrolled program. Conflicting payments and renewals cannot
both acquire the input.

The Guardian validates transaction trees and signing transcripts before
releasing the final forfeit. Uncertain registration, submission, or deletion
outcomes retain their fences until supported evidence resolves them. An
Operator no-match response does not establish that an intent was never selected.
These constraints can delay a payment even when no new signature is permitted.

## Recovery data

The wallet independently verifies replacement ancestry, recipients, Operator
keys, and completed signatures before importing paths into its SDK repository.
The next unlocked session captures and uploads a complete encrypted archive.
A failed import preserves the earlier complete copy.

Guardian does not retain the owner's backup encryption key. A renewal completed
while the browser is closed does not automatically update the encrypted cloud
archive. A saved file covers its capture time and may omit that replacement.
The original passkey and complete saved paths remain necessary for the
corresponding recovery flow.

The server's [shared Spending API](https://github.com/brg444/arkade-runtime/blob/main/docs/spending-delegated-renewal.md)
and [execution contract](https://github.com/brg444/arkade-runtime/blob/main/docs/light-delegated-renewal.md)
describe request formats, limits, and durable states. Local SDK fixtures cover
request construction and validation, while live network settlement and physical
signer compatibility require separate checks.
