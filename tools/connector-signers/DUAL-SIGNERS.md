# Two-reserve signer qualification

The `phone-connector-recovery-savings-v2` transaction requires two ordinary
reserve-input signatures using `SIGHASH_SINGLE` without `ANYONECANPAY`. Savings
remains unsigned until these approvals verify. The current v0.0.7 Emulator
independently verifies the approvals and its fee, change and layout rules.

## Software signing

`dual-software.qualification.mjs` exercises the wallet's actual PSBT builder,
external signer, returned-signature verification, phone signing, fixture
Guardian signing and upstream Emulator HTTP signing. Each signer runs eight
cases: native SegWit and Taproot, Standard and Advanced, partial and full
withdrawals. All eight cases passed for each signer. A one-satoshi recipient
alteration with the original signatures is rejected in every case.

The tests use public fixture keys and synthetic parents. Funded production
relay acceptance, Guardian's production API, manual desktop approval and
physical-device operation remain separate qualifications.

### Sparrow 2.5.4

Source pins match [the one-reserve qualification](SPARROW.md): Sparrow
`8871f4f1af528a4673fee6129373c884e3267860` and Drongo
`080cf3f7cf74133ba68b369065d0f2e7ea4337da`.

The Java adapter runs the same software wallet signing operations used by
Sparrow. Its public BIP39 fixture recognizes exactly the two reserve inputs,
preserves the transaction, signs both and leaves Savings unsigned. The test
models choosing **Yes** at Sparrow's **Non-Default Sighash** dialog after
asserting the expected SINGLE warning. It does not remove that warning from
Sparrow or test the interactive dialog itself.

Build the classpath as described in [SPARROW.md](SPARROW.md), then run:

```sh
CONNECTOR_SOFTWARE_SIGNER=sparrow \
CONNECTOR_EMULATOR_ORIGIN=http://127.0.0.1:PORT \
CONNECTOR_SPARROW_SOURCE=/path/to/sparrow \
CONNECTOR_SPARROW_JAVA=/path/to/jdk-25/bin/java \
CONNECTOR_SPARROW_CLASSPATH_FILE=/path/to/classpath-file \
node --test tools/connector-signers/dual-software.qualification.mjs
```

The harness requires the isolated [Emulator fixture](EMULATOR.md) with its
public fixture key. It refuses a non-loopback Emulator origin.

### Bitcoin Core 31.0

The RPC qualification uses `btcpayserver/bitcoin:31.0`, reporting
`/Satoshi:31.0.0/`, in a disposable regtest container with Docker networking
completely disabled. This qualifies that container's Core binary; it does not
attest the separately distributed desktop application.

```sh
docker run --detach --rm --name vaulted-connector-core-qualification \
  --network none --entrypoint bitcoind btcpayserver/bitcoin:31.0 \
  -regtest -server -networkactive=0 -listen=0 -dnsseed=0 -discover=0 \
  -listenonion=0 -rpcuser=connector-fixture \
  -rpcpassword=disposable-local-test -fallbackfee=0.00002

CONNECTOR_SOFTWARE_SIGNER=core \
CONNECTOR_EMULATOR_ORIGIN=http://127.0.0.1:PORT \
node --test tools/connector-signers/dual-software.qualification.mjs

docker stop vaulted-connector-core-qualification
```

The harness checks that networking is disabled, creates fresh fixture wallets,
imports disposable descriptors and calls `walletprocesspsbt` with SINGLE and
input finalization enabled. The returned PSBT contains two valid finalized
reserve witnesses. `complete=false` is expected.

Core also writes `sighashType=3` on the foreign, unsigned Savings input.
Vaulted accepts that unused hint only during v2 hardware approval and only
when that input contains no signatures or witness. It copies neither the hint
nor the returned Savings map into the retained candidate. Savings subsequently
requires its original DEFAULT signatures committing the complete transaction.
The final response path still rejects the altered hint. Regression cases
check hint rejection for other modes and signed Savings inputs, unchanged
retained Savings mode, and final-stage rejection.

## Jade

At source `9c097297f58339c15fb9b8df4c7fe105efefb902`,
[`sighash_is_supported`](https://github.com/Blockstream/Jade/blob/9c097297f58339c15fb9b8df4c7fe105efefb902/main/process/sign_utils.c#L652)
accepts only ALL for Bitcoin native SegWit, and ALL or DEFAULT for Taproot.
Both `sign_psbt` and `sign_tx` call this policy before signing. The SINGLE plus
ANYONECANPAY exception applies to partial Liquid swaps, not Bitcoin.

A host-compiled extraction of this exact function passed 16 assertions:
Bitcoin SINGLE is rejected and ALL is accepted across both signature types,
both transaction-type branches and both partial flags. This is an executable
policy check, not a QEMU or physical Jade test. The current firmware cannot
approve Vaulted's two-reserve transaction, so a full device qualification is
blocked at its signature policy.
