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
and [Ledger qualification](../tools/connector-signers/LEDGER.md).

## Create a key with Sparrow

1. Create a new wallet and select **Single Signature**, then **Native SegWit**.
2. For hardware protection, generate the seed on the device and add it through
   **Connected Hardware Wallet**. Keep the seed backup offline. For software
   testing, choose **New or Imported Software Wallet** and create a BIP39 seed
   or import a dedicated test seed into a new wallet.
3. Apply the settings. Show the public **Descriptor** QR in **Settings**, or
   export an **Output Descriptor** file. In Vaulted, choose **Scan QR**,
   **Upload** or **Paste**. Supply one receiving `wpkh(...)` descriptor with its
   fingerprint and derivation path; a Taproot wallet uses `tr(...)`.
4. Compare Vaulted's reserve address with the first receiving address in the
   signing wallet. A ranged descriptor selects index zero; a multipath
   descriptor selects its receive branch.

Never enter seed words or private keys into Vaulted. A software wallet created
for testing does not provide hardware protection. For hardware use, choose a
qualified device and signing workflow before depositing.

## Deposit and approve

Use Vaulted's prepared first Savings deposit. It funds Savings and creates two
500-sat reserves for the signer together. A new two-reserve wallet needs both
outputs created by that prepared deposit.

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
