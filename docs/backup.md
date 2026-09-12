# Encrypted recovery backups

Shared Spending and Ledger Savings use the same encrypted recovery archive.
The archive contains the enrolled identity, protected key material, payment
records and available transaction paths. Cloud storage receives ciphertext
and an authenticated public header; it cannot decrypt the wallet without the
original passkey.

A passkey ceremony opens a bounded recovery session through
`/v1/recovery-archive`. The session permits archive access and carries no
payment authority. Revision checks prevent a conflicting update from silently
overwriting the acknowledged copy. A fresh device still needs additional
state to establish whether an older, valid encrypted backup is the latest copy.

The SDK worker captures Spending transaction paths into its persistent
repository. Archive capture uses those local records before requesting missing
facts from the indexer. An incomplete or failed capture preserves the previous
complete archive. An event arriving during synchronization queues another pass,
while locking or closing the wallet ends background access to its backup key.
A suspended browser cannot promise continuous uploads.

Save a separate recovery package after activity. Its readable portion provides
transaction paths, while protected contents retain the key envelope and payment
records. Checking protected contents requires the original passkey, verifies
that public and encrypted paths agree, and clears unlocked keys afterward.
The saved-copy display compares transaction paths and protected records
separately, using the saved paths and records to establish agreement.

Independent recovery needs the keys, paths, Bitcoin fees and waiting periods
required by the enrolled program. See [recovery with saved files](emergency-recovery.md)
and [Ledger recovery](ledger-guide.md) for the supported signing procedures.
Historical Light files and direct-hardware Savings files are excluded from the
current companion inputs.
