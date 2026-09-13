import {
  assertSubmittedArkTxid,
  matchServerCheckpoints,
  ServerResponseMismatchError,
  Transaction,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { requireExactDefaultTapscriptSignatures } from '../taprootSignatures'
import {
  LIGHTNING_REFUND_INPUT_VALUES,
  LIGHTNING_REFUND_QUOTE_SATS,
  lightningRefundPackageFixture,
} from './lightningRefundFixture'

function tx(psbt: string): Transaction {
  return Transaction.fromPSBT(base64.decode(psbt))
}

function outpoint(input: { txid?: Uint8Array; index?: number }): { txid: string; vout: number } {
  if (!input.txid || !Number.isSafeInteger(input.index)) throw new Error('refund fixture input is incomplete')
  return { txid: hex.encode(input.txid), vout: input.index as number }
}

describe('Lightning refund package fixture', () => {
  it('refunds two original lockup inputs through checkpoints with real signatures', async () => {
    const fixture = await lightningRefundPackageFixture()
    const refund = tx(fixture.signedRefundPsbt)
    const serverRefund = tx(fixture.serverRefundPsbt)
    const submitted = fixture.submittedCheckpointPsbts.map(tx)
    const server = fixture.serverCheckpointPsbts.map(tx)
    const finals = fixture.finalCheckpointPsbts.map(tx)
    const fundedSum = LIGHTNING_REFUND_INPUT_VALUES.reduce((sum, value) => sum + value, 0)

    expect(fixture.swap.lockup?.script).toBeDefined()
    expect(fixture.originalLockupInputs).toHaveLength(2)
    expect(fixture.originalLockupInputs.map((input) => input.value)).toEqual([...LIGHTNING_REFUND_INPUT_VALUES])
    expect(fixture.quotedAmountSats).toBe(LIGHTNING_REFUND_QUOTE_SATS)
    expect(fixture.resultAmount).toBe(fundedSum)
    expect(fixture.resultAmount).toBeGreaterThan(fixture.quotedAmountSats)
    expect(fixture.refundId).toBe(refund.id)
    expect(refund.inputsLength).toBe(2)
    expect(refund.outputsLength).toBe(2)
    expect(refund.getOutput(1)).toMatchObject({ amount: 0n, script: hex.decode('51024e73') })
    expect(submitted).toHaveLength(2)
    expect(server).toHaveLength(2)
    expect(finals).toHaveLength(2)
    expect(Number(refund.getOutput(0)!.amount)).toBe(fundedSum)
    expect(hex.encode(refund.getOutput(0)!.script!)).toBe(fixture.destinationPkScriptHex)

    fixture.originalLockupInputs.forEach((lockup, index) => {
      const checkpoint = submitted[index]
      expect(checkpoint.inputsLength).toBe(1)
      expect(checkpoint.outputsLength).toBe(2)
      expect(checkpoint.getOutput(1)).toMatchObject({ amount: 0n, script: hex.decode('51024e73') })
      const checkpointIn = outpoint(checkpoint.getInput(0))
      expect(checkpointIn).toEqual({ txid: lockup.txid, vout: lockup.vout })
      expect(Number(checkpoint.getInput(0).witnessUtxo?.amount)).toBe(lockup.value)
      expect(Number(checkpoint.getOutput(0)!.amount)).toBe(lockup.value)
      const refundIn = outpoint(refund.getInput(index))
      expect(refundIn).toEqual({ txid: checkpoint.id, vout: 0 })
      expect(Number(refund.getInput(index).witnessUtxo?.amount)).toBe(lockup.value)
      expect(refund.getInput(index).witnessUtxo?.script).toEqual(checkpoint.getOutput(0).script)
      expect(server[index].id).toBe(checkpoint.id)
      expect(finals[index].id).toBe(checkpoint.id)
      requireExactDefaultTapscriptSignatures(refund, index, [fixture.senderPub])
      requireExactDefaultTapscriptSignatures(serverRefund, index, [fixture.senderPub, fixture.serverPub])
      requireExactDefaultTapscriptSignatures(server[index], 0, [fixture.serverPub])
      requireExactDefaultTapscriptSignatures(finals[index], 0, [fixture.senderPub, fixture.serverPub])
    })

    assertSubmittedArkTxid(
      { arkTxid: fixture.refundId, finalArkTx: fixture.serverRefundPsbt },
      refund,
      'lightningRefundFixture',
    )
    expect(matchServerCheckpoints(fixture.serverCheckpointPsbts, submitted, 'lightningRefundFixture')).toHaveLength(2)
    expect(fixture.submissions).toHaveLength(1)
    expect(fixture.finalizations).toEqual([
      { arkTxid: fixture.refundId, checkpointPsbts: fixture.finalCheckpointPsbts },
    ])
    await fixture.repository[Symbol.asyncDispose]()
  })

  it('rejects a substituted or missing checkpoint through matchServerCheckpoints', async () => {
    const fixture = await lightningRefundPackageFixture()
    const submitted = fixture.submittedCheckpointPsbts.map(tx)
    const decoy = new Transaction({ version: 3 })
    decoy.addInput({ txid: 'ff'.repeat(32), index: 0 })
    decoy.addOutput({ amount: 1n, script: hex.decode('51') })
    const substituted = [fixture.serverCheckpointPsbts[0], base64.encode(decoy.toPSBT())]
    expect(() => matchServerCheckpoints(substituted, submitted, 'lightningRefundFixture')).toThrow(
      ServerResponseMismatchError,
    )
    expect(() =>
      matchServerCheckpoints(fixture.serverCheckpointPsbts.slice(0, 1), submitted, 'lightningRefundFixture'),
    ).toThrow(ServerResponseMismatchError)
    await fixture.repository[Symbol.asyncDispose]()
  })
})
