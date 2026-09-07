# Security model

Vaulted supports mainnet and Mutinynet with distinct compiled parameters.
Security depends on the enrolled program, required keys, current transaction
paths, and enforcing services. A passing test suite does not establish physical
hardware compatibility or eliminate browser and service compromise risks.

## Enforced checks

- Enrollment fixes the wallet mode, permitted keys, policy, network, and
  descriptor. The wallet and Guardian reconstruct scripts independently.
- Spending reservation and transaction approval are separate authenticated
  steps. The complete transaction, fee policy, inputs, and checkpoints remain
  bound to one persisted operation.
- Unknown submission outcomes reconcile against retained evidence. Inputs remain reserved and new payment authority remains unavailable solely
  because a request timed out.
- Connector v2 verifies both hardware `SIGHASH_SINGLE` approvals and canonical
  transaction layout in the wallet, Guardian, and Emulator. Imported signatures
  cannot change the requested recipient or protected change.
- Per-vault worker scopes and storage isolate wallet identities. The worker
  boarding key stays scoped to the named program and fixed Spending destination.
- Backup transport uses purpose-bound passkey sessions, authenticated records,
  and compare-and-swap revisions. An archive session grants no signing authority.

## Trust assumptions

The Guardian owns the authoritative Spending allowance and its signing key.
The gateway secret authenticates the web deployment to that service; user
passkeys and transaction proofs provide separate authorization. Tenant and
operation identifiers on capability-based read routes must remain private.

Connector Savings relies on its online cosigners to enforce the external signer
and transaction policy. The device key plus both online signing keys can bypass
that policy. Bitcoin validates signatures and scripts but does not execute the
Emulator's Arkade Script program. Older direct-hardware Savings has a different
normal-spend leaf; app updates preserve the enrolled family.

A compromised web origin can attack an unlocked browser session. Passkeys do
not protect the user from malicious application code running after unlock.
The supplied Guardian software and Linux packaging provide no remote
attestation, TEE, or HSM-backed signing guarantee. Host isolation and key
protection depend on the deployment.

Authenticated database rows and the independent policy sequence detect
inconsistent state and database rollback relative to the sequence. Restoring
both to the same earlier point can defeat that detection. Runtime declarations about storage independence require separate infrastructure
verification.

## Availability and recovery

Online service failure can pause cooperative Spending, new connector Savings
payments, and service-assisted recovery. An independent exit requires the
signatures, saved transaction paths, fees, and delays of its exact script.
A public Recovery Kit alone may lack the data needed to spend.

The original passkey is needed to decrypt a passkey-protected key envelope.
Provider synchronization and account recovery determine availability on another
device. Encrypted cloud storage cannot recover a key after every usable copy
of its passkey is lost.

Archives cover their capture time. A fresh device cannot prove that an older,
valid encrypted archive is the latest copy without additional state. Browser
suspension can delay backup updates, recovery monitoring, and reconciliation
of delegated renewals. The application provides no continuously available
watchtower guarantee.

A worker operation already authorized for the exact boarding destination may
finish during logout. Web Locks and acknowledged teardown protect concurrent
work; they cannot forcibly terminate an executing browser service worker.

Software-wallet and firmware-simulator tests qualify only their documented
scope. See [signer compatibility](connector-signers.md) before selecting a
signing device. Keep raw hardware and recovery keys out of the wallet page.

Report suspected vulnerabilities through [SECURITY.md](../SECURITY.md).
