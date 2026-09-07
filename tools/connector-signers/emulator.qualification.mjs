import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { createServer } from 'vite'
import { Address, OutScript, Transaction } from '@scure/btc-signer'
import { hex, base64 } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js'
import { schnorr } from '@noble/curves/secp256k1.js'

// This qualification accepts only an isolated local emulator with public
// fixture key 15. It cannot contact a production signing service.
const origin = new URL(process.env.CONNECTOR_EMULATOR_ORIGIN || 'http://invalid')
assert.equal(origin.protocol, 'http:')
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname), 'isolated loopback emulator required')
assert.equal(origin.username + origin.password + origin.search + origin.hash, '')
assert.equal(origin.pathname, '/')
const root = fileURLToPath(new URL('../../', import.meta.url))
const vite = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: 'custom' })
after(() => vite.close())
const { prepareConnectorPayment } = await vite.ssrLoadModule('/src/lib/vault/program/connectorPayment.ts')
const { buildConnectorFamily, connectorEnrollmentDigest, DUAL_CONNECTOR_TEMPLATE } = await vite.ssrLoadModule(
  '/src/lib/vault/program/connector.ts',
)
const { defaultSpendingPolicy } = await vite.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
const vectors = JSON.parse(
  await readFile(new URL('../../src/lib/vault/program/connector-vectors.json', import.meta.url), 'utf8'),
)
const info = await fetch(new URL('/v1/info', origin), { redirect: 'error', signal: AbortSignal.timeout(15000) })
assert.equal(info.status, 200)
const identity = await info.json()
assert.equal(identity.version, 'v0.0.7')
assert.equal(identity.signerPubkey, vectors[0].emulator)
const options = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true }
async function submit(tx) {
  return fetch(new URL('/v1/onchain-tx', origin), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: base64.encode(tx.toPSBT()) }),
  })
}

for (const v of vectors.filter((v) => v.network === 'mainnet')) {
  for (const p of v.payments) {
    test(`upstream emulator HTTP ${v.originType} ${v.tier} ${p.full ? 'full' : 'partial'}`, async () => {
      const policy = defaultSpendingPolicy(v.network)
      const contract = {
        vaultId: 'connector-family-fixture',
        network: v.network,
        connectorType: v.connectorType,
        phonePub: v.phone,
        hardwarePub: v.hardware,
        recoveryPub: v.tier === 'advanced' ? v.recovery : undefined,
        phoneDirectP256: v.phoneDirect,
        vaultCosignerBase: v.guardian,
        arkadeCosignerBase: v.emulator,
        absoluteFeeCapSats: policy.absoluteFeeCapSats,
        feerateCapSatPerV: policy.feerateCapSatPerV,
        protectionTier: v.tier,
        spendingPolicy: policy,
      }
      const family = buildConnectorFamily(contract)
      const prepared = prepareConnectorPayment({
        contract,
        origin: { publicKey: hex.decode(v.hardware), fingerprint: v.originFingerprint, path: v.originPath },
        enrollmentDigest: v.enrollmentDigest,
        savings: { txid: p.parentTxid, vout: 0, parentHex: p.parent },
        reserve: { txid: p.parentTxid, vout: 1, parentHex: p.parent },
        recipient: Address().encode(OutScript.decode(hex.decode(p.recipientScript))),
        amountSats: p.amount,
        feeSats: p.fee,
      })
      const phoneKey = new Uint8Array(32)
      phoneKey[31] = 3
      const tx = Transaction.fromPSBT(hex.decode(prepared.signPhone(phoneKey)), options)
      assert.ok(family.savings.normal.length < 253)
      const leafHash = schnorr.utils.taggedHash(
        'TapLeaf',
        Uint8Array.of(0xc0, family.savings.normal.length),
        family.savings.normal,
      )
      const phone = hex.decode(v.phone).slice(1)
      const guardian = hex.decode(family.normalTweaks.vault).slice(1)
      const emulator = hex.decode(family.normalTweaks.arkade).slice(1)
      const earlier = [
        [{ pubKey: phone, leafHash }, tx.getInput(0).tapScriptSig[0][1]],
        [{ pubKey: guardian, leafHash }, hex.decode(p.savingsWitness[1])],
      ]
      tx.updateInput(0, { tapScriptSig: earlier })
      const response = await submit(tx)
      assert.equal(response.status, 200, await response.clone().text())
      const signed = Transaction.fromPSBT(base64.decode((await response.json()).signedTx), options)
      assert.equal(hex.encode(signed.unsignedTx), hex.encode(tx.unsignedTx))
      const signatures = signed.getInput(0).tapScriptSig
      assert.equal(signatures.length, 3)
      for (const [key, sig] of earlier) {
        const returned = signatures.find(([k]) => hex.encode(k.pubKey) === hex.encode(key.pubKey))
        assert.equal(hex.encode(returned[1]), hex.encode(sig))
      }
      const added = signatures.filter(([k]) => hex.encode(k.pubKey) === hex.encode(emulator))
      assert.equal(added.length, 1)
      assert.equal(hex.encode(added[0][0].leafHash), hex.encode(leafHash))
      assert.equal(added[0][1].length, 64)
      assert.equal(signed.getInput(1).tapKeySig, undefined)
      assert.equal(signed.getInput(1).partialSig, undefined)
      const handoff = prepared.forHardware([
        added[0][1],
        hex.decode(p.savingsWitness[1]),
        earlier[0][1],
        family.savings.normal,
        family.savings.control,
      ])
      // The fixture signer response supplies only the independently verified H
      // signature; Vaulted retains the Savings witness just obtained upstream.
      assert.equal(handoff.accept(p.responsePSBT).txid, p.txid)

      const bad = Transaction.fromPSBT(hex.decode(prepared.psbt()), options)
      bad.updateOutput(1, { amount: 999n })
      const rejected = await submit(bad)
      assert.notEqual(rejected.status, 200, 'emulator accepted loss of the enrolled reserve')
    })
  }
}

