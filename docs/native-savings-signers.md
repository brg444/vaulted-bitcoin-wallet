# Native Savings signer qualification

Research date: 2026-09-08. Contract baseline: wallet `72227a1774a140580e5971a8dfc9c627088c80f5`, `phone-hww-recovery-savings-v1`. This assessment does not change RC, the Guardian, enrolled addresses, or funded contracts.

## Recommendation

Keep the original native Savings contract as the candidate and qualify **Specter DIY** next on an actual device. Its current source accepted the complete Savings descriptor, recognized the input, produced the correct recipient review data, and signed the Savings input. Bitcoin Core accepted the resulting transactions. This required real HD origin metadata for the hardware key; it did not require connectors, new recovery branches, or different Bitcoin scripts.

Ledger, BitBox02 and Jade remain preferred commercial hardware targets, but none passed qualification for this exact contract. Their blockers are specific enough to discuss with maintainers. A documented feature such as Taproot, Miniscript, or PSBT support is insufficient evidence of compatibility.

For an offline computer, Bitcoin Core is a verified signing engine. It is not yet a simple user flow: its RPC interface needs a dedicated review application. An offline device running a specified, tested signer is a reasonable alternative; an unspecified offline wallet is not a compatibility guarantee.

The accepted product direction allows more involved recovery while keeping routine withdrawals simple. Recovery can use a separate tool. This does not remove the requirement to validate the complete Savings tree during enrollment, and it does not change the existing cosigner trust assumptions.

## Measured results

The original cooperative Savings leaf requires the phone and hardware keys. Its withdrawal has one Savings input, a recipient output, and optional Savings change. It needs neither Guardian signatures nor an Emulator program packet in this normal path.

| Executed case | Core hardware signature, DEFAULT | Specter hardware signature, ALL |
| --- | ---: | ---: |
| Standard, full withdrawal | 169 vB | 170 vB |
| Standard, withdrawal with change | 212 vB | 213 vB |
| Advanced, full withdrawal | 169 vB | 170 vB |
| Advanced, withdrawal with change | 212 vB | 213 vB |

These are complete signed transaction sizes from isolated regtest, using a Taproot recipient and one Savings coin. More inputs or different destination scripts change the size. At an illustrative 1.5 sat/vB, 170–213 vB means approximately 255–320 sats. That is a size comparison, not a live fee quote or a prediction of the fee for an existing connector withdrawal. These native transactions have no 240-sat anchor.

Core imported descriptors containing **all original Savings leaves**. Their output scripts matched the wallet's generated scripts byte for byte. All eight signed withdrawals passed Core's `testmempoolaccept`; recipient mutations with the signed witnesses retained were rejected with an invalid Schnorr signature. Core ran with no network and no peers, funded by mined regtest coins. Broadcasting mainnet transactions is outside the harness.

The existing Savings builder, descriptor, tree and vector suites also passed: 29 tests. Complete recovery lifecycle qualification remains outstanding.

## Wallet results

| Signer | Result for the exact native contract | Evidence and remaining work |
| --- | --- | --- |
| **Specter DIY** | Strongest hardware candidate; source-level signing passed | Full descriptor preserves the Savings script at the enrolled index. Actual wallet manager recognized the input, generated recipient/amount/fee review metadata, and signed with ALL. Core validated four transactions. Physical display, QR/SD exchange, persistence, firmware build and recovery remain untested. |
| **Bitcoin Core 31.0** | Qualified as a software signing engine | Complete fixed-key descriptors imported; four native withdrawals signed and accepted. RPC-only qualification does not establish a usable offline review interface. |
| **Ledger Bitcoin 2.4.2, Speculos** | Registration blocked | Both full fixed-key Savings trees and a minimal fixed-placeholder policy returned `0x6a80` during registration. A derived Taproot policy registered successfully through the simulator's review screens. Current source still requires derived xpub key expressions. No Savings signing or destination-display success is claimed. |
| **BitBox02** | Blocked by current policy rules; source review | Its policy parser requires derived key placeholders; the existing fixed internal/cosigner keys fail that requirement. Validation also prohibits reuse of the same derived key across leaves, whereas Savings reuses the phone and hardware keys. No firmware or physical-device execution was performed. |
| **Jade** | Blocked by the inspected signing implementation | Its pinned libwally PSBT signing path explicitly lacks Taproot script-path support. Native Savings requires that additional signing capability. No native Savings device test was performed. |
| **Sparrow 2.5.4** | Complete descriptor import rejected | Its actual Drongo descriptor parser rejected both complete native Savings descriptors with `NoSuchElementException`. Previous connector tests concern a different contract. This does not qualify Sparrow as the native software signer. |
| **Electrum 4.8.1** | Complete descriptor import rejected | Executing its descriptor parser returned `and_v is not a valid descriptor function`. Its ordinary Taproot signing implementation uses the key path. |
| **COLDCARD Edge** | Current source does not accept the exact descriptor | The key parser accepts extended public keys only and requires ranged derivations. The fixed internal and program-tweaked keys fail those requirements. Its Tapscript/Miniscript work is relevant, but Edge is explicitly experimental and no device test was performed. |
| **Krux** | Relevant future candidate; current import assumptions conflict | Its descriptor loading code treats keys as extended keys and applies a specific NUMS check for an originless Taproot internal key. Our raw fixed keys and context-derived internal key conflict with those assumptions. No native signing execution was performed. |
| **Trezor** | Not qualified; inspected Bitcoin path does not supply the required script-path signing flow | Current signing code and message schema expose standard Taproot signing, without the complete arbitrary Tapscript registration/signing flow needed here. No device test was performed. |

