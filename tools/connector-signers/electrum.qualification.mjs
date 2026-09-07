import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { createServer } from 'vite'
import { Address, OutScript } from '@scure/btc-signer'
import { hex } from '@scure/base'

const python = process.env.CONNECTOR_ELECTRUM_PYTHON
assert.ok(python, 'Set CONNECTOR_ELECTRUM_PYTHON to a Python environment containing unmodified Electrum 4.8.1')
const root = fileURLToPath(new URL('../../', import.meta.url))
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: 'custom' })
after(() => server.close())
const { prepareConnectorPayment } = await server.ssrLoadModule('/src/lib/vault/program/connectorPayment.ts')
const { defaultSpendingPolicy } = await server.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
const vectors = JSON.parse(
  await readFile(new URL('../../src/lib/vault/program/connector-vectors.json', import.meta.url), 'utf8'),
)
for (const v of vectors.filter((v) => v.network === 'mainnet' && v.connectorType === 'p2wpkh')) {
  for (const p of v.payments) {
    test(`Electrum 4.8.1 ${v.originType} ${v.tier} ${p.full ? 'full' : 'partial'} Savings withdrawal`, () => {
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
      const recipient = Address().encode(OutScript.decode(hex.decode(p.recipientScript)))
      const prepared = prepareConnectorPayment({
        contract,
        origin: { publicKey: hex.decode(v.hardware), fingerprint: v.originFingerprint, path: v.originPath },
        enrollmentDigest: v.enrollmentDigest,
        savings: { txid: p.parentTxid, vout: 0, parentHex: p.parent },
        reserve: { txid: p.parentTxid, vout: 1, parentHex: p.parent },
        recipient,
        amountSats: p.amount,
        feeSats: p.fee,
      })
      const request = prepared.forHardware(p.savingsWitness.map(hex.decode))
      const response = JSON.parse(
        execFileSync(python, [fileURLToPath(new URL('./qualify_electrum.py', import.meta.url))], {
          input: JSON.stringify({
            native: v.originType === 'electrum',
            psbt: request.psbt(),
            recipient,
            amount: p.amount,
            fee: p.fee,
            qt: process.env.CONNECTOR_ELECTRUM_QT === '1',
            case: `${v.originType}-${v.tier}-${p.full ? 'full' : 'partial'}`,
          }),
          encoding: 'utf8',
          timeout: 30000,
        }),
      )
      assert.equal(response.outputs[0].address, recipient)
      assert.equal(response.outputs[0].sats, p.amount)
      assert.equal(request.accept(response.tx).txHex, response.tx.trim())
      assert.equal(request.accept(response.psbt).txHex, response.tx.trim())
      if (process.env.CONNECTOR_ELECTRUM_QT === '1') assert.equal(response.review.recipient, recipient)
    })
  }
}
