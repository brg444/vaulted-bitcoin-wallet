// Public deterministic fixture keys only. Run explicitly when changing the named contract.
import { createServer } from 'vite'
import { Transaction, Address, OutScript } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const vite = await createServer({
  root,
  configFile: false,
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  appType: 'custom',
})
const { prepareConnectorPayment } = await vite.ssrLoadModule('/src/lib/vault/program/connectorPayment.ts')
const { buildConnectorFamily, connectorEnrollmentDigest, DUAL_CONNECTOR_TEMPLATE } = await vite.ssrLoadModule(
  '/src/lib/vault/program/connector.ts',
)
const { defaultSpendingPolicy } = await vite.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
const { vaultAddressNetwork } = await vite.ssrLoadModule('/src/lib/vault/addressNetwork.ts')
const { tweakPrivateKey } = await vite.ssrLoadModule('/src/lib/vault/program/tweak.ts')
const v = JSON.parse(readFileSync(root + '/src/lib/vault/program/connector-vectors.json'))[0],
  hd = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x42))
const sk = (n) => {
  const b = new Uint8Array(32)
  b[31] = n
  return b
}
const options = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true }
const rows = []
for (const network of ['mainnet', 'mutinynet'])
  for (const kind of ['p2tr', 'p2wpkh'])
    for (const tier of ['standard', 'advanced']) {
      const policy = defaultSpendingPolicy(network),
        purpose = kind === 'p2tr' ? 86 : 84,
        coin = network === 'mainnet' ? 0 : 1
      const key = hd.derive(`m/${purpose}'/${coin}'/0'/0/0`),
        origin = {
          publicKey: key.publicKey,
          fingerprint: hd.fingerprint,
          path: [0x80000000 + purpose, 0x80000000 + coin, 0x80000000, 0, 0],
        }
      const contract = {
        vaultId: 'dual-connector-fixture',
        network,
        templateVersion: DUAL_CONNECTOR_TEMPLATE,
        connectorType: kind,
        phonePub: v.phone,
        hardwarePub: hex.encode(key.publicKey),
        ...(tier === 'advanced' ? { recoveryPub: v.recovery } : {}),
        phoneDirectP256: v.phoneDirect,
        vaultCosignerBase: v.guardian,
        arkadeCosignerBase: v.emulator,
        protectionTier: tier,
        spendingPolicy: policy,
        absoluteFeeCapSats: policy.absoluteFeeCapSats,
        feerateCapSatPerV: policy.feerateCapSatPerV,
      }
      const family = buildConnectorFamily(contract),
        digest = connectorEnrollmentDigest(contract, origin)
      const parent = new Transaction(options)
      parent.addInput({ txid: '00'.repeat(32), index: 99 })
      parent.addOutput({ script: family.savings.script, amount: 100000n })
      for (let i = 0; i < 2; i++) parent.addOutput({ script: family.connector.script, amount: 500n })
      const c = (vout) => ({ parentHex: hex.encode(parent.toBytes(true, true)), txid: parent.id, vout })
      const payments = []
      for (const full of [false, true]) {
        const request = {
          contract,
          origin,
          enrollmentDigest: digest,
          savings: c(0),
          reserve: c(1),
          secondReserve: c(2),
          recipient: Address(vaultAddressNetwork(network)).encode(
            OutScript.decode(hex.decode(v.payments[0].recipientScript)),
          ),
          amountSats: full ? 98760 : 8000,
          feeSats: 1000,
        }
        const initial = prepareConnectorPayment(request),
          approval = Transaction.fromPSBT(hex.decode(initial.hardwareApproval()), options)
        for (const i of [0, 1]) approval.signIdx(key.privateKey, i, [3])
        const sigs = initial.acceptHardwareApproval(hex.encode(approval.toPSBT()))
        const ready = prepareConnectorPayment({ ...request, hardwareSignatures: sigs })
        const phonePSBT = ready.signPhone(sk(3))
        const tx = Transaction.fromPSBT(hex.decode(phonePSBT), options)
        for (const n of [14, 15]) tx.signIdx(tweakPrivateKey(sk(n), family.program), 2, [0])
        const pubs = [family.normalTweaks.arkade, family.normalTweaks.vault, contract.phonePub],
          witness = pubs.map(
            (pub) => tx.getInput(2).tapScriptSig.find(([k]) => hex.encode(k.pubKey) === pub.slice(2))[1],
          )
        witness.push(family.savings.normal, family.savings.control)
        const final = ready.forHardware(witness).accept(ready.psbt())
        payments.push({
          full,
          amount: request.amountSats,
          fee: 1000,
          parent: c(0).parentHex,
          hardwareSignatures: sigs,
          phonePSBT,
          finalTx: final.txHex,
          txid: final.txid,
        })
      }
      rows.push({
        contract,
        origin: { ...origin, publicKey: hex.encode(origin.publicKey) },
        enrollmentDigest: digest,
        program: hex.encode(family.program),
        rules: { ...family.rules, connectorScript: hex.encode(family.rules.connectorScript) },
        savingsScript: hex.encode(family.savings.script),
        leaf: hex.encode(family.savings.normal),
        control: hex.encode(family.savings.control),
        payments,
      })
    }
writeFileSync(root + '/src/lib/vault/program/connector-dual-vectors.json', JSON.stringify(rows, null, 2) + '\n')
await vite.close()
console.log('Generated 8 family vectors / 16 hardware-first completed transactions using public fixture keys.')
