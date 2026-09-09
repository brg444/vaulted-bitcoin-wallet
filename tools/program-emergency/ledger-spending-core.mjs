// Public test keys and network-disabled Bitcoin Core regtest only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
const require = createRequire(import.meta.url),
  { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const root = process.cwd(),
  dir = root + '/.vault-browser-tests/ledger-spending-core',
  container = 'vaulted-native-core-qualification'
function rpc(method, args = [], wallet = '') {
  const raw = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'bitcoin-cli',
      '-regtest',
      '-rpcuser=native-fixture',
      '-rpcpassword=disposable-local-test',
      ...(wallet ? ['-rpcwallet=' + wallet] : []),
      '-stdin',
      method,
    ],
    {
      input: args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + (args.length ? '\n' : ''),
      encoding: 'utf8',
      timeout: 30000,
    },
  ).trim()
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
assert.equal(rpc('getblockchaininfo').chain, 'regtest')
assert.equal(rpc('getnetworkinfo').networkactive, false)
assert.equal(rpc('getnetworkinfo').connections, 0)
await mkdir(dir, { recursive: true })
await build({
  stdin: {
    resolveDir: root,
    contents: `
import {fixture,seed,otherSeed,chain} from './src/lib/vault/vtxo/ledgerRecoveryFee.fixture';
import {ledgerRecoveryFeeWallet,signLedgerRecoveryFeeWithSeed} from './src/lib/vault/vtxo/ledgerRecoveryFee';
import {signLedgerSpendingRecoveryWithSeed} from './src/lib/vault/vtxo/ledgerSpendingRecovery';
import {prepareVaultSpendingRecovery} from './src/lib/vault/vtxo/spendingRecovery';
import {Transaction,OnchainWallet,ReadonlySingleKey} from '@arkade-os/sdk';import {p2tr} from '@scure/btc-signer';import {hex,base64} from '@scure/base';
import {scalarSecret,compressedFromScalar} from './src/lib/vault/program/fixtures';
export async function scripts(advanced){const f=await fixture(advanced,'mainnet');return {root:hex.encode(p2tr(hex.decode(compressedFromScalar(21)).slice(1)).script),fee:hex.encode(p2tr(hex.decode(ledgerRecoveryFeeWallet(f.file.archive.kit.descriptor).publicKey).slice(1)).script)}}
export async function prepare(advanced,rootCoin,feeCoin){
 const f=await fixture(advanced,'mainnet'),archive=structuredClone(f.file.archive),d=archive.kit.descriptor;
 const root=p2tr(hex.decode(compressedFromScalar(21)).slice(1));const tree=new Transaction({version:3});tree.addInput({txid:rootCoin.txid,index:rootCoin.vout,witnessUtxo:{amount:40000n,script:root.script},tapInternalKey:root.tapInternalKey});tree.addOutput({amount:40000n,script:hex.decode(d.spendingAuthorities.spendingArkScript)});tree.addOutput({amount:0n,script:hex.decode('51024e73')});tree.sign(scalarSecret(21));
 const oldCoin=JSON.parse(archive.spending.coins)[0],oldBranch=archive.spending.branches[oldCoin.txid+':0'];archive.spending.coins=JSON.stringify([{...oldCoin,txid:tree.id}]);archive.spending.branches={[tree.id+':0']:[{...oldBranch[0],txid:rootCoin.txid},{...oldBranch[1],txid:tree.id,spends:[rootCoin.txid]}]};archive.spending.transactions={[tree.id]:base64.encode(tree.toPSBT())};
 const finalTree=tree.clone();finalTree.finalize();const parentTxHex=hex.encode(finalTree.extract());
 const file=await prepareVaultSpendingRecovery(archive,f.file.exitPackage.sweepAddress,async({psbt})=>{const tx=Transaction.fromPSBT(hex.decode(psbt)),input=tx.getInput(0),output=tx.getOutput(0);const request={descriptor:d,coin:{txid:hex.encode(input.txid),vout:input.index,value:40000,parentTxHex},destination:f.file.exitPackage.sweepAddress,feeSats:40000-Number(output.amount)};let signed=signLedgerSpendingRecoveryWithSeed(request,seed,psbt,'hardware');if(advanced)return signLedgerSpendingRecoveryWithSeed(request,otherSeed,signed,'recovery');const partial=Transaction.fromPSBT(hex.decode(signed));partial.sign(scalarSecret(3));return hex.encode(partial.toPSBT())},chain());
 const pub=ledgerRecoveryFeeWallet(d),readonly=ReadonlySingleKey.fromPublicKey(hex.decode(pub.publicKey)),denied=()=>{throw Error('Unsupported operation')};
 const identity={compressedPublicKey:()=>readonly.compressedPublicKey(),xOnlyPublicKey:()=>readonly.xOnlyPublicKey(),signMessage:denied,signerSession:denied,sign:async tx=>Transaction.fromPSBT(hex.decode(signLedgerRecoveryFeeWithSeed({role:'hardware',file,parentTxid:hex.encode(tx.getInput(0).txid),feeAddress:pub.feeAddress,feeRate:file.exitPackage.feeRate,fundingCoins:[feeCoin]},seed,hex.encode(tx.toPSBT()))))};
 const wallet=await OnchainWallet.create(identity,'bitcoin',{...chain(),getCoins:async()=>[{...feeCoin,status:{confirmed:true,block_time:1,block_height:1}}]});const bump=file.exitPackage.steps.find(s=>s.kind==='bump');const pair=await wallet.bumpAnchor(bump.parentHex,file.exitPackage.feeRate);const sweep=Transaction.fromPSBT(hex.decode(file.sweeps[0]));sweep.finalize();return {pair,sweep:hex.encode(sweep.extract()),sweepTxid:sweep.id,delay:d.spendingAuthorities.vtxoExitDelay,destination:f.file.exitPackage.sweepAddress,amount:Number(sweep.getOutput(0).amount),file}
}
`,
  },
  outfile: dir + '/fixture.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  define: { 'import.meta.env': '{}' },
})
const fixture = require(dir + '/fixture.cjs'),
  wallet = 'ledger-exit-' + Date.now(),
  results = []