BlueWallet and SeedSigner receive no new support claim from this research. PSBT support alone cannot qualify either. Liana is a useful reference for Miniscript enrollment and hardware integration, but its product-specific recovery descriptors are not evidence that it accepts Vaulted's program tree.

## Why the hardware policy restrictions matter

The original Savings tree consists of an immediate phone-plus-hardware leaf and recovery-initiation leaves requiring the relevant user key plus two program-tweaked cosigner keys. Its internal key is derived for the vault context and has no known private key. The recovery mechanism extends into separate quarantine and pending output trees.

Ledger and BitBox policies operate on extended keys with derivations. Putting a fixed public key inside an artificial xpub and appending a required wildcard changes the derived public key, so it does not preserve the enrolled Savings script. Replacing the internal key, using different role keys per leaf, or changing the cosigner derivation scheme would also create a new contract. Those changes cannot be disguised as PSBT metadata updates.

Specter accepted a narrower representation change. The hardware fixture already comes from an HD wallet. Expressing its real parent xpub with its real origin and deriving the enrolled index reconstructs the same public key; the other keys remain fixed. The tests compare the full derived output script against the existing contract before signing. Only the enrolled index is valid for this vault. Vaulted deposit addresses must remain restricted to the enrolled index, whose recovery context is committed by the existing program.

For the partial withdrawal, Specter's review metadata shows both the recipient and the Savings remainder as outputs. It does not hide the remainder as automatically recognized change. This is conservative, but the actual device interaction still needs review. The interface must make those two destinations understandable without teaching users to approve an unexplained output.

## Recovery and offline operation

Normal withdrawals can remain a short PSBT exchange with the external signer. A separate recovery application can reconstruct the named program, inspect the Recovery Kit, coordinate any required cosigner steps, track timelocks, and build the appropriate claim or clawback transactions. The user need not perform those operations during routine sends.

Keeping this tree preserves its existing limits. The normal phone-plus-hardware path remains available without the Guardian, given the keys, descriptor and chain data. Recovery paths requiring program cosigners retain those availability and enforcement dependencies. A compromised phone together with compromised cosigning keys is not defeated merely by moving the recovery UI elsewhere; Bitcoin does not enforce the program's output-inspection rules. No new hardware-only recovery guarantee is introduced here.

The recovery package needs more than the registered Savings descriptor. Quarantine and pending contracts, their exact parameters, deployment and program identities, key origins, and the relevant transaction data must remain recoverable. Spending unilateral exit additionally needs current exit-path data after activity. The Spending archive remains a separate requirement after Savings signing changes.

An offline computer running Core or a qualified standalone signer could hold the external key and review the actual transaction. The transfer would carry the PSBT through QR or removable media. The signing application must validate the committed input tree, display recipient, amount, fee and every unrecognized output, and restrict normal approvals to ALL or DEFAULT. Merely showing text supplied by the online wallet would not satisfy the security check. The device should generate and retain its own key; requiring users to export their hardware-wallet seed into this fallback would defeat the intended separation.

## Release gates and next steps

1. **Qualify Specter on a physical device.** Pin a reproducible firmware build. Import the complete descriptor, confirm the enrolled address, persist it, reboot, and repeat the address check. Exercise partial and full withdrawals through the supported QR or SD path, recording the complete recipient, amount, remainder and fee display. Verify returned signatures against the exact transaction the user reviewed.
2. **Exercise failure cases.** Refuse changed recipients, amounts, extra outputs, incorrect prevout values, modified trees and control blocks, and noncommitting sighash modes. Test cancellation and repeated PSBT import without creating duplicate payments. The current executable tests cover recipient mutation and supported signature modes; the remaining cases require additional execution.
3. **Exercise recovery separately.** Cover lost phone, lost external signer, unavailable cosigners, advanced recovery-key use, quarantine/clawback and matured claims with the external signing choice. Record which steps need services and which work offline. Existing tree fixtures are not a substitute for that funded lifecycle test.
4. **Offer a bounded offline fallback.** Core is already proven as the signing engine. A standalone review interface would still need its own validation and usability work. Specter on a separate offline computer is another engineering candidate, not a tested end-user recommendation yet.
5. **Take the exact vectors to Ledger, BitBox and Jade maintainers.** For Ledger and BitBox, ask about fixed external/internal keys, mixed fixed and derived policies, and key reuse across branches. For Jade, ask about native Tapscript PSBT signing in its pinned library and firmware. Release dates and compatibility commitments require confirmation from maintainers.
6. **Migrate only after qualification.** Existing connector funds remain governed by their funded script. Returning to the native contract requires an authorized migration transaction; changing enrollment defaults cannot rewrite those coins.

