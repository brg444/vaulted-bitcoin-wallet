# Bitcoin payment recovery ownership

Bitcoin payment journals remain available until the payment owner has a confirmed receipt, matching SDK history and a complete durable recovery path for the exact Spending change output. Recovery capture supplies evidence of its saved file; `acknowledgeSpendingBitcoinRecovery` owns retirement under the existing exclusive Spending lock.

## Authority and identity

`spendingBitcoinFunding.ts` owns payment preparation, reconciliation, cancellation and retirement. `spendingBitcoinStore.ts` validates and persists the immutable account, operation, input, destination, plan and owner authorization. The receipt must match the retained commitment transaction and the change output in the saved final transaction tree.

The existing operation ID, signing domains, persisted namespace and event name remain unchanged. A submitted or uncertain result retains its identity and input reservation. Only the existing pre-final release rules can make an unsuccessful input available again.

`recovery/capture.ts` validates the known Spending output set before and after capture, retains the previous complete file on incomplete ancestry, and commits through IndexedDB. A pending final prevents replacement by an old output snapshot. A confirmed Bitcoin receipt requires the exact change outpoint, value and script in the replacement archive.

Capture has read access to payment facts. It has no payment mutation or SDK history import. Finalization recovery accepts only transaction and input evidence, and retains the signed successor graph before the existing finalization boundary. Network selection belongs to `networkPins.ts`; finalization has no dependency on the Spending coordinator.

## Durable evidence and acknowledgment

Capture returns `{ file, coverage }` after its IndexedDB transaction completes and the committed file is read back and validated. Coverage identifies the account, network, descriptor, file digest and archived Spending outputs. Validation compares the complete immutable account facts and verifies the exit graph. The digest identifies the saved generation; it grants no signing authority.

The payment owner performs these steps under `arkade-vault-vtxo-send:<vaultId>`:

1. Read and validate the current journal, requiring the confirmed phase.
2. Obtain SDK history and require a Spending sent row for the exact commitment transaction, with the destination amounts plus the plan fee.
3. Read and validate the durable recovery file again. When callback evidence is supplied, require the same account, network, descriptor and file digest.
4. Require the exact receipt change outpoint, plan change value and enrolled Spending script in that archive.
5. Re-read the journal and require it to be unchanged before clearing it.

Missing history, missing or invalid coverage, a different saved generation, and a changed journal all preserve the payment journal. Concurrent acknowledgment requests use the existing payment lock and can retire the operation only once. The capture callback's output list is advisory: the owner uses the outputs independently read from durable storage.

## Interruption and composition

The provider wires the recovery callback to `useSpendingBitcoin` without exposing the acknowledgment command through the broad UI context. `useRecoveryArchive` checks its session before handing off committed evidence. The payment hook handles acknowledgment failures so a history outage leaves the completed recovery copy available.

On mount, focus and the existing payment refresh interval, a confirmed journal can be acknowledged directly from durable coverage. This resumes the interval between file commit and callback, including a reload in that interval, without requiring another Guardian status response. Earlier phases continue through the existing status reconciliation before acknowledgment. Locking or unmounting during that reconciliation prevents a subsequent acknowledgment from starting through the abandoned hook effect.

## Verification and remaining boundaries

Tests cover both supported networks with Spending-only and Ledger accounts, missing and stale coverage, exact history fields, history failure and retry, submitted/finalizing retention, journal changes during observation, competing acknowledgments, storage abort, missing ancestry, account substitution and session teardown. The finalization and network dependency tests follow transitive imports; the capture guard limits its payment-store import to the reader.

The wider stable-core goal still requires payment/session controller extraction, consolidation of maintenance scheduling and removal of the broad context. Recovery codecs and archive reconstruction retain other dependencies on Spending helpers, and the Qg screen import cycle remains. Independent recovery artifacts and the final cross-repository candidate require qualification at their exact release revisions.
