import { IndexedDBVirtualTxRepository } from '@arkade-os/sdk'

/** A spent branch can still be needed to assemble a successor after a crash.
 * Keep it until explicit wallet-data removal; SDK observation is insufficient
 * authority to delete independently retained recovery evidence. */
export class RetainedExitRepository extends IndexedDBVirtualTxRepository {
  override async pruneForSpentVtxo(outpoint: { txid: string; vout: number }) {
    void outpoint
  }
}
