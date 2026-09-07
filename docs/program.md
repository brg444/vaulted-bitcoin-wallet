# Wallet programs

The wallet reconstructs its programs from authenticated enrollment facts and
network-specific parameters. [Mutinynet](../src/lib/vault/contract-pack.json)
and [mainnet](../src/lib/vault/contract-pack.mainnet.json) Contract Packs must
match the Guardian. Updating the app does not change an enrolled Bitcoin script.

## Spending policy

Standard and Advanced use `vault-policy-v1`; Light uses
`vault-light-policy-v1`. Cooperative Spending requires the owner, the policy
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

## Savings and connector versions

Light Savings is watch-only. Standard and Advanced retain the Savings family
selected at enrollment:

| Family                                | Normal approval and reserves                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `phone-hww-recovery-savings-v1`       | Device and hardware signatures on the Savings input                                                                                      |
| `phone-connector-recovery-savings-v1` | Device, Guardian, and Emulator approval, followed by one conventional signer input with a returned 1,000-sat reserve                     |
| `phone-connector-recovery-savings-v2` | Two conventional signer inputs, each with a returned 500-sat reserve; external approval precedes device, Guardian, and Emulator approval |

New connector enrollments use `savings-connector-dual-v2`. Its external
signatures use `SIGHASH_SINGLE` without `ANYONECANPAY`. The first commits to
the recipient; the second commits to Savings change, or the first returned
reserve for a full withdrawal. The Emulator independently verifies both
commitments and the complete program packet. Savings signatures commit to
the completed transaction, including that packet.

Savings pays the recipient, network fee, and 240-sat anchor. Reserves return in full, and partial withdrawals return Savings change to the
enrolled script.
A transfer to Spending pays the enrolled boarding address.

The connector's signer requirement depends on its online enforcing cosigners.
Bitcoin does not execute the Emulator program. The device key together with
both online signing keys can bypass that policy; this differs from the direct
hardware-signature leaf of older Savings. See [security](security.md).

## Delayed Savings recovery

Standard forbids a separate recovery key, while Advanced requires one distinct
from the device and hardware roles. Creating a new delayed recovery requires its
service approvals. The resulting Pending output uses the enrolled claimant
and a block delay: hardware 6, device 144, or recovery key 288 blocks.

The waiting period starts when Pending confirms. Remaining guardian keys can
use the exact cancellation and Quarantine paths committed in the saved script.
Waiting alone does not add a service-independent path to normal connector
Savings. A completed, saved authorization can support only its exact retained
transaction.

Public kits and encrypted archives carry different information. Follow
[recovery with saved files](emergency-recovery.md) before relying on either.