const { connectorApprovalWitness } = await vite.ssrLoadModule('/src/lib/vault/program/connectorApproval.ts')
const { encodeExtensionScript, encodeEmulatorPacket } = await vite.ssrLoadModule('/src/lib/vault/program/packet.ts')
const { tweakPrivateKey } = await vite.ssrLoadModule('/src/lib/vault/program/tweak.ts')
const fixtureRoot = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x42))
const secret = (n) => {
  const b = new Uint8Array(32)
  b[31] = n
  return b
}
for (const kind of ['p2tr', 'p2wpkh'])
  for (const tier of ['standard', 'advanced'])
    for (const full of [false, true])
      for (const recipientFormat of ['tr', 'wpkh', 'wsh', 'pkh', 'sh']) {
        test(`v2 upstream HTTP ${kind} ${tier} ${full ? 'full' : 'partial'} ${recipientFormat} enforces hardware and policy`, async () => {
          const v = vectors[0],
            policy = defaultSpendingPolicy('mainnet')
          const path = [0x80000000 + (kind === 'p2tr' ? 86 : 84), 0x80000000, 0x80000000, 0, 0]
          const key = fixtureRoot
            .deriveChild(path[0])
            .deriveChild(path[1])
            .deriveChild(path[2])
            .deriveChild(0)
            .deriveChild(0)
          const origin = { publicKey: key.publicKey, fingerprint: fixtureRoot.fingerprint, path }
          const contract = {
            vaultId: 'dual-http-fixture',
            network: 'mainnet',
            templateVersion: DUAL_CONNECTOR_TEMPLATE,
            connectorType: kind,
            phonePub: v.phone,
            hardwarePub: hex.encode(key.publicKey),
            recoveryPub: tier === 'advanced' ? v.recovery : undefined,
            phoneDirectP256: v.phoneDirect,
            vaultCosignerBase: v.guardian,
            arkadeCosignerBase: v.emulator,
            protectionTier: tier,
            spendingPolicy: policy,
            absoluteFeeCapSats: policy.absoluteFeeCapSats,
            feerateCapSatPerV: policy.feerateCapSatPerV,
          }
          const family = buildConnectorFamily(contract)
          const parent = new Transaction(options)
          parent.addInput({ txid: '00'.repeat(32), index: 99 })
          parent.addOutput({ script: family.savings.script, amount: 100000n })
          for (let i = 0; i < 2; i++) parent.addOutput({ script: family.connector.script, amount: 500n })
          const coin = (vout) => ({ parentHex: hex.encode(parent.toBytes(true, true)), txid: parent.id, vout })
          const request = {
            contract,
            origin,
            enrollmentDigest: connectorEnrollmentDigest(contract, origin),
            savings: coin(0),
            reserve: coin(1),
            secondReserve: coin(2),
            recipient: Address().encode(
              OutScript.decode(
                hex.decode(
                  {
                    tr: v.payments[0].recipientScript,
                    wpkh: '0014' + '17'.repeat(20),
                    wsh: '0020' + '18'.repeat(32),
                    pkh: '76a914' + '19'.repeat(20) + '88ac',
                    sh: 'a914' + '20'.repeat(20) + '87',
                  }[recipientFormat],
                ),
              ),
            ),
            amountSats: full ? 98760 : 8000,
            feeSats: 1000,
          }
          const initial = prepareConnectorPayment(request)
          const approval = Transaction.fromPSBT(hex.decode(initial.hardwareApproval()), options)
          for (const i of [0, 1]) approval.signIdx(key.privateKey, i, [3])
          const hardwareSignatures = initial.acceptHardwareApproval(hex.encode(approval.toPSBT()))
          const prepared = prepareConnectorPayment({ ...request, hardwareSignatures })
          const tx = Transaction.fromPSBT(hex.decode(prepared.signPhone(secret(3))), options)
          tx.signIdx(tweakPrivateKey(secret(14), family.program), 2, [0])
          const response = await submit(tx)
          assert.equal(response.status, 200, await response.clone().text())
          const signed = Transaction.fromPSBT(base64.decode((await response.json()).signedTx), options)
          assert.equal(hex.encode(signed.unsignedTx), hex.encode(tx.unsignedTx))
          const pubs = [family.normalTweaks.arkade, family.normalTweaks.vault, contract.phonePub]
          const witness = pubs.map(
            (pub) => signed.getInput(2).tapScriptSig.find(([k]) => hex.encode(k.pubKey) === pub.slice(2))[1],
          )
          witness.push(family.savings.normal, family.savings.control)
          const final = prepared.forHardware(witness).accept(prepared.psbt())
          assert.equal(final.txid, signed.id)
          if (recipientFormat !== 'tr') return
          // Re-sign malicious candidates so policy failures cannot be explained by
          // stale phone/service/hardware signatures. The final two cases deliberately
          // request a downgraded hardware signature or retain an old approval.
          for (const attack of [
            'reserve-value',
            'reserve-script',
            'fee-cap',
            'change-script',
            'layout',
            'packet-shape',
            'none',
            'anyonecanpay',
            'recipient-substitution',
          ]) {
            const wire = RawPSBTV0.decode(hex.decode(initial.psbt()))
            const outputs = wire.global.unsignedTx.outputs
            const reserve = full ? 1 : 2
            if (attack === 'reserve-value') outputs[reserve].amount--
            if (attack === 'reserve-script') outputs[reserve].script[3] ^= 1
            if (attack === 'fee-cap') {
              outputs[0].amount = 294n
              if (!full) outputs[1].amount = 330n
            }
            if (attack === 'change-script') outputs[1].script = hex.decode(v.payments[0].recipientScript)
            if (attack === 'layout') {
              outputs.push({ amount: 0n, script: Uint8Array.of(0x6a) })
              wire.outputs.push({})
            }
            const mode = attack === 'none' ? 2 : attack === 'anyonecanpay' ? 0x83 : 3
            for (const i of [0, 1]) wire.inputs[i].sighashType = mode
            const malicious = Transaction.fromPSBT(RawPSBTV0.encode(wire), options)
            for (const i of [0, 1]) malicious.signIdx(key.privateKey, i, [mode])
            const sigs = [0, 1].map((i) =>
              kind === 'p2tr' ? malicious.getInput(i).tapKeySig : malicious.getInput(i).partialSig[0][1],
            )
            const proof = connectorApprovalWitness(
              family.program,
              sigs,
              malicious.getOutput(0).script,
              kind === 'p2wpkh' ? key.publicKey : undefined,
            )
            const edited = RawPSBTV0.decode(malicious.toPSBT())
            edited.global.unsignedTx.outputs[tx.outputsLength - 1].script = encodeExtensionScript([
              { type: 1, data: encodeEmulatorPacket({ vin: 2, script: family.program, witness: proof }) },
            ])
            if (attack === 'packet-shape')
              edited.global.unsignedTx.outputs[tx.outputsLength - 1].script = new Uint8Array([
                ...edited.global.unsignedTx.outputs[tx.outputsLength - 1].script,
                0,
              ])
            if (attack === 'recipient-substitution')
              edited.global.unsignedTx.outputs[0].script = family.connector.script
            const candidate = Transaction.fromPSBT(RawPSBTV0.encode(edited), options)
            candidate.signIdx(secret(3), 2, [0])
            candidate.signIdx(tweakPrivateKey(secret(14), family.program), 2, [0])
            const rejected = await submit(candidate)
            assert.notEqual(rejected.status, 200, `accepted ${attack}: ${await rejected.text()}`)
          }
        })
      }
