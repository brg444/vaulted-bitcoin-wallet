"""Offline test adapter for Electrum's unmodified Qt transaction dialog.

Only file selection, the containing window, and password/thread dispatch are
test adapters. The parser, dialog, output menu, signing checks, wallet, and
transaction exporters are upstream code. No desktop or network is controlled.
"""
import base64
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QTextCursor
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QMenu
from electrum.gui.qt.main_window import ElectrumWindow
from electrum.gui.qt.transaction_dialog import TxDialog


def review_and_sign(wallet, config, request, directory):
    app = QApplication.instance() or QApplication([])
    config.GUI_QT_TX_DIALOG_FETCH_TXIN_DATA = False
    config.BTC_AMOUNTS_DECIMAL_POINT = 0

    def fail(message, **kwargs):
        raise AssertionError(message)

    def sign(tx, *, callback, external_keypairs):
        assert external_keypairs is None
        # Keep the stricter wallet warning checks enabled as in the non-Qt test.
        wallet.sign_transaction(tx, password=None)
        callback(True)

    parent = SimpleNamespace(
        config=config, wallet=wallet,
        fx=SimpleNamespace(is_enabled=lambda: False),
        format_amount=config.format_amount,
        format_fee_rate=config.format_fee_rate,
        base_unit=config.get_base_unit,
        format_fiat_and_units=lambda amount: "",
        show_critical=fail,
        do_copy=lambda text, **kwargs: app.clipboard().setText(text),
        push_top_level_window=lambda window: None,
        pop_top_level_window=lambda window: None,
        sign_tx=sign,
    )
    parent.tx_from_text = lambda data: ElectrumWindow.tx_from_text(parent, data)
    # Exercise the actual menu's file reader with a binary .psbt export.
    input_path = Path(directory) / "Savings.psbt"
    input_path.write_bytes(bytes.fromhex(request["psbt"]))
    with patch("electrum.gui.qt.main_window.getOpenFileName", return_value=str(input_path)):
        tx = ElectrumWindow.read_tx_from_file(parent)
    assert tx is not None
    for text in (request["psbt"], base64.b64encode(input_path.read_bytes()).decode()):
        pasted = parent.tx_from_text(text)
        assert pasted.serialize_as_bytes() == tx.serialize_as_bytes()
    assert tx.inputs()[0].is_complete()
    foreign_witness = tx.inputs()[0].witness
    dialog = TxDialog(tx, parent=parent, prompt_if_unsaved=False,
                      prompt_if_complete_unsaved=False)
    dialog.show()
    app.processEvents()
    assert dialog.sign_button.isEnabled()
    assert not dialog.io_widget.sighash_danger.needs_confirm()
    assert not dialog.io_widget.sighash_danger.needs_reject()

    output_box = dialog.io_widget.outputs_textedit
    output_text = output_box.toPlainText()
    first_output = output_text.splitlines()[0]
    recipient = request["recipient"]
    display_address = recipient if len(recipient) <= 42 else recipient[:30] + "…" + recipient[-11:]
    assert display_address in first_output
    assert first_output.split("\t")[-1].strip() == config.format_amount(request["amount"]).strip()

    # Use the real right-click menu action to retrieve the entire address.
    cursor = output_box.textCursor()
    cursor.movePosition(QTextCursor.MoveOperation.Start)
    cursor.movePosition(QTextCursor.MoveOperation.Right, n=2)
    output_box.setTextCursor(cursor)
    output_box.ensureCursorVisible()
    position = output_box.cursorRect(cursor).center()
    menu_result = []

    def select_copy_address():
        menu = app.activePopupWidget()
        if isinstance(menu, QMenu):
            for action in menu.actions():
                if action.text() == "Copy Address":
                    action.trigger()
                    menu_result.append(True)
                    break
            menu.close()

    QTimer.singleShot(0, select_copy_address)
    dialog.io_widget.on_context_menu_for_outputs(position)
    assert menu_result == [True], "recipient output did not expose Copy Address"
    assert app.clipboard().text() == recipient

    artifact_dir = os.environ.get("CONNECTOR_ELECTRUM_QT_ARTIFACTS")
    if artifact_dir:
        artifact_path = Path(artifact_dir)
        artifact_path.mkdir(parents=True, exist_ok=True)
        assert dialog.grab().save(str(artifact_path / (request["case"] + ".png")))

    QTest.mouseClick(dialog.sign_button, Qt.MouseButton.LeftButton)
    app.processEvents()
    assert dialog.tx.is_complete()
    assert not dialog.sign_button.isEnabled()
    assert dialog.tx.inputs()[0].witness == foreign_witness
    assert dialog.tx.get_fee() == request["fee"]

    actions = {action.text(): action for action in dialog.export_actions_menu.actions()}
    actions["Copy to clipboard"].trigger()
    clipboard_tx = app.clipboard().text()
    output_path = Path(directory) / "Savings-signed.txn"
    # Dismiss only the normal export-success acknowledgement.
    acknowledgements = []
    def acknowledge_export():
        from PyQt6.QtWidgets import QMessageBox
        message = app.activeModalWidget()
        if isinstance(message, QMessageBox):
            acknowledgements.append(message.text())
            message.accept()

    with patch("electrum.gui.qt.transaction_dialog.getSaveFileName", return_value=str(output_path)):
        QTimer.singleShot(0, acknowledge_export)
        actions["Save to file"].trigger()
    assert acknowledgements == ["Transaction exported successfully"]
    file_tx = output_path.read_text()
    assert file_tx.strip() == clipboard_tx
    result = {
        "tx": file_tx,
        "psbt": dialog.tx.serialize_as_bytes(force_psbt=True).hex(),
        "outputs": [{"address": out.get_ui_address_str(), "sats": out.value} for out in dialog.tx.outputs()],
        "review": {"recipient": recipient, "text": output_text},
    }
    dialog.close()
    return result
