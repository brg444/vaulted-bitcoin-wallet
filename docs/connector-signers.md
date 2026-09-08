# Signing Savings transfers

Savings needs a separate signer that can approve its transactions. A public
descriptor identifies the key and receiving address; accepting that descriptor
does not establish signing compatibility or prove that the key is in hardware.

## Compatibility

For the two-reserve connector (`phone-connector-recovery-savings-v2`):

| Signing option | Qualification |
| --- | --- |
| Sparrow 2.5.4 software wallet | Native SegWit and Taproot signing passed automated tests with the current Emulator. Manual desktop approval remains untested. |
| Bitcoin Core 31.0 RPC | Native SegWit and Taproot signing passed automated tests with the current Emulator, using the Core response compatibility adjustment. GUI signing is not covered. |
| Ledger Bitcoin app 2.4.2 | Native SegWit and Taproot passed simulator tests. Physical approval, the distributed application binary and funded production qualification remain incomplete. |
| Jade | Current Bitcoin signing policy rejects the required signature mode. |
| Electrum and other hardware devices | Not qualified for this two-reserve flow. |

Hardware compatibility requires testing the complete device, firmware and
connecting application together. See [reproducible qualification](../tools/connector-signers/DUAL-SIGNERS.md)
and the [Ledger user guide](ledger-guide.md).

## Create a key with Sparrow

1. Create a new wallet and select **Single Signature**, then **Taproot (BIP86)**.
2. For hardware protection, generate the seed on the device and add it through
   **Connected Hardware Wallet**. Keep the seed backup offline. For software
   testing, choose **New or Imported Software Wallet** and create a BIP39 seed
   or import a dedicated test seed into a new wallet.
3. Apply the settings. Show the public **Descriptor** QR in **Settings**, or
   export an **Output Descriptor** file. In Vaulted, choose **Scan QR**,
   **Upload** or **Paste**. Supply one receiving `tr(...)` descriptor with its
   fingerprint and derivation path.
4. Compare Vaulted's reserve address with the first receiving address in the
   signing wallet. A ranged descriptor selects index zero; a multipath
   descriptor selects its receive branch.

Native SegWit (BIP84) remains supported as an alternative, using a `wpkh(...)`
descriptor. Keep the selected wallet type, account and descriptor matched.

Never enter seed words or private keys into Vaulted. A software wallet created
for testing does not provide hardware protection. For hardware use, choose a
qualified device and signing workflow before depositing.

## Deposit and approve

Receive ordinary Bitcoin payments using the address or QR code under
**Savings → Deposit**.

Before the first transfer, open **Security → Savings signer setup** and choose
**Fund from Spending**. Review the enrolled signer address, approval-output
amount and Operator fee, then confirm. Vaulted creates the missing approval
outputs in a Bitcoin batch and returns change to the enrolled Spending script.
The setup stays pending until Bitcoin confirmation and the updated Spending
recovery data has been saved on this device.

This path requires one settled Spending output large enough to cover setup,
its quoted fee and at least 330 sats of protected change. It does not combine
several smaller Spending outputs. Setup and its fee count against your Spending
limits. A failed or interrupted attempt remains available through **Check
signer setup** on the wallet home screen.

Alternatively, expand **Use an external Bitcoin wallet**. Send two separate
payments of exactly 500 sats to the displayed signer address, with network fees
in addition, and wait for both to confirm. Compare the address with the
receiving address selected during enrollment. The signer needs two distinct
outputs; one 1,000-sat payment cannot replace them.

Under **Advanced: fund with a Savings deposit**, wallets that export unsigned
PSBTs can create both reserves with a Savings deposit in one transaction.
Previously prepared deposits remain available there through **Continue prepared
deposit**. A pending deposit or transfer must be resolved before funding the
signer again.

For a transfer, export the hardware approval PSBT from Vaulted and open it in
Sparrow. Sparrow shows a **Non-Default Sighash** warning; review the transaction
before agreeing to open it. Check the recipient address and amount, and the
protected Savings change for a partial withdrawal. Sign and return the partially
signed PSBT to Vaulted. The Savings input is deliberately unsigned at this
stage, so the transaction is not ready to broadcast from Sparrow.

Vaulted verifies both reserve signatures, then obtains the remaining Savings
approvals. The reserves return to the same enrolled address. Savings pays the
recipient, network fee and 240-sat anchor; remaining Savings returns to its
enrolled address. Preserve a pending transfer until its outcome is resolved.

For Bitcoin Core RPC signing, unlock the correct signing wallet locally and
use its `walletprocesspsbt` RPC with `sign=true`, `sighashtype="SINGLE"`,
`bip32derivs=true`, and `finalize=true`. Return the `psbt` result to Vaulted.
`complete=false` is expected because Core cannot sign the Savings input. This
flow requires the Core response compatibility adjustment described in the
qualification notes; descriptor import alone does not establish its availability.

## Existing one-reserve wallets

Previously enrolled `phone-connector-recovery-savings-v1` wallets retain their
single 1,000-sat reserve and original approval order. Savings approvals come
first, followed by the conventional input signature committing every output.
An app update does not change the enrolled contract or move funds.

The earlier [Sparrow](../tools/connector-signers/SPARROW.md) and
[Electrum](../tools/connector-signers/README.md) qualifications apply to that
one-reserve transaction; v2 requires its own qualification. Both connector
versions retain their enrolled recovery paths and signer requirements.
