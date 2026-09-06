# Light automatic backup

Release preparation now targets the current owner-presigned delegation model,
with Guardian assessed as the delegate. The integration and qualification
requirements are in [Light delegated renewal](light-delegated-renewal.md).
The backup qualification below covers foreground renewal. A renewal completed
while the browser is closed requires recovery-data reconciliation on the next
unlock with the current backup format.

Light creates a passkey and saves an encrypted recovery snapshot without asking
for a seed, recovery code, or downloaded file. A discoverable passkey ceremony
restores the same wallet on another device. New automatic enrollment requires
a passkey eligible for provider backup; provider synchronization and account
recovery still determine whether that passkey is available on another device.

The client verifies a cloud readback before opening a new wallet. Existing
wallets can unlock locally during a backup-service outage. Older recovery files
and their recovery codes remain supported.

## Encryption and access

The owner scalar remains wrapped by the existing passkey PRF envelope. A
separate HKDF domain derives a non-extractable AES-GCM key for the complete
backup. Its authenticated header includes the original descriptor, credential,
passkey origin, and key envelope. Only the encrypted archive and public header
reach the backup service. The Bitcoin owner scalar and passkey PRF are wiped
after use. Background sync retains only the backup encryption key and an
eight-hour, memory-only backup session, which cannot authorize payments.

The new runtime routes use a single-use WebAuthn challenge plus the enrolled
direct-key proof. Reads and writes require the resulting tenant-scoped session,
while authenticated backup rows and compare-and-swap revisions prevent a
conflicting writer from silently overwriting another device's backup. Existing identity, policy and economic sequence bytes are preserved by
the additive schema-2 migration. Backup writes preserve the existing spending limits and economic sequence.

## VTXO paths and synchronization

The reviewed wallet SDK is the vendored `f0fd58d5` lineage, with the existing
selective Lightning patches recorded in `node_modules/@arkade-os/sdk/ORIGIN.md`.
In that source, `wallet/wallet.ts` installs ContractManager hooks only when a
`virtualTxRepository` is supplied. Capture defaults to `lite`, which omits
transaction PSBTs, and skips outputs below 1,000 sats. Capture errors are
best-effort; payment completion is independent of capture success.

The Light worker now supplies a dedicated `IndexedDBVirtualTxRepository` with
`exitDataCapture: { mode: 'full', minExitWorthSats: 0 }`. The ContractManager
remains the owner of wallet VTXO state. Its receive, spend and reconciliation
flows capture new branches and prune spent branches in the SDK repository.
The separate last-complete recovery archive survives a failed or interrupted
SDK capture.

Cloud sync subscribes to the persistent wallet's contract and worker events.
An event arriving during capture or upload queues another pass. Opening the
wallet, returning to the foreground, reconnecting, and a 30-second timer also
trigger reconciliation. Archive construction resolves through the SDK's local
exit repository before the indexer. The export validates the full transaction
set and compares exact outpoints, scripts and values with the SDK wallet
snapshot; an unchanged balance alone is insufficient. Missing PSBTs, an
inconsistent balance, or an unresolved disappearing output retain the previous
complete backup and show an update failure.

Cloud updates run while the wallet is open and unlocked. A suspended browser
cannot promise continuous cloud synchronization. Payments received while the
app is closed require reconciliation on the next wake. A downloaded file is a
snapshot, and its capture time is visible in recovery. Ciphertext is capped at
3 MB and decompression at 13 MB; oversized data fails explicitly and is never
truncated. The existing recovery archive limits also remain enforced.

A device remembers its highest acknowledged cloud revision. This detects a
rollback relative to that device's history. A fresh device cannot establish
freshness against a malicious or rolled-back storage service solely from an
old, correctly encrypted file. It must reconcile current VTXOs when online.

## Unilateral exit

The recovery snapshot carries the original Light descriptor and delayed owner
script, current VTXO outpoints, complete ancestry, transaction PSBTs, Operator
parameters, and the encrypted owner key. A Bitcoin destination is chosen at
recovery time. The existing SDK `UnilateralExit.prepare` builds and signs the
graph using the saved archive; the executor requires Bitcoin chain access,
network fees, and the committed waiting periods. It does not request a Vaulted
approval or contact the Operator when saved-data mode is selected.

`tools/light-emergency` builds an independent companion for
`brg444/vaulted-emergency-recovery`, including source maps. The original passkey
origin needs a local server with trusted HTTPS after a website outage;
WebAuthn cannot unlock that passkey at an unrelated localhost origin. A prepared
exit can also be exported in the SDK's standard package format for
`arkade-os/arkade-unilateral-exit` (reviewed at `718e90a`). That executor supports
graph packages and can supply its own fee wallet without the Light owner key.
Its separate fee funding address must be followed when using that executor.

The automatic flow depends on access to the original passkey or its provider's
account recovery. It does not recover an owner key after every copy of that
passkey is permanently lost. Cloud storage alone cannot decrypt the wallet.

## Qualification on September 6, 2026

A fresh Mutinynet browser wallet received 50,000 sats and automatically saved
52 transaction PSBTs at cloud revision 2. A 10,000-sat payment produced a new
40,000-sat change output, saved with 54 transaction PSBTs at revision 3.
Renewal replaced that outpoint with a new confirmed path, saved at revision 5.
After both the Vaulted API and Operator were blocked, the downloaded encrypted
snapshot prepared the full 40,000-sat owner exit with no skipped output or
request to either service. This drill prepared the signed graph; the resulting
onchain sweep was not broadcast.

The local candidate passed 941 wallet tests, TypeScript, lint, formatting,
the mainnet production build, the full runtime build/vet/test gate, targeted
backup authentication and migration tests, and 13 recovery-companion tests.
The schema-2 migration preserved the authenticated identity and renewal rows
and the independent policy-sequence file. A lost cloud write acknowledgment
retries the exact saved ciphertext before uploading later payment paths.

The September 6 drill used an isolated backup-only schema-3 database. Combined
release integration preserves connector schema 3 and adds backup schema 4
through an explicitly validated migration chain. That test database is a
separate development lineage.

Deploy the combined runtime and backup routes before the wallet frontend. The
independent recovery bundles also need publication from the same reviewed
source. Combined candidate commits remain local; production still uses the
existing release.
