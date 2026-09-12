# Wallet programs

The wallet reconstructs its programs from authenticated enrollment facts and
network-specific parameters. [Mutinynet](../src/lib/vault/contract-pack.json)
and [mainnet](../src/lib/vault/contract-pack.mainnet.json) Contract Packs must
match the Guardian. Updating the app does not change an enrolled Bitcoin script.

## Spending policy

Every wallet uses `vault-policy-v1` Spending. Cooperative Spending requires the owner, the policy
cosigner, and the pinned Arkade Operator. The Guardian enforces per-payment,
rolling 24-hour, and fee limits before signing. Bitcoin Script does not compute
the rolling allowance.

The Lower exposure preset allows 25,000 sats per payment and 50,000 sats per
rolling 24 hours. Everyday allows 50,000 and 100,000 respectively. Custom values must satisfy the published policy bounds, with fee ceilings of
5,000 sats and 10 sat/vB. Enrollment freezes the complete policy and its
canonical digest before the wallet can use that program.

The delayed Spending exit requires the device and hardware keys for Standard,
hardware and recovery keys for Advanced, and the owner key for Light. Exact
maturity comes from the enrolled script. These exits also need current Bitcoin
transaction paths and fees.

## Optional Ledger Savings

Light Savings is watch-only. Protected Standard and Advanced accounts use
`phone-ledger-guardian-savings-v1`. Normal payments require phone and Ledger
signatures on the Savings input, with DEFAULT signatures committing to the
complete transaction. There is no separate signer reserve. Partial withdrawals
return change to the enrolled Savings policy; a transfer to Spending pays the
enrolled boarding address.

## Delayed Savings recovery

Standard forbids a separate recovery key, while Advanced requires one distinct
from the device and hardware roles. Creating a new delayed recovery requires its
service approvals. The resulting Pending output uses the enrolled claimant
and a block delay: hardware 6, device 144, or recovery key 288 blocks.

The waiting period starts when Pending confirms. Remaining guardian keys can
use the exact cancellation and Quarantine paths committed in the saved script.
Starting a recovery transition requires the enrolled user and Guardian
authorities. A saved completed transition supports its exact committed path;
waiting alone does not create an authorization. See [Ledger recovery](ledger-guide.md)
for the recovery-leaf trust assumptions.

Public kits and encrypted archives carry different information. Follow
[recovery with saved files](emergency-recovery.md) before relying on either.
