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

The ordinary two-key path does not need the recovery services. Starting delayed
recovery after losing one key still depends on both recovery services. Ledger
checks Bitcoin scripts and signatures; it does not evaluate those services’
programs or remove their trust assumptions.

Normal signing, change recognition and signature verification have simulator
coverage. The complete new delayed-recovery family, phone HD backup restoration,
funded lifecycle tests and physical Ledger review remain release requirements.
New native enrollment stays disabled until those requirements pass. Existing
funded connector wallets require an explicit migration transaction.

Spending has separate recovery paths. Its unilateral exit needs saved transaction
paths updated after activity; Savings policy registration does not replace that
backup or remove its synchronization requirement.

See the [implementation evidence and release gates](ledger-native-savings-design.md)
and [Ledger’s integration specification](https://github.com/LedgerHQ/app-bitcoin/blob/develop/doc/integration.md).
