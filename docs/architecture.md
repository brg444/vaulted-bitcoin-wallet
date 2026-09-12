# Architecture

The browser wallet communicates through same-origin routes with the Guardian,
Arkade Operator, and Bitcoin data services. Each component verifies the facts
needed for its own signing or transaction role.

| Component       | Responsibility                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Browser wallet  | Passkeys, program reconstruction, transaction review, external signing handoff, and encrypted backups                        |
| Scoped worker   | Persistent SDK wallet, contract and transaction repositories, VTXO updates, and boarding coordination                        |
| Guardian        | Authenticated enrollment, policy ledger, constrained service signatures, recovery archives, and authorized renewal execution |
| Arkade Operator | VTXO indexing, collaborative transactions, and Batch Output coordination                                                     |

## Source map

`src/index.tsx` starts the wallet. `src/VaultApp.tsx` and the Vault
provider compose navigation and state; `src/screens/Vault` contains the flows.
Program construction, validation, persistence, and transaction coordination
live under `src/lib/vault`. Network selection and build checks reject
inconsistent app, worker, and Guardian configurations.

Light and full-wallet account screens share `AccountHome`; Security shares
`SecurityOverview`. Mode-specific data supplies the supported capabilities and current account state
to those shared components. [Interface components](interface-system.md) describes the
layout and accessibility checks.

## Keys and worker ownership

A passkey PRF unwraps the enrolled phone key for a bounded operation.
The page clears unlocked key material afterward. Hardware and recovery keys
stay in external signers; requests and replies exchange validated PSBTs.

Each enrolled wallet uses scoped worker messages and isolated IndexedDB
repositories. A separate boarding key is provisioned after PRF unlock and
remains in the worker's scoped storage. Boarding requires the Guardian and
Operator and pays the enrolled Spending program. The worker holds no phone
signing key.

The vendored SDK owns Wallet, Contract Manager, VTXO state, intent persistence,
and batch coordination. Vaulted adapters enforce named program boundaries.
Generic SDK spending cannot select protected `vault-policy-v1` outputs;
ordinary payments use the Guardian-authorized operation flow.

## Durable operations

A Spending operation is persisted before its authenticated reservation. The
wallet binds its destination, amount, fee policy, selected inputs, and signing
proofs to the same operation ID. Before Operator submission it retains the
required pending-transaction proof. Ambiguous responses reconcile the exact
operation and transaction; an unknown outcome does not authorize a replacement
payment.

Ledger Savings retains the exact reviewed transaction through phone and Ledger
approval. Imported signatures must match that candidate before submission;
normal Savings approval does not use a signer reserve or a separate evaluator.
See [programs](program.md) for the retained recovery authority.

Outbound Lightning uses `@arkade-os/swap` for quotes, VHTLCs, and payment state.
Funding passes through ordinary Spending authorization, while refunds require
the appropriate owner ceremony and exact enrolled destination.

## Renewal and backups

Guardian renewal executes finite owner-presigned requests. It cannot create
new owner authority after the wallet locks. Replacement recovery paths are
validated before import into the SDK repository. On the next unlock, the wallet reconciles those paths with the encrypted archive
that contains its saved transaction and key-unlock data.

Cloud storage holds ciphertext and an authenticated public header. A backup
session cannot authorize payment. Capture, revision checks, and the last
complete archive prevent an incomplete update from silently replacing a
complete copy. A closed browser cannot continuously upload new encrypted data.

See [security](security.md), [backup synchronization](backup.md),
and [dependencies](upstream-alignment.md) for the corresponding boundaries.
