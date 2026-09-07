import { Transaction, ChainTxType } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { describe, expect, it, vi } from 'vitest'
import fixture from './testdata/funded-renewal-prevouts.json'
import { prepareExitArchivePrevouts, hydrateArchivedPrevouts } from './archivePrevouts'
import type { ExitArchive } from './exitArchive'

describe('funded renewal archive Bitcoin prevout hydration', () => {
  it.each(fixture.cases)(
    'prepares $tier with one exact Bitcoin commitment lookup and then works offline',
    async ({ archive: raw, binding }) => {
      const archive = raw as unknown as ExitArchive
      const original = JSON.stringify(archive)
      const commitment = Transaction.fromRaw(hex.decode(fixture.commitmentRaw))
      const read = vi.fn(async (id: string) => {
        expect(id).toBe(commitment.id)
        return fixture.commitmentRaw
      })
      const prepared = await prepareExitArchivePrevouts(archive, binding, read)
      expect(read).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(archive)).toBe(original)
      expect(Object.keys(prepared.transactions)).toHaveLength(5)
      for (const branch of Object.values(prepared.branches)) {
        for (const node of branch) {
          if (node.type === ChainTxType.COMMITMENT) continue
          const tx = Transaction.fromPSBT(base64.decode(prepared.transactions[node.txid]))
          const old = Transaction.fromPSBT(base64.decode(archive.transactions[node.txid]))
          expect(tx.id).toBe(old.id)
          expect(tx.getInput(0).tapKeySig).toEqual(old.getInput(0).tapKeySig)
          expect(tx.getInput(0).tapScriptSig).toEqual(old.getInput(0).tapScriptSig)
          if (node.type === ChainTxType.TREE) {
            tx.updateInput(0, { finalScriptWitness: [tx.getInput(0).tapKeySig!] })
          } else tx.finalize()
          expect(Transaction.fromRaw(tx.extract()).id).toBe(node.txid)
        }
      }
      const offline = vi.fn(async () => {
        throw new Error('No further Bitcoin lookup')
      })
      expect(await prepareExitArchivePrevouts(prepared, binding, offline)).toEqual(prepared)
      expect(offline).not.toHaveBeenCalled()
    },
  )

  it('rejects a substituted Bitcoin transaction and conflicting archived metadata', async () => {
    const { archive: raw, binding } = fixture.cases[0]
    const archive = raw as unknown as ExitArchive
    const wrong = Transaction.fromRaw(hex.decode(fixture.commitmentRaw))
    wrong.updateOutput(0, { amount: 1n }, true)
    await expect(
      prepareExitArchivePrevouts(archive, binding, async () => hex.encode(wrong.toBytes(true, true))),
    ).rejects.toThrow('Bitcoin commitment transaction changed')
    const prepared = await prepareExitArchivePrevouts(archive, binding, async () => fixture.commitmentRaw)
    const id = Object.keys(archive.transactions)[0]
    const tx = Transaction.fromPSBT(base64.decode(prepared.transactions[id]))
    const previous = tx.getInput(0).witnessUtxo!
    tx.updateInput(0, { witnessUtxo: { ...previous, amount: previous.amount + 1n } }, true)
    expect(() => hydrateArchivedPrevouts(tx, prepared.transactions)).toThrow('metadata changed')
  })
})
