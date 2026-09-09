"""Run inside the existing Speculos fixture container. Public test mnemonic only."""
import json, os, threading, time, socket
from pathlib import Path
import requests
from speculos.client import SpeculosClient
from ledger_bitcoin.client import NewClient
from ledger_bitcoin.common import Chain
from ledger_bitcoin import WalletPolicy

root = Path('/native-savings-20260908')
seed = 'glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin'
key = "[f5acc2fd/86'/1'/0']tpubDDKYE6BREvDsSWMazgHoyQWiJwYaDDYPbCFjYxN3HFXJP5fokeiK4hwK5tTLBNEDBwrDXn8cQ4v9b2xdW62Xr5yxoQdMu1v6c7UDXYVH27U"
url = 'http://127.0.0.1:5002'
os.environ['SPECULOS_APPNAME'] = 'Bitcoin Test:2.4.2'
rows = []
fixtures = json.loads((root/'core.json').read_text())['results']
cases = [(r['tier'], r['descriptor']) for r in fixtures if not r['full']]
cases += [('fixed-placeholder', 'tr(@0,pk(@0))'), ('derived-positive-control', 'tr(@0/**,pk(@0/<2;3>/*))')]
for name, descriptor in cases:
    comm = SpeculosClient('/app/build/nanos2/bin/app.elf', ['--model','nanosp','--seed',seed,'--display','headless','--api-port','5002','--apdu-port','5003'], api_url=url)
    def wait_ready():
        for _ in range(600):
            try:
                with socket.create_connection(('127.0.0.1',5002),timeout=1): return
            except OSError: time.sleep(.1)
        raise RuntimeError('Speculos startup timeout')
    comm._wait_until_ready=wait_ready
    comm.start(); done = threading.Event(); screens = []
    def navigate():
        last = None
        while not done.wait(.25):
            try:
                events = requests.get(url+'/events?currentscreenonly=true', timeout=2).json()['events']
                text = ' | '.join(e['text'] for e in events)
                if not text or text == last: continue
                last = text; screens.append(text)
                if any(x in text for x in ['Processing','Loading','app is ready','Application is ready']): continue
                button = 'both' if any(x in text for x in ['Sign transaction','Continue','Approve','Accept','Register']) else 'right'
                requests.post(url+'/button/'+button, json={'action':'press-and-release'}, timeout=2)
            except Exception: pass
    thread=threading.Thread(target=navigate,daemon=True); thread.start()
    # Bound emulator interaction even if UI navigation changes.
    timer=threading.Timer(45,comm.stop); timer.start()
    try:
        client=NewClient(comm,chain=Chain.TEST,debug=False)
        result=client.register_wallet(WalletPolicy('Native Savings',descriptor,[key]))
        row={'case':name,'registered':True,'walletId':result[0].hex()}
    except Exception as error:
        row={'case':name,'registered':False,'error':str(error),'type':type(error).__name__}
    finally:
        done.set(); thread.join(3); timer.cancel(); comm.stop()
    row['screens']=screens; rows.append(row); print(json.dumps(row),flush=True)
(root/'ledger.json').write_text(json.dumps(rows,indent=2)+'\n')
assert all(not r['registered'] for r in rows[:-1])
assert rows[-1]['registered']
