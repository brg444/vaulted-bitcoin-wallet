# Ledger recovery deployment candidate

Deploy the matched wallet, Guardian and recovery companion with
`VAULT_LEDGER_SAVINGS_ENABLED=false`. Enabling new Ledger enrollment remains
conditional on physical registration and recipient, amount and fee review with
the production Bitcoin app. No physical Ledger was available for this work.
Existing funded legacy and connector wallets retain their original contracts.

## Recovery outcomes

Normal Savings uses the phone and Ledger on the Savings input, without a
connector or approval reserve. The recovery screen supports initiation,
Guardian cancellation, delayed claims, cancellation with the remaining keys,
and quarantine withdrawal. It retains approvals before dispatch, resumes exact
saved transactions and permits deletion only of unsigned drafts.

Emergency Spending keeps the original signature threshold: Standard requires
phone and hardware; Advanced requires hardware and recovery. New external
Spending keys use the enrolled BIP86 account at `/12/0`. The offline signer
checks the saved account and transaction before accepting a seed. Its page
refuses online use and clears seed fields after signing.

Fee funding uses the enrolled hardware account's ordinary Taproot receive key
at `/0/0`, or the recovery account for Advanced. Each fee request includes the
complete exit graph and funding parents. The signer checks the destination,
fee caps and change before signing. Missing transaction paths or missing
required authorities remain recovery failures; a fee key cannot replace them.

## Qualification evidence

- Ten funded Guardian service cases cover both tiers, every claimant and receive
  or change initiation. Bitcoin Core accepts the exact service-approved bytes,
  including replay after restarting the service.
- Both tiers complete funded Spending exits on isolated Bitcoin Core regtest
  with mainnet scripts and policy. The SDK parent and fee child are accepted,
  the premature sweep is rejected, and the mature sweep confirms.
- Eight offline browser cases cover Spending and fee signing across both
  networks and tiers. Online seed entry is blocked, seed fields are cleared,
  and imported signatures are verified against the requested transaction.
- Ten rendered views cover receive, setup, review, payment and recovery at
  mobile and desktop widths. The legacy portable recovery handoff also passes.
- Enrollment qualification covers capability checks before key creation,
  canonical proposal binding, registration persistence, interrupted finish and
  reload without replacing keys. Complete package restoration preserves both
  phone identities and the registered Ledger policies.
- Public Operator and configured private mainnet cosigner pins match the
  release. Guardian configuration and running services were not changed.

The integration qualification JSON records source revisions, test outcomes and
artifact hashes. The earlier primitive-level Ledger simulator evidence remains
separate from these service and recovery integration checks. Regtest success
is not evidence of a physical Ledger or a live-mainnet exit.

## Deployment sequence

1. Back up the Guardian database and retain the existing binary. Schema nine is
   additive, but rollback must use a compatible database snapshot.
2. Deploy the matched Guardian with new enrollment admission disabled. Its
   plaintext signing key is removed after load: arrange a real-TTY unlock
   before restarting the service. Never place those passphrases in chat.
3. Deploy the matched wallet and companion, then verify mainnet readiness,
   Contract Pack hashes and existing-wallet sign-in.
4. Complete physical Ledger registration and transaction display checks before
   enabling the new enrollment capability.

The implementation does not change the existing limitations around
closed-browser renewal or delivery of updated exit paths outside the device.
Cloud-provider setup remains separate from the locally retained recovery data.
