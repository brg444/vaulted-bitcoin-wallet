# Operator-compatible Savings contingency

Status: preparation only, 2026-09-05. This branch starts from wallet main `53c597393c68374afaec06108a8f803f24d7de6e`; production contracts, enrollment, network configuration, and deployment behavior are unchanged.

The canonical architecture and timelocked-recovery work packages live on runtime branch `codex/operator-gated-contingency` in `docs/contingency/hardening.md` and `docs/contingency/implementation/native-savings.md`. Runtime baseline is `a70823a28b596195e033c4c25e48d8d82e22a72d`. Fetch current main and compare actual deployment manifests again before implementation or release.

Native Savings is the contingency candidate. Its cooperative transaction must satisfy the stock Operator's input and checkpoint requirements. A native connector requires new admission and device-review tests beyond the existing ordinary Bitcoin connector qualification.

## Connector reconciliation, 2026-09-06

The [canonical reconciliation](https://github.com/brg444/arkade-runtime/blob/codex/operator-gated-contingency/docs/contingency/connector-reconciliation.md)
assigns native Savings and recovery implementation to this contingency. The
connector branch supplies immutable-handoff checks, program/consensus
counterexamples, and Electrum/Sparrow test adapters. Its onchain contract,
1,000-sat reserve, fixed output layout, and existing signer results remain
experimental references; none establishes native compatibility.

First prove actual destination review and signing for an admitted native
transaction. Direct signing may remove the connector if supported. Keep the
strict all-online-keys compromise result separate from the accepted honest-cosigner
alternative, and prove the complete timelocked exit after spend and renewal.
Enrollment, reserve tracking, and migration follow those results.

Fetched main is now `7687134f9be2428062a841aad4c71821c0c230ae`, including the merged
Light lifecycle and wallet updates; runtime main is `15a83fb`. Incorporate reviewed
current main before implementation. This preparation branch retains its historical
baseline and is unsuitable as a replacement RC build.

## Wallet integration sequence

- Qualify the accepted transaction shape and hardware display of destination, amount, change, and fee before building enrollment or durable connector tracking. Keep program enforcement and Bitcoin signature enforcement as separate outcomes.
- Establish every spendable leaf and key-path authority in the runtime contract, including outage and key-loss recovery. A new script needs a new descriptor and address; the existing funded contract cannot be changed through configuration.
- Adapt the qualified Light recovery archive and Bitcoin-only exit patterns under the selected Savings contract. Review `src/lib/vault/light/{recovery,recoveryArchive}.ts` on fetched main `7687134f9be2428062a841aad4c71821c0c230ae` before reuse; the original evidence inventory used `ab6c0e2e32101d21e1830166c482b02b68dcd96e`. Its owner-only exit does not establish Standard/Advanced protection.
- Save and verify the complete signed ancestry after receipt, change, renewal, and recovery transitions. Preserve prior evidence through interrupted finalization and report unresolved successor capture accurately. A seed or old recovery file alone cannot promise recovery of current native funds.
- Restore on a clean device and confirm recovery with Vault, Operator, program signer, and their indexers unavailable. Recovery can use a selected Bitcoin node or explorer and must complete with the selected user keys and signatures already retained in its archive.

## Timelocked recovery interface

The first outage target retains both phone and hardware authorization through a delayed Bitcoin exit. Loss of either key needs a separately proved initiation, pending, cancellation, and claim graph. Any proposed lone-key exit needs an explicit authority decision and separate security qualification.

Show the controlling output, required keys, unconfirmed ancestors, applicable height or median-time-past condition, recovery-data freshness, estimated fees, and any expiry deadline. Distinguish waiting for an ancestor to confirm from waiting for a relative lock to mature. The existing mainnet Spending delay and Savings claimant delays are different contracts; use the exact new descriptor once qualified.

If a recovery file is stale or incomplete, identify the limitation without presenting a completed-recovery promise. Retain import/export outside the ordinary app session, including browser-storage failure and unavailable passkeys, subject to possession of the selected recovery keys.

## Release boundary

Production integration requires the canonical plan's native admission, hardware trust, full recovery, compatibility, and privacy gates. Include new shared wallet/runtime vectors and mixed-generation recovery tests. Preserve the deployed baseline and both generations' artifacts during any later migration. This branch creates no production feature flag, public signing route, dependency upgrade, or deployment action.
