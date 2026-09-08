# Spending to Bitcoin settlement

A payment must either produce a verified Bitcoin commitment or retain an operation that can be checked safely. Passkey approval alone is never success. A definite rejection releases the reservation and shows a visible error; a lost response keeps the reservation until the Guardian establishes the outcome.

The page creates a temporary signing view over the vault's existing SDK wallet and contract repositories. The phone key exists only during the passkey ceremony. `wallet.settle()` owns intent construction, batch participation, tree validation, forfeit construction and the spent-input database update. The existing named Guardian program still authorizes the exact input, Bitcoin outputs, fee, protected Spending change and registration expiry.

A narrow provider adapter routes registration and final submission through the Guardian. Public SDK signing hooks bind the saved expiry and retain the cancellation proof. The batch handler captures the evidence the Guardian independently validates. Generic SDK intent persistence is omitted for this signing view: its automatic cancellation state cannot represent an ambiguous Guardian operation. The durable Guardian ledger and existing local Bitcoin journal remain authoritative. No phone signing key or generic background retry is introduced.

Checking status does not submit registration or request cancellation. A separate cancellation action uses the retained owner proof, and cannot release an operation with final evidence merely because its input still appears unspent. Closing the page before batch completion may require cancellation after reconciliation; silently creating another payment is forbidden.

The SDK's completed settlement updates the existing wallet repository. History includes the input's settlement commitment in the vault's transaction scope. A confirmed journal is retained until both its replacement exit path is backed up and native history contains the outgoing payment, preventing a gap between pending and confirmed history.

Operator rejection diagnostics preserve only bounded, sanitized message text. They discard response details and redact long opaque values. Diagnostic text does not broaden the set of responses that can prove non-admission or release allowance.

The release keeps the current one-input program and protected-change minimum. Qualification must cover a second payment from the first payment's change, rejection before batch admission, ambiguous final submission, explicit cancellation, reload reconciliation and history handoff. Mainnet activation requires the existing interactive Guardian unlock; staging a binary does not authorize restarting a locked service.

Reference implementations: Arkade Wallet `src/lib/asp.ts` at f2e6dd6 and SDK `Wallet.settle` at the wallet's pinned 5521062. The SDK archive and enrollment contracts remain unchanged.

## Review and qualification

The signing view has automatic settlement disabled. Its provider cannot submit an unapproved registration directly to the Operator or cancel a Guardian operation during generic SDK cleanup. The SDK dependency archive, named program, enrollment format and database schema are unchanged. Review confirmed that the SDK omits intent persistence when no intent repository is supplied.

A funded Mutinynet wallet received 10,000 sats, funded two 500-sat signer outputs, then paid 1,500 sats from the first payment's change. Both payments confirmed and appeared once in history after reload, leaving 7,500 sats. The approved fee was zero on this deployment; assertions use the actual quote. A resumed run verified the saved second payment and captured updated recovery data without sending another payment.

This establishes the shared SDK settlement and history path. It does not establish why the earlier mainnet registration was rejected: the previous Guardian discarded that response. The mainnet retry must be checked after activating rejection diagnostics. No mainnet payment was initiated during this qualification.
