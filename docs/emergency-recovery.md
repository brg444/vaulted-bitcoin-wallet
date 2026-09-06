# Recovery with your saved files

Keep an encrypted recovery archive alongside your Recovery Kit and access to
its signing keys. The archive contains saved transaction paths and the
passkey-protected device key. A public Recovery Kit records addresses and
rules; it cannot replace missing transaction history or key-unlock data.

## Save the information you may need

Open **Security → Recovery Kit** to download the public kit. On the recovery
screen, **Enable encrypted automatic backup** starts cloud updates for the
unlocked session, and **Download encrypted recovery archive** saves a local
copy. Local capture updates while the wallet is running. Cloud updates need
an active backup session and a working connection; check the last successful
backup time before relying on a copy.

| Item | What to keep |
| --- | --- |
| Encrypted recovery archive | Save a copy outside this device. It contains the saved Spending paths, Bitcoin parents, payment journals and protected device-key data. |
| Recovery Kit | Keep the public scripts and rules with the archive. Addresses reveal financial information, so keep the file private. |
| Your passkey | Preserve access to the passkey for the website where you enrolled, including access through its provider. |
| Your hardware key | Keep access to the hardware wallet and its own backup. It supplies a second Savings approval. |
| Your recovery key | Keep this separately if you chose Advanced. Its authority depends on the saved account and recovery path. |
| Your enrollment website | Keep its exact address with these files; the original passkey depends on it. |

A backup covers its capture time. Receipts, payments and completed renewals
require later capture. An interrupted update retains the previous complete
archive and reports the failure. A suspended browser cannot continuously
update a cloud backup.

## Restore access or use the companion

The welcome and unlock screens offer **Restore encrypted cloud backup** and
**Restore encrypted backup from a file**. Both require the original passkey.
Restoring archived data preserves pending operations and then reconciles with
the current wallet state; importing a file does not cancel a payment.

If the wallet or its services are unavailable, use the saved
[recovery companion](https://github.com/brg444/vaulted-emergency-recovery).
Open the recovery file, select a supported path and check its destination,
amount and fees. The companion validates the saved scripts and transaction
parents before preparing an action. Preparation does not broadcast.

Save the prepared recovery before starting. After a lost response, reopen that
same file to check Bitcoin status and resume the exact transaction. Partial
signatures can also be saved and resumed. Hardware signing uses an exact PSBT
handoff; confirm compatibility with your signing device and software.

Older public kits remain supported. A kit with saved phone-unlock data can
use its original passkey; one without that data cannot. Saved boarding pins
can support boarding recovery, but a public Savings map alone cannot supply
a missing Spending transaction graph.

## Keys, delays and service availability

| Account or saved state | Independent recovery path |
| --- | --- |
| Legacy normal Savings | Phone and hardware keys, with no recovery waiting period |
| Standard Spending | Phone and hardware keys after the committed Spending delay |
| Advanced Spending | Hardware and separate recovery keys after the committed Spending delay |
| Boarding deposit | Phone key after the boarding delay |
| Pending recovery | Its designated claimant after the committed block delay |
| Pending cancellation or Quarantine | The remaining keys required by that exact saved script |
| Outbound Lightning lockup | Phone sender refund through the saved contract and its refund delay |

Connector Savings requires its existing service approvals and hardware
signature. A saved connector payment can finish when the archive contains
those service approvals; an unrelated new payment cannot reuse them.

Starting a new one-key delayed Savings recovery requires both recovery
services. Its hardware, phone and separate recovery paths wait 6, 144 and
288 Bitcoin blocks respectively after the initiating transaction confirms.
Those block delays are distinct from Spending and boarding delays expressed
in seconds. Waiting does not add a signing path to a normal Savings output.

Spending and Lightning recovery may require separate Bitcoin fee funding.
The companion shows the funding address for the selected signing key. The
current SDK waits for a parent already in the mempool and does not
automatically raise that parent's fee. Keep the prepared file while waiting
for confirmations or timelocks.

## Original passkey and suspected recovery

A passkey works at its original website origin, including the port. During a
website outage, the companion can run locally under that hostname with a
trusted local certificate. Follow its setup instructions; opening an unrelated
localhost address cannot unlock the original passkey. A saved archive cannot
replace a deleted passkey or a lost signing key.

If you see a recovery you did not start, check the initiating key and the
remaining keys that can cancel it. Once the claimant can spend, cancellation
competes with the claim. The wallet checks while running and when it regains
focus; this release does not provide continuous monitoring or guaranteed
notifications. Confirm that a cancellation was signed, submitted and
confirmed before relying on its outcome.
