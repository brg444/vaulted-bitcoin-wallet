# Software signers for Savings

This guide applies to the Savings connector candidate. Existing vaults retain
the contract chosen at enrollment; updating the app does not convert their
funds. See the [deployment status](../tools/connector-signers/DEPLOYMENT.md)
before using this flow on RC.

## Sparrow

Use a single-signature native SegWit wallet (BIP84) or Taproot wallet (BIP86)
that can sign transactions. A watch-only wallet requires its separate signer;
software testing does not establish compatibility with a hardware device.

1. In Sparrow, open the wallet's **Settings** tab and copy its public
   **Descriptor** under **Script Policy**. Alternatively, choose **Export… →
   Output Descriptor** and copy the receive descriptor from the exported text
   file. Copy one `wpkh(...)` or `tr(...)` line, including its key origin and
   checksum; leave the file's headings and other descriptors out of the paste.
2. Paste that descriptor into Vaulted's signer setup. Check the derived reserve
   address against the corresponding receiving address in Sparrow. A descriptor
   ending in `/<0;1>/*` selects the first receive address.
3. Send exactly **1,000 sats** to the reserve address and wait for confirmation.
   Deposit Savings separately, using the Savings address shown by Vaulted after
   enrollment. The reserve address and Savings address serve different purposes.

For a withdrawal, review the recipient and amount in Vaulted and approve with
your passkey. Import the exported PSBT into Sparrow, check the full recipient
address against the address you intended to pay, and sign. Return the signed
PSBT or completed transaction to Vaulted for verification and submission.

The transaction returns the full 1,000-sat reserve to the same signer script.
Savings pays the recipient, network fee, and a 240-sat fee-bumping anchor. Any
remaining Savings returns to the enrolled Savings address. Wait for confirmation
before using the reserve's successor for another withdrawal.

## Electrum

Electrum 4.8.1 is qualified for native SegWit connector signing with BIP84 or
native Electrum origins. The qualification does not cover Taproot signing.
Its **Wallet → Information** dialog displays the master public key, derivation
path, and BIP32 root fingerprint, but does not provide Sparrow's descriptor
export action.

For a single-signature native SegWit wallet, assemble the public descriptor from
those three fields:

```text
wpkh([FINGERPRINT/ORIGIN_PATH]MASTER_PUBLIC_KEY/0/*)
```

For example, a displayed origin of `m/0'` becomes
`wpkh([FINGERPRINT/0']MASTER_PUBLIC_KEY/0/*)`. Replace the placeholders with the
public values from your wallet, keeping your seed phrase and private extended
key in the signing wallet. Vaulted derives the first receiving address, which
you can compare with Electrum before funding the reserve.

To sign, choose **Tools → Load transaction → From file**, open the exported
Savings PSBT, and review the Outputs list. Copy the recipient address to check
its full value, then sign and return the completed transaction or PSBT to
Vaulted. Keep any pending withdrawal available until its outcome is resolved;
a closed window or failed network request does not cancel an issued signature.

## Qualification scope

[Sparrow](../tools/connector-signers/SPARROW.md) and
[Electrum](../tools/connector-signers/README.md) tests exercise conventional-input
signing with the Savings input already finalized. They verify that the returned
signature commits every output and that the completed transaction matches the
retained candidate. Vaulted's custom recovery scripts retain the existing
recovery model and its separate signer requirements; the conventional-input
tests qualify normal connector withdrawals.
