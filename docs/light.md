# Light wallet

Light uses a resident PRF-capable passkey and `vault-light-policy-v1` Spending.
Its cooperative path requires the owner, policy cosigner, and Arkade Operator;
its delayed Bitcoin exit requires the owner. Per-payment and rolling limits
apply to cooperative payments and remain fixed at enrollment.

New Light setup is available when the Guardian advertises it. Admission follows
the same open or invitation-based policy as other wallet modes. Disabling new
Light enrollment does not disable existing wallets.

Automatic setup creates an encrypted backup and verifies cloud readback before
opening the wallet. It requires a passkey eligible for provider backup. A
supported passkey on another device can restore the same wallet through the
backup service. Older saved files with a separate recovery code retain their
existing restoration path.

Spending displays available funds, pending activity, payments, and receipts.
Savings is a watch-only Bitcoin address; its balance does not give Light an
additional spending key. Both account screens use the shared wallet components.

The worker tracks public wallet state. Owner authorization happens during
bounded passkey operations. Finite [renewal requests](light-delegated-renewal.md)
can let Guardian renew previously authorized outputs while the browser is
closed. Each later generation needs another owner authorization.

The wallet captures complete output ancestry and transaction PSBTs. Incomplete
capture retains the last complete archive. Saved-data recovery can prepare an
owner-signed exit using that archive without Guardian or Operator access;
Bitcoin queries, confirmations, fees, and the committed delay still apply.

See [automatic backups](light-automatic-backup.md) and
[recovery with saved files](emergency-recovery.md) for passkey and freshness
requirements.
