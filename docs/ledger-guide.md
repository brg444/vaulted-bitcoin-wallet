# Ledger and Vaulted Savings

The native Ledger integration is under qualification and is not enabled for new
RC enrollments yet. Existing wallets retain the contract selected when they were
created. If your wallet asks for two 500-sat signer reserves, use the
[existing connector wallet guide](ledger-connector-guide.md).

## Native Savings setup

Connect the Ledger through a supported desktop browser and open its Bitcoin app.
Vaulted reads its public account information and sends the complete **Vaulted
Savings** policy for registration. Review the policy and its public keys on the
device, then verify the receiving address. You register one policy; Vaulted
supplies every key entry automatically.

Keep the Ledger seed backup and the Vaulted recovery package. They serve different
purposes: the seed restores the Ledger keys, while the package preserves the
wallet policy, phone-key backup and recovery data. A policy registration record
by itself cannot recover funds. If the registration authorization is lost, the
same Ledger seed can register the original policy again.

USB access depends on the browser. The current integration targets desktop
browsers with WebHID. It does not establish a direct USB signing flow in iOS
Safari or support for an arbitrary desktop wallet importing this policy.

## Receive and send

Receive bitcoin at the verified Savings address. Normal native Savings has no
signer reserve to fund.

When sending, approve the retained payment with the phone, then check the
recipient address, amount and network fee on the Ledger. The device signs the
Savings input itself. Its DEFAULT signature commits to every output, including
Savings change. Vaulted verifies the returned signature against the original
payment before passing it to the transaction submission flow.

The qualified simulator flow displayed the named account and payment details
without external-input or non-default signature warnings. A request to enable
non-default signing is outside this native flow; cancel it and check the wallet
contract. A failed or cancelled device approval is not retried automatically.

## Recovery and qualification

The ordinary two-key path needs the phone and Ledger. Starting delayed recovery
after losing one key requires a remaining user authority and the Guardian. The
Guardian alone cannot spend. If an attacker controls both a recovery user key
and the Guardian key, they can bypass the pending stage and steal through that
recovery leaf. Ledger's transaction review does not protect a different path
that can be signed without it.

After the pending transaction confirms, its claimant waits the enrolled block
delay. The remaining user authorities can cancel through their saved scripts.
The shorter hardware delay applies to this pending stage; it is not a guaranteed
intervention window when the initiation keys are compromised.

Simulator, complete backup restoration and funded service lifecycle tests pass,
allowing software deployment with native enrollment disabled. Physical Ledger
review remains required before enabling new enrollment, while existing funded
connector wallets require an explicit migration transaction.

The stock Ledger app cannot sign the existing Spending exit tree. Emergency
Spending recovery therefore uses a separately bundled offline signing tool. In
Standard, recovery needs the Ledger seed and the recovered phone key. Advanced
needs the Ledger seed and the separate recovery wallet seed. The tool checks
these keys against the saved enrollment before signing the reviewed exit.

Entering a seed gives that offline computer access to every account derived from
it. This is an emergency procedure: verify the recovery tool, disconnect the
computer from networks, review the destination and fee, and transfer only the
signed transaction back to the online recovery tool. Move remaining funds to new
seeds afterward. Never enter a seed into the normal online wallet or send it in
chat. Ordinary Savings payments continue to use the Ledger device.

The recovery companion exports a public signing request. Open the bundled offline
signer, disconnect its computer, review the recipient and fees, and enter the
required seed there. Import the resulting PSBT into the companion. Repeat with
the second authority when required; Standard keeps its phone approval and
Advanced needs both independent external authorities.

Bitcoin exit fees use the enrolled hardware account's ordinary Taproot receive
key at account `/0/0`. Advanced may instead use its enrolled recovery account.
Fund the displayed fee address with Bitcoin, then use the same offline handoff
for each requested fee signature. The signer verifies the saved exit graph,
funding parents, fee cap and change destination before signing. It cannot use
these fee inputs to redirect the recovered Spending funds. Parent publication,
fee funding and the final delayed sweep are separate Bitcoin transactions.

Spending has separate recovery paths. Its unilateral exit needs saved transaction
paths updated after activity; Savings policy registration does not replace that
backup or remove its synchronization requirement.

See the [implementation evidence and release gates](ledger-native-savings-design.md)
and [Ledger’s integration specification](https://github.com/LedgerHQ/app-bitcoin/blob/develop/doc/integration.md).
