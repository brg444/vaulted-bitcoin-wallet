# Emulator HTTP qualification

The qualification exercises Emulator v0.0.7's generated HTTP gateway, gRPC
handler, onchain validation, default compute limits and signing code. Twelve
existing v1 cases and 40 connector v2 cases pass. The v2 matrix covers Standard
and Advanced, Taproot and native SegWit connectors, partial and full withdrawals,
and P2PKH, P2SH, P2WPKH, P2WSH and Taproot recipients. Another 72 v2 requests
must fail after deliberate policy, packet or signature-commitment changes.
Vaulted independently verifies every returned Emulator signature.

The [Ledger approval contract](LEDGER.md) describes the hardware-first flow and
independent Bitcoin sighash verification in connector v2.

The exported PSBT retains both proprietary parent-transaction fields through
`updateInput`. Tests verify their exact bytes before and after hardware handoff.

## Source and test boundary

The test uses these exact source revisions:

- [Emulator v0.0.7](https://github.com/arkade-os/emulator/tree/b86ad87169628081d91cbee860cc5f3abe3dab68):
  `b86ad87169628081d91cbee860cc5f3abe3dab68`.
- [Go SDK f29d9e7](https://github.com/arkade-os/go-sdk/tree/f29d9e77d5c70cc898136b8536b95c5006104062):
  the exact revision referenced by the emulator's module replacement.

The reproduction command uses a temporary modfile pointing to the exact local
SDK source, leaving tracked dependency files unchanged.
The fixture adapter changes service construction only: it supplies public test
key 15 and a distinct Operator fixture key, without starting an Operator client
or opening a real wallet. The gateway, handler, interpreter, and signer remain
upstream code. Transport stays on loopback, and the test refuses other hosts.

This verifies the local versioned protocol implementation. It does not establish
the deployed service's source identity, TLS configuration, availability, or
mainnet broadcast acceptance.

## Reproduction

Use disposable source checkouts at the revisions above, Go 1.26.6, and Node
24.15 or newer. From the Vaulted wallet repository, set
`CONNECTOR_EMULATOR_SOURCE` and `CONNECTOR_GOSDK_SOURCE` to those checkouts, then:

```sh
cp tools/connector-signers/emulator-harness/service.go \
  "$CONNECTOR_EMULATOR_SOURCE/internal/application/connector_qualification.go"
mkdir -p "$CONNECTOR_EMULATOR_SOURCE/cmd/connector-qualification"
cp tools/connector-signers/emulator-harness/main.go \
  "$CONNECTOR_EMULATOR_SOURCE/cmd/connector-qualification/main.go"
cd "$CONNECTOR_EMULATOR_SOURCE"
cp go.mod connector-qualification.mod
cp go.sum connector-qualification.sum
go mod edit -modfile=connector-qualification.mod \
  -replace="github.com/arkade-os/go-sdk=$CONNECTOR_GOSDK_SOURCE"
go run -modfile=connector-qualification.mod -tags connectorqualification \
  ./cmd/connector-qualification
```

In another terminal, from the wallet repository, use the loopback origin printed
by the harness:

```sh
CONNECTOR_EMULATOR_ORIGIN=http://127.0.0.1:PORT \
  node --test tools/connector-signers/emulator.qualification.mjs
```

Stop the harness with Ctrl-C after qualification. The fixtures contain no funds
or private user data, and the test never broadcasts a transaction.
