import {
  IndexedDBWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  type ExtendedVirtualCoin,
  type VirtualTxRepository,
} from '@arkade-os/sdk'
import { networkPins } from '../networkPins'
import { captureExitArchiveForCoins, validateExitArchive } from './exitArchive'
import { readRecoveryTransition, recoveryTransitionKey, type RecoveryTransition } from './lifecycleStore'
import { recoveryFileStore } from './fileStore'
import { requireSpendingRecoveryCoverage } from './coverage'

const point = (v: { txid: string; vout: number }) => `${v.txid}:${v.vout}`

async function boundedCapture<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Recovery capture is still pending')), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** ContractManager remains the only balance writer. Its repository update retains
 * recoverable evidence before publication, independently of the foreground UI. */
export class RecoveryWalletRepository extends IndexedDBWalletRepository {
  private recovery?: { network: string; repository: VirtualTxRepository; operatorOrigin: string }
  private scripts = new Set<string>()
  private repairing = false
  constructor(private readonly database: string) {
    super(database)
  }

  configureRecovery(
    network: string,
    repository: VirtualTxRepository,
    operatorOrigin = networkPins(network).operatorOrigin,
  ) {
    networkPins(network)
    this.recovery = { network, repository, operatorOrigin }
  }

  watchRecoveryScripts(scripts: string[]) {
    for (const script of scripts) this.scripts.add(script)
  }

  override async saveVtxos(address: string, updates: ExtendedVirtualCoin[]) {
    if (!updates.length) return
    const config = this.recovery
    if (!config) throw new Error('Recovery persistence is not initialized')
    if (!navigator.locks) throw new Error('Web Locks required for recovery persistence')
    this.watchRecoveryScripts(updates.map((coin) => coin.script))
    // Covers SDK saveVtxosForScript too, which dispatches through this method.
    return navigator.locks.request(`vaulted:recovery-write:${this.database}`, async () => {
      const scripts = [...new Set(updates.map((v) => v.script))]
      const staged: { key: string; value: RecoveryTransition }[] = []
      const indexer = new RestIndexerProvider(config.operatorOrigin)
      for (const script of scripts) {
        const previous = await readRecoveryTransition(this.database, script)
        const current = await super.getVtxosForScript(script)
        const byPoint = new Map(current.map((v) => [point(v), v]))
        for (const coin of updates.filter((v) => v.script === script)) byPoint.set(point(coin), coin)
        const coins = [...byPoint.values()].filter((v) => !v.isSpent && !v.spentBy)
        const key = recoveryTransitionKey(this.database, script)
        const binding = { descriptorHash: key, scriptPubKey: script, network: config.network }
        const value: RecoveryTransition = {
          version: 1,
          pending: true,
          updatedAt: new Date().toISOString(),
          archive: previous?.archive ?? null,
          retained: previous?.prepared ?? previous?.retained,
          outputs: coins.map(({ txid, vout, value, script }) => ({ txid, vout, value, script })),
        }
        // Failure here prevents publication. A remote receipt still exists and
        // ContractManager will reconcile it; no network transaction is retried here.
        await recoveryFileStore(key, value)
        try {
          const prior = previous?.prepared ?? previous?.retained ?? previous?.archive ?? null
          value.prepared = await boundedCapture(async () => {
            const info = prior
              ? validateExitArchive(prior, binding).info
              : await new RestArkProvider(config.operatorOrigin).getInfo()
            return captureExitArchiveForCoins(binding, config.repository, prior, coins, info, indexer)
          })
          await recoveryFileStore(key, value)
        } catch {
          // A committed receipt/payment is still a financial fact when ancestry
          // cannot be obtained. Keep an explicit pending marker across restarts.
          value.error = 'Recovery paths are still syncing. Previous paths are retained.'
        }
        staged.push({ key, value })
      }
      await super.saveVtxos(address, updates)
      for (const { key, value } of staged) {
        try {
          await recoveryFileStore(
            key,
            value.prepared
              ? {
                  ...value,
                  pending: false,
                  archive: value.prepared,
                  prepared: undefined,
                  retained: undefined,
                  error: undefined,
                }
              : value,
          )
        } catch {
          // The prepublication marker and any prepared graph remain durable.
          // Never turn a completed balance update into a retryable payment.
        }
      }
    })
  }

  /** Retry only evidence capture and publication; never submit or replay a payment. */
  async repairRecovery() {
    if (this.repairing || !this.recovery || !navigator.locks) return
    const config = this.recovery
    this.repairing = true
    try {
      await navigator.locks.request(`vaulted:recovery-write:${this.database}`, async () => {
        for (const script of this.scripts) {
          const previous = await readRecoveryTransition(this.database, script)
          if (!previous?.pending) continue
          try {
            const coins = (await super.getVtxosForScript(script)).filter((v) => !v.isSpent && !v.spentBy)
            const key = recoveryTransitionKey(this.database, script)
            const binding = { descriptorHash: key, scriptPubKey: script, network: config.network }
            const prior = previous.prepared ?? previous.retained ?? previous.archive
            const archive = await boundedCapture(async () => {
              const info = prior
                ? validateExitArchive(prior, binding).info
                : await new RestArkProvider(config.operatorOrigin).getInfo()
              return captureExitArchiveForCoins(
                binding,
                config.repository,
                prior,
                coins,
                info,
                new RestIndexerProvider(config.operatorOrigin),
              )
            })
            // A failed balance commit must be reconciled by ContractManager.
            // Repair never republishes a possibly stale financial snapshot.
            requireSpendingRecoveryCoverage(archive, binding, previous.outputs)
            await recoveryFileStore(key, {
              ...previous,
              pending: false,
              archive,
              prepared: undefined,
              retained: undefined,
              error: undefined,
            })
          } catch {
            // Leave this transition pending while allowing other scripts to repair.
          }
        }
      })
    } finally {
      this.repairing = false
    }
  }
}
