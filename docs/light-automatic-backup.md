# Automatic encrypted backup

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

The runtime routes use a single-use WebAuthn challenge plus the enrolled
direct-key proof. Reads and writes require the resulting tenant-scoped session,
while authenticated backup rows and compare-and-swap revisions prevent a
conflicting writer from silently overwriting another device's backup. Backup writes preserve spending limits and leave the economic policy sequence unchanged.

## VTXO paths and synchronization

The reviewed wallet SDK is the vendored `f0fd58d5` lineage, with the existing
selective Lightning patches recorded in `vendor/arkade-os-sdk-ORIGIN.md`.
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
`arkade-os/arkade-unilateral-exit`. That executor supports
graph packages and can supply its own fee wallet without the Light owner key.
Its separate fee funding address must be followed when using that executor.

The automatic flow depends on access to the original passkey or its provider's
account recovery. It does not recover an owner key after every copy of that
passkey is permanently lost. Cloud storage alone cannot decrypt the wallet.
