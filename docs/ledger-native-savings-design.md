# Ledger-compatible native Savings

Status: implementation foundation, 2026-09-08. Ledger is the primary signing target for this candidate. The earlier [unchanged-contract assessment](native-savings-signers.md) remains applicable to existing addresses; this candidate deliberately creates a new contract.

## Product flow

Enrollment connects the Ledger, obtains a dedicated account xpub and origin, and registers one named Savings policy. Vaulted stores the returned policy authorization together with the exact policy, key origins and recovery package. The user verifies the Savings receive address on the Ledger before funding.

A normal withdrawal contains the Savings input, the Spending destination and any Savings change. The Ledger reviews the real recipient, amount and fee, then signs the Savings input with DEFAULT or ALL. The phone supplies the other signature, and Vaulted verifies both signatures against the retained transaction before broadcast. This path has no connector reserves, external approval input, program packet, anchor, Guardian signature, or Emulator signature.

Recovery uses a dedicated coordinator and may involve additional descriptor registrations, service interactions and timed stages. The same Ledger seed supplies its recovery keys; its separate derivation paths share the existing seed backup. More involved recovery is an accepted usability tradeoff, while its authority and service dependencies require explicit validation.

Ledger validates the registered Bitcoin policy and transaction. It does not execute the Guardian or Emulator's recovery program or establish that its output restrictions are enforced. Recovery registration therefore needs independent contract reconstruction and program evaluation even when the device accepts the Miniscript.

## Executed evidence

Both Standard and Advanced candidates registered, returned the expected receive and change addresses, and signed partial and full withdrawals in Speculos. Their review screens displayed `Vaulted Savings`, the complete external destination, amount and fee. Partial withdrawals recognized Savings change through the registered policy. All four hardware signatures used DEFAULT and verified against the original transaction; changing the recipient, amount, change address or output list invalidated the signature.

| Withdrawal, both tiers                        | Complete signed size |
| --------------------------------------------- | -------------------: |
| Full, one Taproot recipient                   |               169 vB |
| Partial, Taproot recipient and Savings change |               212 vB |

These fixtures have one Savings input and a synthetic parent transaction. Signature verification and simulator review passed; funded Bitcoin acceptance and recovery were outside this run. Transaction sizes are independent of the fixture's chosen 1,000-sat fee. Actual fees depend on the chosen feerate and transaction shape.

The executed binary is Bitcoin Test 2.4.2, built from Ledger source `2c7956fe566bd7f6f690288130033441fabc5f10` with include-path adjustments documented in [the earlier Ledger harness](../tools/connector-signers/LEDGER.md). Its SHA256 is `db1608c935989d39fda91054bfff5e02460d6cfc79d21ca0646a7dc5a6ec03b9`; the environment uses Speculos 0.27.0 and client 0.4.0. This qualifies that simulator build, with physical hardware and the distributed production binary still requiring tests.

The initial Standard run passed registration and both address checks but reached the harness's 240-second deadline while loading a transaction. The initial JSON labels registration false because its error handler replaced the successful intermediate result; the display trace records the earlier steps. The revised harness preserves intermediate results and uses a 900-second deadline. Standard completed successfully on that rerun. Simulator timing is affected by the emulation environment; physical-device latency remains to be measured.

Evidence and reproducible entry points are in [the native signing harness](../tools/native-savings-signers/README.md).

The implementation rerun uses the shared wallet constructors and context-bound chain codes. Both tiers passed registration, address agreement and both withdrawal cases again. All recorded payment screens match the expected full-detail flow, with one final signature approval and no additional warning screen. The relevant wallet suite passed 281 tests; typecheck and lint passed after initializing the pinned recovery submodule. Runtime Savings tests, race tests and vet passed, including byte-for-byte agreement with the wallet's public vectors.

## Policy construction

The candidate uses the same logical Savings branches as the original native design:

| Branch                       | Required authorities                                   |
| ---------------------------- | ------------------------------------------------------ |
| Normal withdrawal            | Phone normal key and Ledger normal key                 |
| Phone recovery initiation    | Phone recovery key and both program cosigners          |
| Hardware recovery initiation | Ledger recovery key and both program cosigners         |
| Advanced recovery initiation | Separate recovery authority and both program cosigners |

Ledger requires disjoint derivations when a key expression occurs in multiple branches. The candidate assigns normal keys to `/<0;1>/*` and recovery-initiation keys to `/<2;3>/*`. The two branches within each expression represent receive and change. Account origins are BIP86, `m/86'/0'/account'` on mainnet and `m/86'/1'/account'` on Mutinynet, with account numbers zero through 100. Construction accepts public account xpubs whose depth, child index and network match their origins. Ownership remains subject to device registration; parsing an xpub alone cannot prove it.

The internal key derives from a BIP341 NUMS point encoded as an extended public key. Its chain code is deterministic and public. Public derivation adds known tweaks to a point with an unknown discrete logarithm, preserving an unspendable key path under the standard assumptions. The implemented context commits the vault, network, tier, contract version, Spending policy digest, user account origins, phone authentication key and both cosigner bases. Client and server independently reconstruct the same length-prefixed encoding. Program parents additionally commit the exact program hash, claimant and cosigner role.

Standard uses seven policy entries: NUMS, phone, Ledger, and two program cosigners for each of the two recovery-initiation branches. Advanced adds a recovery authority and its two program cosigners, for ten entries. Both templates fit Ledger's fifteen-key and 512-byte template limits. Every onchain cooperative leaf remains two ordinary signature checks.

## Recovery cosigner derivation

