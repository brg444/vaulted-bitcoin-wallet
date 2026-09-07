"""Sign public connector fixtures using an unmodified Electrum 4.8.1 wallet.

No daemon, network, existing wallet, or user secret is used. JSON stdin carries
the prepared PSBT and expected public origin; stdout returns the signed result.
"""
import asyncio
import json
import sys
import tempfile

from electrum import SimpleConfig, bip32, keystore, util
from electrum.version import ELECTRUM_VERSION
from electrum.wallet import Standard_Wallet
from electrum.wallet_db import WalletDB
from electrum.transaction import PartialTransaction


async def main():
    assert ELECTRUM_VERSION == "4.8.1", ELECTRUM_VERSION
    util.AS_LIB_USER_I_WANT_TO_MANAGE_MY_OWN_ASYNCIO_LOOP = True
    request = json.load(sys.stdin)
    if request["native"]:
        # Public fixture from Electrum's own test_wallet_vertical.py.
        store = keystore.from_seed("bitter grass shiver impose acquire brush forget axis eager alone wine silver", passphrase="", for_multisig=False)
    else:
        # Matches the deliberately public seed in the Go BIP84 fixture.
        root = bip32.BIP32Node.from_rootseed(bytes([0x42]) * 32, xtype="p2wpkh")
        path = "m/84'/0'/0'"
        account = root.subkey_at_private_derivation(path)
        store = keystore.from_xprv(account.to_xprv())
        store.add_key_origin_from_root_node(derivation_prefix=path, root_node=root)
    with tempfile.TemporaryDirectory(prefix="connector-electrum-") as directory:
        config = SimpleConfig({"electrum_path": directory, "offline": True})
        db = WalletDB("", storage=None, upgrade=True)
        db.put("keystore", store.dump())
        db.put("gap_limit", 1)
        db.put("gap_limit_for_change", 1)
        wallet = Standard_Wallet(db, config=config)
        wallet.synchronize()
        if request.get("qt"):
            from electrum_qt import review_and_sign
            print(json.dumps(review_and_sign(wallet, config, request, directory)))
            return
        tx = PartialTransaction.from_raw_psbt(request["psbt"])
        assert tx.inputs()[0].is_complete()
        assert not tx.inputs()[1].is_complete()
        tx.add_info_from_wallet(wallet)
        assert wallet.can_sign(tx), "wallet did not recognize its connector input"
        # These output strings are also used by Electrum's transaction UI.
        outputs = [{"address": out.get_ui_address_str(), "sats": out.value} for out in tx.outputs()]
        assert outputs[0]["address"] == request["recipient"]
        assert outputs[0]["sats"] == request["amount"]
        foreign_witness = tx.inputs()[0].witness
        wallet.sign_transaction(tx, password=None)
        assert tx.is_complete(), "wallet signing did not complete the transaction"
        assert tx.inputs()[0].witness == foreign_witness
        assert tx.get_fee() == request["fee"]
        print(json.dumps({"tx": tx.serialize(), "psbt": tx.serialize_as_bytes(force_psbt=True).hex(), "outputs": outputs}))


asyncio.run(main())
