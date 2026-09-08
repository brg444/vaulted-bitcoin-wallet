"""Source-level Specter DIY test using upstream native-test GUI stubs, not a device test."""
import sys, json, pathlib, tempfile
from io import BytesIO
source=pathlib.Path(sys.argv[1]).resolve()
evidence=pathlib.Path(__file__).resolve().parent/'evidence'
sys.path[:0]=[str(source/'test'),str(source/'src'),str(source/'f469-disco/libs/common/embit/src')]
from native_support import setup_native_stubs
setup_native_stubs()
from apps.wallets.wallet import Wallet
from apps.wallets.manager import WalletManager
from embit.psbtview import PSBTView
from keystore.ram import RAMKeyStore
from embit import bip32, ec, hashes
from embit.psbt import PSBT, DerivationPath
from embit.transaction import SIGHASH
root=bip32.HDKey.from_seed(bytes([0x42])*32)
rows=[]
for row in json.loads((evidence/'core.json').read_text())['results']:
    # Express only the hardware key through its real HD origin. Other keys remain fixed.
    # Index zero resolves to the enrolled key; the complete script must remain byte-identical.
    key_origin=row['hardwareOrigin'].rsplit('/',1)[0]
    parent=root.derive("m/86h/1h/0h/0").to_public().to_base58(bytes.fromhex('043587cf'))
    desc=row['descriptor'].replace(row['hardware'],'['+key_origin+']'+parent+'/*')
    wallet=Wallet.from_descriptor(desc,None)
    assert wallet.descriptor.derive(0).script_pubkey().data.hex()==row['script']
    store=RAMKeyStore(); store.root=root; store.fingerprint=root.my_fingerprint
    owned=[k for k in wallet.keys if store.owns(k)]
    assert len(owned)==2
    packet=PSBT.from_string(row['phonePsbt'])
    public=ec.PublicKey.from_xonly(bytes.fromhex(row['hardware']))
    leaf_hashes=[]
    for script_version in packet.inputs[0].taproot_scripts.values():
        script,version=script_version[:-1],script_version[-1:]
        if public.xonly() in script:
            from embit import compact
            leaf_hashes.append(hashes.tagged_hash('TapLeaf',version+compact.to_bytes(len(script))+script))
    packet.inputs[0].taproot_bip32_derivations[public]=(leaf_hashes,DerivationPath(root.my_fingerprint,bip32.parse_path("m/86h/1h/0h/0/0")))
    assert wallet.owns(packet.inputs[0])
    wallet.keystore=store
    wallet.save=lambda keystore:None  # Persistence is outside this source-level signing test.
    with tempfile.TemporaryDirectory() as tmp:
        manager=WalletManager(tmp); manager.keystore=store; manager.network='regtest'
        manager.wallets=[wallet]; manager.show_loader=lambda **kwargs:None; manager.TEMPDIR=tmp
        prepared=BytesIO()
        wallets,metadata=manager.preprocess_psbt(BytesIO(packet.serialize()),prepared)
        assert wallet in wallets
        assert metadata['outputs'][0]['address']==packet.tx.vout[0].script_pubkey.address(manager.Networks['regtest'])
        assert metadata['outputs'][0]['value']==(99000 if row['full'] else 20000)
        signed_stream=BytesIO()
        manager.sign_psbtview(PSBTView.view(BytesIO(prepared.getvalue())),signed_stream,wallets,SIGHASH.ALL)
        packet=PSBT.parse(signed_stream.getvalue())
    before=1
    after=len(packet.inputs[0].taproot_sigs)
    assert after>before
    rows.append({'tier':row['tier'],'full':row['full'],'sameScript':True,'descriptor':desc,'recognizedInput':True,'recognizedKeyOccurrences':len(owned),'signatureAdded':after-before,'psbt':packet.to_string(),'reviewMetadata':metadata,'deviceDisplayTested':False})
    print(row['tier'],row['full'],'same script; recognized key; signed Savings input')
(evidence/'specter.json').write_text(json.dumps(rows,indent=2)+'\n')