A new contract should be considered only if the demonstrated native signing path fails the product requirements or the preferred hardware vendors require a specified contract change. More involved recovery is acceptable; sacrificing its protections or adding routine connector machinery is a separate decision.

## Evidence and source pins

[Executable fixtures and results](../tools/native-savings-signers/README.md) use deterministic public keys and isolated regtest coins throughout, with user keys and production wallets excluded from the harness.

- Wallet baseline: [trees.ts at 72227a1](https://github.com/brg444/vaulted-bitcoin-wallet/blob/72227a1774a140580e5971a8dfc9c627088c80f5/src/lib/vault/program/trees.ts), [savingsSpend.ts](https://github.com/brg444/vaulted-bitcoin-wallet/blob/72227a1774a140580e5971a8dfc9c627088c80f5/src/lib/vault/savingsSpend.ts).
- Ledger current parser: [610292a, wallet.c](https://github.com/LedgerHQ/app-bitcoin/blob/610292a89ec6ff9fc1dea889ac29bf75bbc32b42/src/common/wallet.c), [registration](https://github.com/LedgerHQ/app-bitcoin/blob/610292a89ec6ff9fc1dea889ac29bf75bbc32b42/src/handler/register_wallet.c). Executed app: Bitcoin Test 2.4.2, source `2c7956fe566bd7f6f690288130033441fabc5f10`, Speculos 0.27.0; ELF SHA256 `db1608c935989d39fda91054bfff5e02460d6cfc79d21ca0646a7dc5a6ec03b9`. Physical Ledger behavior and execution of current develop remain untested.
- BitBox: [554a055, policies.rs](https://github.com/BitBoxSwiss/bitbox02-firmware/blob/554a0558ab6e0a45ba5c6e524caaddf033c49d2a/src/rust/bitbox02-rust/src/hww/api/bitcoin/policies.rs), especially `parse_wallet_policy_pk`, `validate_keys`, and `get_leaf_hash_by_pubkey`.
- Jade: [9c09729, sign_psbt.c](https://github.com/Blockstream/Jade/blob/9c097297f58339c15fb9b8df4c7fe105efefb902/main/process/sign_psbt.c), pinned [libwally 3bf543c, psbt.c](https://github.com/ElementsProject/libwally-core/blob/3bf543cd06a67fdd877688a6304808f270351aee/src/psbt.c), `wally_psbt_get_input_signature_hash` and its script-path TODO.
- Specter DIY: [b2d87e5, wallet manager](https://github.com/cryptoadvance/specter-diy/blob/b2d87e55338289a258ee985b26c7b064d5b49132/src/apps/wallets/manager.py), [wallet](https://github.com/cryptoadvance/specter-diy/blob/b2d87e55338289a258ee985b26c7b064d5b49132/src/apps/wallets/wallet.py). Its f469-disco pin is `9dd8515aaa0de80cf5d2ae1499de14beb33f863a`, embit pin `eb6104fd85d3becabba628756cd5e1b75619f3a1`. Tests execute these sources with upstream native-test GUI stubs; persistence is stubbed and no physical screen is exercised.
- Sparrow 2.5.4: `8871f4f1af528a4673fee6129373c884e3267860`; [Drongo parser 080cf3f](https://github.com/sparrowwallet/drongo/blob/080cf3f7cf74133ba68b369065d0f2e7ea4337da/src/main/java/com/sparrowwallet/drongo/OutputDescriptor.java).
- Electrum 4.8.1: [1bfee7d, descriptor.py](https://github.com/spesmilo/electrum/blob/1bfee7d1956ccb31778c76955683b789d1585d0c/electrum/descriptor.py).
- COLDCARD Edge: [095b1f3, desc_utils.py](https://github.com/Coldcard/firmware/blob/095b1f36dd5b28cc9886fda599a0ffc2d9e619c0/shared/desc_utils.py), `ExtendedKey.parse_key` and `KeyDerivationInfo.parse`; [experimental release notice](https://github.com/Coldcard/firmware/blob/095b1f36dd5b28cc9886fda599a0ffc2d9e619c0/releases/EdgeChangeLog.md).
- Krux: [1e7216b, wallet.py](https://github.com/selfcustody/krux/blob/1e7216b11d257fcbe8359325c6046efd74171dd1/src/krux/wallet.py), `Wallet.load`; [Taproot marked experimental in settings](https://selfcustody.github.io/krux/getting-started/settings/).
- Trezor: [current Bitcoin signing code](https://github.com/trezor/trezor-firmware/blob/main/core/src/apps/bitcoin/sign_tx/bitcoin.py), [message schema](https://github.com/trezor/trezor-firmware/blob/main/common/protob/messages-bitcoin.proto), retrieved 2026-09-08. This row is source review, not a pinned firmware execution.