rpc('createwallet', [wallet])
const miner = rpc('getnewaddress', [], wallet)
rpc('generatetoaddress', [101, miner])
function fund(script, value) {
  const address = rpc('decodescript', [script]).address
  assert(address)
  const txid = rpc('sendtoaddress', [address, value / 1e8], wallet)
  rpc('generatetoaddress', [1, miner])
  const tx = rpc('getrawtransaction', [txid, true]),
    vout = tx.vout.find((o) => o.scriptPubKey.hex === script).n
  return { txid, vout, value, parentTxHex: tx.hex }
}
try {
  for (const advanced of [false, true]) {
    const scripts = await fixture.scripts(advanced)
    const plan = await fixture.prepare(advanced, fund(scripts.root, 40000), fund(scripts.fee, 20000))
    const acceptance = rpc('submitpackage', [plan.pair])
    assert.equal(acceptance.package_msg, 'success', JSON.stringify(acceptance))
    rpc('generatetoaddress', [1, miner])
    const immature = rpc('testmempoolaccept', [[plan.sweep]])[0]
    assert.equal(immature.allowed, false)
    assert.match(immature['reject-reason'], /non-BIP68-final/)
    let timestamp = rpc('getblockheader', [rpc('getbestblockhash')]).time + plan.delay + 7200
    rpc('setmocktime', [timestamp])
    rpc('generatetoaddress', [12, miner])
    const mature = rpc('testmempoolaccept', [[plan.sweep]])[0]
    assert.equal(mature.allowed, true, JSON.stringify(mature))
    assert.equal(rpc('sendrawtransaction', [plan.sweep]), plan.sweepTxid)
    rpc('generatetoaddress', [1, miner])
    assert(rpc('getrawtransaction', [plan.sweepTxid, true]).confirmations > 0)
    results.push({
      advanced,
      parentAndFeeChildAccepted: true,
      immatureSweepRejected: true,
      matureSweepConfirmed: true,
      amount: plan.amount,
      destination: plan.destination,
    })
    await writeFile(dir + '/' + advanced + '-prepared.json', JSON.stringify(plan.file))
  }
  await writeFile(
    dir + '/result.json',
    JSON.stringify(
      {
        scope:
          'Funded isolated regtest; mainnet scripts and policies, public offline seeds; SDK parent+CPFP then CSV sweep; no physical Ledger',
        results,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify(results))
} finally {
  rpc('unloadwallet', [wallet])
}
