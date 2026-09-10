# Light wallet

Light uses the same Spending enrollment, passkey access, worker, boarding,
payment, history, backup, and recovery workflows as protected wallets. Its
`vaulted-spending-v1` enrollment creates the shared `vault-policy-v1` Spending
contract with an explicit device-only delayed exit. Cooperative payments still
require the phone, Guardian, and Arkade Operator. Per-payment and rolling limits
are fixed at enrollment.

New Light wallets receive both a Spending address and a Bitcoin boarding
address. Lightning addresses and invoices use the same Receive screen and
service configuration as protected Spending. When an address is configured,
Receive shows it with a Create invoice action and access to Bitcoin receive.
The balance denomination applies throughout both account screens and history.

Savings remains in navigation as a watch-only Bitcoin account. Adding an
address enables its balance and transaction history without adding a signing
key or protected Savings contract. Sending and transfers from that watched
address are unavailable.

Setup uses the common passkey enrollment and encrypted backup workflow.
Light requires no hardware or separate recovery key. Its public Recovery Kit
and complete recovery package contain Spending and boarding data. A delayed
Spending exit requires the phone key; protected Standard and Advanced keep
their enrolled signing requirements. Bitcoin access, fees, and committed
waiting periods still apply.

The worker captures transaction paths while available. An incomplete capture
preserves the last complete archive; later payments and renewals need updated
paths. Save a separate recovery package and matching companion application.
See [recovery with saved files](emergency-recovery.md) for passkey, signing,
and freshness requirements.

This enrollment replaces the separate Light application for new wallets.
Existing `vaulted-light-v1` enrollment files are not migrated by the new setup.
The older [automatic backup](light-automatic-backup.md) and
[delegated renewal](light-delegated-renewal.md) documents describe that legacy
contract and its saved-file support.