The existing recovery cosigner key is a base key tweaked by the hash of its exact program. Ledger needs keys derived from an xpub, so the candidate places that program-tweaked point at an xpub parent and derives the required receive/change child afterward:

```text
enrolled cosigner base
  → existing program-specific public/private tweak
  → extended parent with a canonical public chain code
  → allowed receive/change child at the enrolled index
```

Wallet and runtime tests check that public and private BIP32 derivation produce identical child keys after the program tweak. Four shared vectors cover both networks and protection tiers, including identical policy templates, key vectors, receive addresses and change addresses. They use actual v1 transition programs with inherited quarantine and pending destinations. The complete new recovery contract, its final families and registrations still require construction and qualification.

Both signing services must reconstruct the named program, chain code and permitted derivation from the immutable enrollment. The signer verifies the prevout and Tapscript commitment, evaluates the program against the exact transaction, derives the expected child inside its key boundary, and returns only the appropriate signature. The caller cannot choose an arbitrary chain code, child path, program or signing digest.

Current runtime signing derives the program key directly in `internal/application/signer.go`; it lacks this post-tweak BIP32 step. The program reader and expected-key validation also assume the existing key derivation. Supporting the candidate therefore requires a coordinated named-contract change in the Guardian and Emulator integration. A successful Ledger signature alone cannot establish recovery compatibility.

## Addresses and recovery state

Ledger policies describe receive/change address families. The prototype exercises receive index zero and change index zero. Enrollment and the Recovery Kit must identify the exact permitted coordinates and resulting scripts, and the wallet must retain each input's origin when spending change later. A test that sends change without subsequently recovering or spending it is incomplete.

For the first product implementation, restrict accepted addresses to explicitly enrolled coordinates and reject other derived addresses. The final recovery design must specify whether these outputs converge on shared quarantine/pending destinations or have separate recovery families. That choice affects recovery registration and archive size and remains open until the funded lifecycle tests are defined.

Phone key derivation and backup restoration must be revised together. Existing phone scalar storage cannot be treated as an HD account silently. Hardware account origins, program xpub construction data, policy identifiers, Ledger authorization HMACs and permitted coordinates belong in the recovery package. Lost HMAC metadata should be recoverable through policy re-registration with the same Ledger seed and exact descriptor.

## Security requirements

The normal path preserves phone-plus-hardware authorization without online cosigners. Recovery-enabled paths retain their existing cosigner enforcement and availability assumptions. Their presence means phone plus compromised cosigning keys remains a distinct attack case; that trust boundary remains part of the new derivation scheme.

Release requires executable coverage for changed recipients, amounts, extra outputs, change substitution, invalid prevout values, altered control blocks, wrong policy registrations, key-origin substitutions, unauthorized indices, forbidden sighash modes and malformed program derivations. Verification must also cover the alternate recovery leaf after a normal approval, so a signature for one leaf cannot be reused to authorize another.

The full recovery suite must exercise lost phone, lost Ledger, advanced recovery authority, service unavailability, quarantine, clawback and matured claims. It must cover receive coins and change coins, and verify that every required signer can complete its step. Specialized recovery tooling is acceptable; extracting the Ledger seed into another machine as a routine requirement is outside the intended flow.

## Delivery order

1. Prove policy registration, address derivation, direct signing and transaction review in Speculos, with cryptographic mutation checks and complete size measurements.
2. Specify the complete named recovery contract and key derivations, including phone backup migration, receive/change coordinates and the Recovery Kit schema.
3. Implement client/server reconstruction and a narrow evaluated-program signing capability, with cross-language vectors and adversarial tests. Keep this work separate from the embeddable-engine architecture refactor.
4. Exercise funded regtest normal and recovery lifecycles, then repeat registration, review, cancellation, reconnect and signing on a physical Ledger.
5. Prepare an isolated RC candidate only after those gates pass. Existing native and connector coins need explicit migration transactions; their funded scripts remain unchanged.

## Reuse and removal

The first implementation lives in wallet `program/ledgerNativeKeys.ts` and `program/ledgerNativePolicy.ts`, with matching runtime `internal/vault/savings/ledger_keys.go` and `ledger_policy.go`. Both use the existing native Savings leaf constructor. The qualification harness now calls that implementation; its duplicated tree and ad hoc key construction have been removed.

| Component                                                                                     | Implementation direction                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native Savings PSBT construction and signature verification                                   | Reuse `savingsSpend.ts`, adding enrolled input origins and Ledger change metadata.                                                               |
| Recovery transitions, chain observation and timed claims                                      | Reuse the native recovery machinery; adapt key selection and qualify every Ledger participation step.                                            |
| Exact transaction persistence and lost-response handling                                      | Retain existing lifecycle guarantees while removing connector-specific fields.                                                                   |
| Recovery Kit, enrollment and address pins                                                     | Extend with account origins, policy authorization and the new contract binding. Existing records retain their original identities.               |
| Reserve funding, dual-input approval, connector proof packet and connector withdrawal screens | Remove from the new enrollment and withdrawal path once the native path passes its gates.                                                        |
| Already-funded connector contracts                                                            | Keep the required migration/signing path until funds and unresolved operations are explicitly migrated, then remove the obsolete implementation. |

The database retains its current authenticated schema and migration history. Restoring the prior native contract model does not mean reverting database versions or reinterpreting funded scripts. The new identity is `phone-ledger-recovery-savings-v1`; it remains absent from the live template registry and Contract Pack during qualification. There is no new user-facing contract selector, signing endpoint or RC deployment in this implementation increment.
