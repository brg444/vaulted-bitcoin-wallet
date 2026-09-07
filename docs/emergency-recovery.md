# Recovery with your saved files

Save a recovery package and a copy of the
[recovery application](https://github.com/brg444/vaulted-emergency-recovery)
outside your phone. The package records the transaction paths available when
it was saved. Bitcoin access, the required signing keys, fees and the committed
waiting periods still apply.

## Save the information you may need

Open **Security → Backups → Save recovery package**. The package contains
readable Spending paths and Bitcoin parents, plus an encrypted backup of the
protected wallet key and payment journals. Advanced Spending recovery can read
these paths with the phone absent and use the hardware and recovery keys to
sign. An older encrypted-only archive requires the original passkey even to
read its paths.

Keep the package private: its readable data reveals addresses and financial
activity. Private keys and operational journals remain encrypted. Save the
recovery application separately; the JSON package contains data, not a runtime.

| Item | What to keep |
| --- | --- |
| Recovery package | An updated copy outside this device, containing transaction paths and the protected backup. |
| Recovery application | The matching independent companion, with its release verification information. |
| Your passkey | Access through its provider and the exact enrollment website needed to use it. |
| Your hardware key | The signing device or compatible software and its own backup. |
| Your recovery key | A separate key if you chose Advanced; it is required for Advanced Spending exit when the phone is lost. |

**Check a recovery package** opens a file without signing or broadcasting.
It reports the Spending paths and amount found in that file. It cannot prove
coverage of later activity, access to signing keys or current Bitcoin eligibility.
The separate public Recovery Kit records Savings scripts and rules; it cannot
replace a missing Spending transaction graph.

Automatic capture runs while the wallet is available. Encrypted cloud updates
require an active backup session and a working connection. Local storage and
cloud backup are separate from a downloaded copy, which does not update itself.
Receipts, payments and renewals require updated transaction data. A suspended
browser cannot keep a file current or acknowledge a replacement path.

The current and previous complete local snapshots commit together. An older
import is retained separately, and a failed replacement preserves the prior
complete copies. Remotely committed transitions can still precede browser
capture; an incomplete update must be resolved before relying on the newer
funds' recovery data.

## Restore access or use the companion

Help on the welcome and unlock screens provides **Restore encrypted cloud backup**
and **Restore encrypted backup from a file**. File restore accepts the new package
and older encrypted archives. Both routes require the original passkey and
authenticate the encrypted backup before using its contents.
Restoring archived data preserves pending operations and then reconciles with
the current wallet state; importing a file does not cancel a payment.

If the wallet or its services are unavailable, use the saved
[recovery companion](https://github.com/brg444/vaulted-emergency-recovery).
Open **Recover to Bitcoin**, choose the file and review the funds found in
that backup. Select a supported path and check its destination, amount and fees. The companion validates the saved scripts and transaction
parents before preparing an action. Preparation does not broadcast.

Save the prepared recovery before starting. After a lost response, reopen that
same file to check Bitcoin status and resume the exact transaction. Partial
signatures can also be saved and resumed. Download the PSBT, review it in compatible signing software, then import the
signed PSBT file. The companion validates the imported signatures against the
exact requested transaction. Confirm compatibility with the specific signing
path and device before funding.

Older public kits remain supported. A kit with saved phone-unlock data can
use its original passkey; one without that data cannot. Saved boarding pins
can support boarding recovery, but a public Savings map alone cannot supply
a missing Spending transaction graph.

## Keys, delays and service availability

| Account or saved state             | Independent recovery path                                              |
| ---------------------------------- | ---------------------------------------------------------------------- |
| Legacy normal Savings              | Phone and hardware keys, with no recovery waiting period               |
| Standard Spending                  | Phone and hardware keys after the committed Spending delay             |
| Advanced Spending                  | Hardware and separate recovery keys after the committed Spending delay |
| Boarding deposit                   | Phone key after the boarding delay                                     |
| Pending recovery                   | Its designated claimant after the committed block delay                |
| Pending cancellation or Quarantine | The remaining keys required by that exact saved script                 |
| Outbound Lightning lockup          | Phone sender refund through the saved contract and its refund delay    |

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
