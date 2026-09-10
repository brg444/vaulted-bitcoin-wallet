import { defaultSpendingPolicy } from '../lib/vault/spendingPolicy'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import vectors from '../lib/vault/program/ledger-key-vectors.json'
import { ledgerBip32Versions, type LedgerSavingsKeyContext } from '../lib/vault/program/ledgerNativeKeys'
import { buildLedgerNativeFamily } from '../lib/vault/program/ledgerNativeFamily'
import type { LedgerSavingsPayment } from '../lib/vault/ledgerSavings'
const opts = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true } as const
export function ledgerPaymentFixture(vector = vectors[0]) {
  const context = structuredClone(vector.input) as LedgerSavingsKeyContext
  const contract = { context, spendingPolicy: defaultSpendingPolicy(context.network) }
  const family = buildLedgerNativeFamily(context, contract.spendingPolicy)
  const hd = (seed: number) =>
    HDKey.fromMasterSeed(new Uint8Array(32).fill(seed), ledgerBip32Versions(context.network)).derive(
      `m/86'/${context.network === 'mainnet' ? 0 : 1}'/0'`,
    )
  const phone = hd(0x43)
  const hardware = hd(0x42)
  const parent = new Transaction(opts)
  parent.addInput({ txid: '00'.repeat(32), index: 99 })
  parent.addOutput({ script: family.receive.script, amount: 100000n })
  const payment: LedgerSavingsPayment = {
    contract,
    coins: [
      {
        txid: parent.id,
        vout: 0,
        value: 100000,
        branch: 0,
        index: 0,
        parentTxHex: hex.encode(parent.toBytes(true, true)),
      },
    ],
    destAddress: family.receive.address,
    amountSats: 20000,
    feeSats: 1000,
  }
  const signHardware = (unsigned: string, branches: number[] = [0]) => {
    const tx = Transaction.fromPSBT(hex.decode(unsigned), opts)
    branches.forEach((branch, index) => tx.signIdx(hardware.deriveChild(branch).deriveChild(0).privateKey!, index))
    return hex.encode(tx.toPSBT())
  }
  return { payment, family, phone, hardware, signHardware }
}
