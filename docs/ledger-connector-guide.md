# Existing connector wallets: Using Ledger with Vaulted Savings

Your Ledger holds the separate key used to approve Savings transfers. Vaulted
prepares the transfer, a desktop wallet passes the approval request to Ledger,
and you review the destination and amounts on the device. The signed approval
returns to Vaulted for the remaining approvals and submission.

This guide applies to the two-reserve connector. Existing one-reserve wallets
retain their original contract and signing flow.

## Compatibility today

Ledger Bitcoin app 2.4.2 source, compiled for Nano S Plus, passed simulator
tests for Taproot and native SegWit, with both full and partial withdrawals.
The completed Bitcoin signatures and current Emulator checks passed.

Physical Ledger approval, the exact application binary distributed through
Ledger's software, a complete Ledger-plus-desktop-wallet workflow and funded
production submission remain unqualified. Sparrow's software-signing tests
cover its own keys, separately from its Ledger connection. Treat the device
steps below as the workflow to qualify before relying on this setup for Savings.

The recorded screens came from the Bitcoin Testnet application in the simulator.
Labels, pagination and confirmation gestures can differ across devices and
application versions. See the [technical qualification](../tools/connector-signers/LEDGER.md)
for exact source and simulator versions.

## Set up the key

1. Generate and back up the seed on your Ledger, or use an existing backed-up
   Ledger account. Enter the PIN on the device and open its Bitcoin application
   for the network you are using.
2. In Sparrow, create a wallet with **Single Signature → Taproot (BIP86)**,
   then choose **Connected Hardware Wallet** and import the Ledger account.
   Native SegWit (BIP84) is an alternative when it is the account you intend to
   use. Sparrow's [USB setup guide](https://sparrowwallet.com/docs/connected-wallet.html)
   explains the connection process.
3. Apply the settings and show the public **Descriptor** QR, or export an
   **Output Descriptor** file. Scan, upload or paste it into Vaulted. A Taproot
   descriptor starts with `tr(`; native SegWit starts with `wpkh(`.
4. Compare the first receiving address selected by Vaulted with that account's
   address, including verification on the Ledger screen. An account number or
   passphrase change selects a different key.

Keep your seed words on their offline backup. Sparrow should connect to the
hardware key; importing seed words into a software wallet creates a different
security setup. Computer-generated test seeds belong in a separate test wallet.

The exported descriptor is public signing information. It can reveal addresses
and transaction activity, so share it only where needed. A matching descriptor
establishes which key is selected; signing compatibility requires its own test.

## Fund Savings through Vaulted

Receive Bitcoin using **Savings → Deposit**. The receiving address and QR code
accept ordinary Bitcoin payments without a PSBT.

Before transferring Savings, open **Security → Savings signer setup**. Send two
separate payments of exactly 500 sats to the displayed signer address, with
network fees paid in addition. Compare it with the Ledger receiving address
selected during enrollment. Wait for both outputs to confirm. The reserves total
1,000 sats and return to the enrolled signer address after a Savings transfer.

A single payment of 1,000 sats creates the wrong output arrangement. If your
wallet exports unsigned PSBTs, **Advanced: fund with a Savings deposit** can
create both 500-sat outputs with a Savings deposit in one transaction. Existing
prepared deposits remain resumable.

You can also choose **Fund from Spending** in signer setup. Review the signer
address, reserve amount and quoted Operator fee, then confirm. This requires
one settled Spending output covering the reserves, fee and protected change;
setup completes after Bitcoin confirmation and local recovery-data sync.
Pending funding remains visible on the wallet home screen.

A desktop wallet watching the Ledger descriptor may show the two reserves
without showing the Savings balance. Savings belongs to its separate enrolled
contract, with additional signers and recovery rules. Manage Savings through
Vaulted and leave the reserves unspent by ordinary desktop-wallet payments or
coin consolidation. Spending a reserve interrupts the normal approval flow.

## Review a transfer

1. Enter the recipient and amount in Vaulted, then export the hardware approval
   PSBT. Open it in the desktop wallet connected to the enrolled Ledger account.
