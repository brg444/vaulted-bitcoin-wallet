# Sparrow connector qualification

This branch qualifies the L1 connector experiment. The native Savings contingency
uses it as reference evidence; see [reconciliation and deployment status](DEPLOYMENT.md).

Sparrow 2.5.4's software wallet signs the connector Savings PSBT using native
SegWit (BIP84) or Taproot (BIP86) keys. Eight cases cover both key types,
Standard and Advanced vaults, and partial and full withdrawals. Eight further
cases render the actual Sparrow recipient output widget before signing.

The wallet recognizes only its connector input, preserves the finalized
Savings witness, signs and finalizes the transaction, and returns a PSBT and
transaction hex that Vaulted independently verifies. A substituted recipient
is rejected on return. The tests use a public BIP39 fixture from Sparrow's
own tests, with no existing wallet, real funds, or network connection.

The rendered output shows the recipient amount and full address at the tested
window size. Its **Copy Address** action returns the exact destination encoded
in the transaction. The tests load the actual `OutputForm` FXML and
`OutputController`; software signing uses the same Drongo wallet operations
called by `HeadersController`. The entire application, Sign button dispatch,
password prompts, native file pickers, and hardware devices are outside this
qualification. A human desktop trial remains a release gate.

## Source pins and reproduction

The source checkout and submodules are unchanged:

- [Sparrow 2.5.4](https://github.com/sparrowwallet/sparrow/tree/8871f4f1af528a4673fee6129373c884e3267860):
  `8871f4f1af528a4673fee6129373c884e3267860`.
- Drongo: `080cf3f7cf74133ba68b369065d0f2e7ea4337da`.
- Lark: `13001e8acf7048a15c81cc050c65e6e164c3aa33`.

Use JDK 25 with Sparrow's Gradle wrapper and Node 24.15 or newer. From this
wallet repository, after cloning Sparrow recursively at the pin:

```sh
export CONNECTOR_SPARROW_SOURCE=/absolute/path/to/sparrow
export CONNECTOR_SPARROW_JAVA=/absolute/path/to/jdk-25/bin/java
export CONNECTOR_SPARROW_CLASSPATH_FILE=/tmp/sparrow-connector-classpath

JAVA_HOME=/absolute/path/to/jdk-25 \
  "$CONNECTOR_SPARROW_SOURCE/gradlew" -p "$CONNECTOR_SPARROW_SOURCE" \
  -I "$PWD/tools/connector-signers/sparrow-classpath.gradle" \
  :drongo:connectorClasspath --no-daemon

node --test tools/connector-signers/sparrow.qualification.mjs
```

For the output review cases, build Sparrow's full classpath instead:

```sh
export CONNECTOR_SPARROW_UI=1
JAVA_HOME=/absolute/path/to/jdk-25 \
  "$CONNECTOR_SPARROW_SOURCE/gradlew" -p "$CONNECTOR_SPARROW_SOURCE" \
  -I "$PWD/tools/connector-signers/sparrow-classpath.gradle" \
  connectorClasspath --no-daemon

node --test tools/connector-signers/sparrow.qualification.mjs
```

The UI tests use JavaFX's headless platform and a temporary Sparrow home.
Set `CONNECTOR_SPARROW_ARTIFACTS` to a directory to retain rendered output
screens. A classpath-mode JavaFX warning is expected in this test adapter.

## Review and return

Once connector enrollment is available, open the prepared Savings PSBT in
Sparrow with the wallet that owns the funded connector input. Review the
recipient output's address and amount; use **Copy Address** if the window
clips the full destination. Compare against an independently verified address,
then sign using the supplied signature settings. Export through **Save PSBT**
or **Save Final Transaction** and return the signed result to Vaulted.

This qualifies software signing for the new connector contract. Existing RC
Savings outputs use the previous contract, and this work does not enable
connector enrollment or deploy the unfinished flow.
