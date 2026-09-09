"""Run inside the existing Speculos fixture container. Public test mnemonic only."""
import json, os, threading, time, socket, hashlib
from pathlib import Path
import requests
from speculos.client import SpeculosClient
from ledger_bitcoin.client import NewClient
from ledger_bitcoin.common import Chain
from ledger_bitcoin import WalletPolicy
from ledger_bitcoin.psbt import PSBT

root = Path('/native-savings-20260908')
seed = 'glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin'
url = 'http://127.0.0.1:5002'
os.environ['SPECULOS_APPNAME'] = 'Bitcoin Test:2.4.2'
rows = []
fixtures=json.loads((root/'ledger-recovery-inputs.json').read_text())
case_set=os.environ.get('RECOVERY_CASE_SET','all')
assert case_set in ['all','hardware-initiation'],'unknown recovery case set'
if case_set=='hardware-initiation':
    fixtures=[fixture for fixture in fixtures if fixture['id'].endswith('-hardware-normal')]
if os.environ.get('CANDIDATE_TIER'):
    fixtures=[fixture for fixture in fixtures if fixture['id']==os.environ['CANDIDATE_TIER']]
assert fixtures,'no recovery cases selected'
if case_set=='hardware-initiation' and not os.environ.get('CANDIDATE_TIER'):
    assert len(fixtures)==2 and sum(len(f['payments']) for f in fixtures)==4
for fixture in fixtures:
    name=fixture['id']
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
    timer=threading.Timer(900,comm.stop); timer.start()
    row={'tier':name,'registered':False,'payments':[]}
    try:
        client=NewClient(comm,chain=Chain.TEST,debug=False)
        wallet=WalletPolicy(fixture['name'],fixture['template'],fixture['keys'])
        binding=json.dumps([fixture['name'],fixture['template'],fixture['keys']],separators=(',',':'))
        cache_file=root/('candidate-registration-'+hashlib.sha256(binding.encode()).hexdigest()+'.json')
        reused_registration=cache_file.exists()
        if reused_registration:
            cache=json.loads(cache_file.read_text()); assert cache['binding']==binding
            wallet_id=bytes.fromhex(cache['walletId']);hmac=bytes.fromhex(cache['hmac'])
        else:
            wallet_id,hmac=client.register_wallet(wallet)
            cache_file.write_text(json.dumps({'binding':binding,'walletId':wallet_id.hex(),'hmac':hmac.hex(),'registrationScreens':screens}))
        row={'tier':name,'registered':True,'walletId':wallet_id.hex(),'registrationReused':reused_registration,'caseSet':case_set,'addresses':{},'payments':[]}
        print('REGISTERED',name,flush=True)
        expected_addresses=fixture.get('addresses',{'0':fixture.get('address')})
        for coordinate,expected in expected_addresses.items():
            change=int(coordinate)
            address=client.get_wallet_address(wallet,hmac,change,0,False)
            assert address==expected,(address,expected)
            row['addresses'][str(change)]=address
            print('ADDRESS',name,change,address,flush=True)
        for payment in fixture['payments']:
            start=len(screens)
            packet=PSBT();packet.deserialize(payment['psbt'])
            if payment.get('signingOrder')=='hardware-then-fixture-guardian':
                assert not packet.inputs[0].tap_script_sigs,'Guardian signature must not precede hardware approval'
            result=client.sign_psbt(packet,wallet,hmac)
            signatures=[{'index':i,'pubkey':sig.pubkey.hex(),'signature':sig.signature.hex()} for i,sig in result]
            assert len(signatures)==1 and signatures[0]['index']==0
            assert signatures[0]['pubkey']==payment['hardware']
            row['payments'].append({'label':payment['label'],'signatures':signatures,'screens':screens[start:]})
            print('SIGNED',name,payment['label'],flush=True)

    except Exception as error:
        row.update({'error':str(error),'type':type(error).__name__})
    finally:
        done.set(); thread.join(3); timer.cancel(); comm.stop()
    row['screens']=screens; rows.append(row); print(json.dumps(row),flush=True)
(root/('ledger-recovery-'+os.environ.get('CANDIDATE_TIER',case_set)+'.json')).write_text(json.dumps(rows,indent=2)+'\n')
assert len(rows)==len(fixtures) and all(r['registered'] and 'error' not in r and len(r['payments'])==len(f['payments']) for r,f in zip(rows,fixtures))
