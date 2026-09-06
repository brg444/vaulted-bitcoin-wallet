# Electrum connector qualification

This branch qualifies the L1 connector experiment. The native Savings contingency
uses it as reference evidence; see [reconciliation and deployment status](DEPLOYMENT.md).

Unmodified Electrum 4.8.1 signs the connector Savings PSBT with a native SegWit
software wallet. Eight tests cover native Electrum seed derivation and imported
BIP84 derivation, Standard and Advanced contracts, and partial and complete
withdrawals. The actual Electrum wallet recognizes its input, preserves the
finalized Savings witness, and signs without bypassing its warning checks.
Vaulted verifies the returned PSBT and completed transaction independently.

Electrum requires an explicit empty final scriptSig alongside the final witness
to recognize a foreign SegWit input as complete. The export preserves that
field even though the transaction library normally omits it. Enrollment also
accepts Electrum's native `m/0'/change/index` origin alongside BIP84 origins.
The public key, connector script, fingerprint, and complete path remain bound
by the enrollment commitment. Standard BIP84/BIP86 network checks still apply
when those derivation schemes are selected.

The test environment uses release commit
`1bfee7d1956ccb31778c76955683b789d1585d0c` from
[Electrum](https://github.com/spesmilo/electrum/tree/4.8.1). Install that source
with its dependencies, including a supported cryptography backend, in a
separate Python environment. After installing this repository's dependencies,
run with Node 24.15 or newer:

```sh
CONNECTOR_ELECTRUM_PYTHON=/absolute/path/to/environment/bin/python \
  node --test tools/connector-signers/electrum.qualification.mjs
```

The Python process uses temporary wallet state and public test keys. The native
seed fixture comes from Electrum's own `tests/test_wallet_vertical.py`.
No daemon, network service, existing wallet, or user secret is used.
[Sparrow qualification](SPARROW.md) covers native SegWit and Taproot software
keys. BlueWallet-specific changes are outside the current scope.

## Transaction screen qualification

With PyQt6 installed in the same Python environment, the following command
runs eight additional cases through Electrum's unmodified Qt transaction dialog:

```sh
CONNECTOR_ELECTRUM_PYTHON=/absolute/path/to/environment/bin/python \
  CONNECTOR_ELECTRUM_QT=1 \
  node --test tools/connector-signers/electrum.qualification.mjs
```

The test imports a binary PSBT through the actual file reader, checks hex and
base64 text import, renders the Outputs list, selects its Copy Address action,
clicks Sign, and exports through Share to both clipboard and a completed `.txn`
file. Vaulted accepts and independently verifies both the completed transaction
and the returned PSBT. Each case checks that signing preserves the finalized
Savings input and that the full copied recipient matches the intended address.

Qt runs offscreen with a temporary wallet. The file pickers and containing
window are test adapters; password and background-thread dispatch use a direct
call to the same wallet with warning checks enabled. The normal transaction
dialog, signing eligibility checks, output menu, and exporters are upstream
code. Native operating-system dialogs and a human's manual review remain
outside this automated test. Set `CONNECTOR_ELECTRUM_QT_ARTIFACTS` to an output
directory to retain rendered transaction-dialog images.

## Electrum review and return

Once connector enrollment is available, use the Electrum wallet that owns the
funded connector input:

1. Open **Tools → Load transaction → From file** and choose the Savings PSBT.
2. In **Outputs**, find the recipient and review its amount. Electrum's headline
   can show **Amount sent: 0** because its own reserve returns to the signer;
   the Savings payment amount is the recipient output's value.
3. Long addresses are abbreviated. Right-click the recipient output and choose
   **Copy Address**, then compare the complete address with the independently
   verified destination before signing. Matching only the visible prefix and
   suffix is insufficient.
4. Click **Sign**, then **Share → Copy to clipboard** or **Share → Save to file**.
   A completed export uses `.txn` and contains transaction hex. Return that
   signed transaction to Vaulted for verification and submission.

The current RC still uses the existing Savings contract; connector enrollment,
coordination, and migration remain integration work before users can follow
that flow with RC funds.
