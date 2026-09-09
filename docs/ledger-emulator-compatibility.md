# Ledger recovery: public Emulator compatibility gate

The complete Ledger Savings contract can register and produce valid Bitcoin
signatures. Deployment still requires a coordinated signing-service change:
the current public Emulator reader cannot recognize its recovery keys.

## Reproduction

In the runtime implementation branch:

```sh
go test ./internal/vault/savings -run TestLedgerRecoveryRequiresEmulatorDerivedKeySupport -v
```

The test rebuilds the complete family on both networks and tiers. It supplies an
exact cooperative recovery leaf and its canonical program to the pinned
`arkade.ReadArkadeScript` implementation. The reader returns
`ErrTweakedArkadePubKeyNotFound`. This is an expected incompatibility result and
keeps new enrollment disabled.

The runtime currently pins the script package through
`github.com/brg444/arkade-2fa-vault-poc/pkg/arkade` at
`1b511fd273c7`. Upstream `arkade-os/emulator` master at
`4feb9eaa81b49f8d321407e92dba107ec9ba5158` also uses the direct program-key
lookup in `pkg/arkade/script.go`. Existing public Emulator signing identifies the program-specific
public key directly in the Bitcoin leaf. The Ledger contract uses a BIP32 child
of that program-specific point, with a context-bound chain code. Matching the
original point therefore fails before program execution.

## Required service behavior

The Guardian and Emulator integration must agree on the following sequence:

1. Reconstruct the enrolled contract, named recovery action and exact program.
2. Resolve the permitted receive/change or recovery coordinate from that action.
3. Verify the actual parent output, selected leaf and control block against the
   reconstructed tree. Check the user signature and required authentication.
4. Evaluate the program against the original transaction, original Bitcoin
   tapleaf and verified prevouts, including the packet and phone binding.
5. Derive the matching child inside the signing boundary and return its DEFAULT
   signature only after evaluation succeeds.

A raw digest signer, altered evaluation copy, or unchecked caller-selected
chain code would violate the current runtime boundary. The implementation must
preserve the distinction between a public key constructor and an authorized
signing capability. Ordinary Savings payments remain phone-plus-Ledger and need
neither service.

## Acceptance evidence

An upgraded service needs successful tests for initiation from both Savings
coordinates and cooperative cancellation by every permitted remaining authority.
Mutation tests must reject changed destinations, amounts, output counts,
prevouts, leaves, control blocks, claimant roles, derivation coordinates, program
bytes and phone authentication. The exact packet shape, fee limits and witness
weight must remain bound to the transaction being signed.

The release test must use the deployed service identity and version, then
complete funded recovery transactions with the Ledger signature and both service
signatures. Existing native and connector contracts retain their old key
interpretation and must pass their compatibility suites.

The service owner and upgrade path are still required. Wallet enrollment,
Recovery Kit activation and mainnet funding remain disabled until that dependency
and the other release gates are satisfied.
