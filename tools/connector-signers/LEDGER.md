# Ledger connector approval

Connector v2 lets a Ledger approve the recipient, amount and protected Savings
change while retaining the Emulator's independent fee, reserve and layout
checks. It requires Emulator v0.0.7's existing instructions and preserves the
contracts of previously enrolled v1 wallets.

## Transaction and approval

A prepared first deposit creates two 500-sat signer reserves. Withdrawals spend
those reserves at inputs 0 and 1, followed by Savings at input 2. The reserves
return to the enrolled signer for reuse.

| Withdrawal | Outputs, in order |
| --- | --- |
| Partial | Recipient, Savings change, reserve A, reserve B, 240-sat anchor, program packet |
| Full | Recipient, reserve A, reserve B, 240-sat anchor, program packet |

The hardware PSBT contains every monetary output. Its view omits the final,
zero-value program packet, which exceeds Ledger's accepted OP_RETURN size.
Both hardware inputs require `SIGHASH_SINGLE` without `ANYONECANPAY`: input 0
commits to the recipient and input 1 commits to Savings change, or to the first
returned reserve for a full withdrawal.

After both hardware signatures verify, Vaulted fills the packet and persists
the final candidate before requesting the passkey, Guardian and Emulator
signatures. Those Savings signatures use Bitcoin's default Taproot commitment
to the complete transaction. Reloads retain the approved candidate and all
three reserved outpoints.

## Independent verification

Ledger's generic non-default sighash warning also appears for `SIGHASH_NONE`.
An initial, unshipped prototype checked the hardware sighash only in the wallet
and Guardian. Qualification reproduced a valid Ledger `NONE` approval followed
by recipient substitution that this prototype's Emulator program accepted.

The corrected program independently reconstructs the Bitcoin BIP341 or BIP143
`SINGLE` digest for each hardware input and verifies the corresponding signature
with `OP_CHECKSIGFROMSTACK`. A signature made with `NONE` or `ANYONECANPAY`
cannot satisfy that check. The device warning is informational; the program
owns the signature commitment requirement.

The program also checks the original fee ceilings, protected change script,
reserve scripts and values, anchor, input sequences, output counts and canonical
packet placement. Canonical packet verification streams SHA256 over bounded
chunks because v0.0.7's `OP_INSPECTPACKET` can return at most 520 bytes. A tagged
script hash binds the supplied program chunks to the executing program.

The witness contains two compact 64-byte signatures, a 35-byte field carrying
the recipient script and its length, a compressed public key for native SegWit,
and program chunks of at most 500 bytes. Native SegWit's DER signatures convert
to the Emulator's compact, low-S ECDSA form. Bitcoin still validates the ordinary
hardware input signatures independently.

These policy checks depend on an honest Emulator. Bitcoin does not execute
Arkade Script, and the program cannot determine whether the address approved
on the device was the address the user meant to pay. The existing delayed
recovery paths and their signer requirements remain unchanged.

The additional proof adds approximately 2 KB to a withdrawal. Fee estimation
includes that cost, and the existing absolute and feerate ceilings still apply.

## Qualification boundary

The wallet qualification passes through the upstream v0.0.7 HTTP handler,
interpreter and signer. It covers 12 existing v1 cases and 40 v2 cases across
both connector types, both protection tiers, partial and full withdrawals, and
all five supported recipient script types. The v2 cases also reject 72 requests
that alter policy fields, packet structure or hardware approval commitments.
See [Emulator qualification](EMULATOR.md) for the isolated service setup.

Ledger application 2.4.2 source at
`2c7956fe566bd7f6f690288130033441fabc5f10` was compiled for Nano S Plus against
Ledger Secure SDK `473fe57b98c24ce9488b1dfecd51ad92fe665d19`, then exercised in
Speculos 0.27.0. Build adjustments affected include paths only. Full and partial
withdrawals for both Taproot and native SegWit each returned two `03`
signatures; all three completed Bitcoin inputs and the Emulator program
verified successfully. Eight shared wallet/Guardian fixtures also pin the
program bytes across networks, signer types and protection tiers, with 16
completed transactions verified by both Bitcoin and the Emulator.

This establishes compatibility with that application source in the simulator.
Physical-device approval, the exact Ledger Live distributed binary, and a
funded production relay test are separate qualifications.