2. Check the transaction details and request signing with the Ledger. The
   device signs two reserve inputs, while the Savings input remains unsigned.
3. Review the full recipient address against an independently obtained address,
   and check its amount. For a partial withdrawal, also check that the remaining
   Savings returns to the enrolled Savings address.
4. Check both reserve returns, the anchor and the fee before confirming on the
   Ledger. Return the partially signed PSBT to Vaulted without trying to
   broadcast it from the desktop wallet.
5. Complete Vaulted's remaining approval prompts and follow the pending
   transfer there. Ledger confirmation alone does not submit the transaction.

The simulator displayed generic numbered outputs. Identify Savings and the
reserves by their full addresses and amounts when reviewing them.
A partial transfer displayed five monetary outputs; a full withdrawal displayed
four, because there was no Savings change output.

## Understand the warnings

| Observed warning | Meaning in this transaction | What to check |
| --- | --- | --- |
| There are external inputs | Ledger owns the two reserve inputs; Savings is controlled by its separate contract. | The request came from your intended Vaulted transfer and uses the enrolled reserve key. |
| Non-default sighash | Each reserve signature approves the output at its matching position. | The recipient and amount, protected Savings change when present, and the complete visible output list. |

Sparrow may also show a **Non-Default Sighash** warning before opening the PSBT.
These warnings are expected in the tested flow, but their presence does not
establish that a request is safe. Cancel a request with an unexpected address,
amount, output, signing mode or additional warning, and resolve the discrepancy
before signing. An unexpected failure is not a reason to disable device checks.

The required mode is `SIGHASH_SINGLE` without `ANYONECANPAY`. The first signature
commits to the recipient output. The second commits to Savings change for a
partial withdrawal, or the first returned reserve for a full withdrawal.

The device displays every monetary output; each reserve signature commits to
its corresponding output only. The Emulator independently verifies the two
signature commitments, fee limits, protected change, reserve returns and layout.
The subsequent Savings signatures commit to the complete transaction. This
separation defines which checks each participant performs.

Ledger's approval PSBT omits a final zero-value program-data output. Vaulted
adds that output before the Savings approvals; none of the monetary outputs
shown for approval changes. The data carries the proof used by the Emulator.
Bitcoin validates the ordinary input signatures, while Arkade Script checks
depend on an honest Emulator. You still need to verify the intended recipient.

## Example amounts on the device

For a partial withdrawal from 100,000 sats of Savings, the tested example paid
8,000 sats with a 1,000-sat network fee:

| Device entry | Sats | BTC |
| --- | ---: | ---: |
| Output 1: recipient | 8,000 | 0.00008000 |
| Output 2: Savings change | 90,760 | 0.00090760 |
| Output 3: reserve A | 500 | 0.00000500 |
| Output 4: reserve B | 500 | 0.00000500 |
| Output 5: anchor | 240 | 0.00000240 |
| Network fee, displayed separately | 1,000 | 0.00001000 |

The inputs total 101,000 sats: Savings plus the two reserves. The 240-sat anchor
is a separate transaction output used for fee bumping, so it appears in
addition to the network fee. For a full withdrawal with the same fee, the
recipient receives 98,760 sats and the Savings change output disappears.

The fee above is an example, not a fixed quote. The approval proof adds roughly
2 KB to the final transaction; Vaulted includes that cost in fee estimation and
retains its configured fee ceilings.

## After approval, cancellation and recovery

A partially signed PSBT is the expected return file because Ledger cannot
supply the remaining Savings approvals. Vaulted verifies the reserve signatures
before requesting those approvals and submitting the completed transaction.

If you reject signing on the device, return to Vaulted to inspect the pending
request. Once signatures have been returned, closing a window or disconnecting
the Ledger does not revoke them. Resume the saved transfer and resolve its
status before creating a replacement.

A Ledger seed backup restores its key, but complete Savings recovery also
depends on the enrolled protection tier, other required keys and retained
recovery data. Keep Vaulted's recovery material current and stored separately.
Advanced's independent recovery key is distinct from the Ledger seed backup;
adding the connector leaves existing recovery delays and signer requirements
in place.
