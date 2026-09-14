# Ledger Savings release qualification

The retained wallet model is shared Spending with optional Ledger Savings under
`phone-ledger-guardian-savings-v1`. Historical Light, direct-hardware Savings and
both connector generations are removed from enrollment, signing and recovery.
The current Ledger implementation requires the matched wallet, Guardian,
Contract Packs and recovery companion.

New Ledger enrollment remains gated by `VAULT_LEDGER_SAVINGS_ENABLED` and by
physical registration and recipient, amount and fee review with the production
Bitcoin app. That gate requires evidence from the physical device and production app.

## Recovery outcomes

Normal Savings payments require phone and Ledger signatures on the Savings
input. Recovery supports initiation, Guardian cancellation, delayed claims,
cancellation with the remaining keys and quarantine withdrawal. The workflow
retains approvals before dispatch and resumes exact saved transactions.

Emergency Spending preserves the enrolled signature threshold: Standard
requires phone and hardware; Advanced requires hardware and recovery. The
external Spending authorities derive from the enrolled BIP86 account at `/12/0`.
The offline signer verifies the account and transaction before accepting a seed,
refuses online use and clears seed fields after signing.

Fee funding uses the enrolled hardware account's ordinary Taproot receive key
at `/0/0`, or the recovery account for Advanced. Each request includes the
complete exit graph and funding parents. The signer checks the destination,
fee caps and change; missing paths or required authorities prevent recovery.

## Evidence and candidate gates

The committed [integration qualification record](../tools/native-savings-signers/evidence/ledger-integration-qualification.json)
and [contract qualification record](../tools/native-savings-signers/evidence/ledger-guardian-qualification.json)
bind their test results to specific source and artifact revisions. They cover
service authorization, funded regtest paths, simulator signing, offline signing
and restoration. Any candidate changes to those inputs require verification at
the candidate revision. A later build requires evidence covering its changed inputs.

Candidate qualification must include retained Spending and Ledger vectors,
interruption and replay tests, full wallet and runtime checks, browser and
accessibility checks, and independent recovery on both networks. The complete
frontend and gateway must come from the same integrated source revision, with
worker hashes, Contract Packs and companion inputs verified together. See
[testing](testing.md) and the repository [release instructions](../AGENTS.md).

## Activation

Guardian uses schema 12 with authenticated account and operation records.
Database backups and the independent policy sequence must preserve consistent
economic state. Follow the [runtime storage contract](https://github.com/brg444/arkade-runtime/blob/main/docs/storage.md)
when planning activation or recovery.

A Guardian restart requires its configured interactive unlock procedure.
Deploy the matched wallet and companion only within the separately scoped
release, then verify readiness, source identity and retained-account sign-in
before assigning the RC alias. Physical Ledger checks precede enabling new
Ledger enrollment; the public application alias has a separate release scope.

Closed-browser renewal, delivery of updated exit paths outside the device and
cloud-provider setup retain their documented availability constraints.
