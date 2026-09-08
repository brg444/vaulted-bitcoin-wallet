// Opt-in local Mutinynet fixture: recover an interrupted prototype that predates
// retained cancellation proofs. Never used by the application or a live vault.
import {
  Wallet,
  RestIndexerProvider,
  SingleKey,
  InMemoryWalletRepository,
  InMemoryContractRepository,
} from '@arkade-os/sdk'
import { hex } from '@scure/base'
import type { VaultStatus } from '../../../lib/vault/types'
import { readSavingsSetup, saveSetup } from '../../../lib/vault/savingsSetupStore'
import { vaultPolicyV1ScriptFromStatus, vaultArkServer } from '../../../lib/vault/vtxo/spend'
import { registerVaultPolicyV1ContractHandler, vaultPolicyV1Contract } from '../../../lib/vault/vtxo/contractHandler'
export async function retainPrototypeCancellation(status: VaultStatus, privateKey: string) {
  if (status.network !== 'mutinynet' || location.hostname !== 'localhost')
    throw new Error('Local Mutinynet fixture only')
  const journal = readSavingsSetup(status)
  if (!journal || journal.deleteIntent) return
  const secret = hex.decode(privateKey)
  const url = vaultArkServer(status.network)
  const script = vaultPolicyV1ScriptFromStatus(status)
  registerVaultPolicyV1ContractHandler()
  const wallet = await Wallet.create({
    identity: SingleKey.fromPrivateKey(secret),
    arkServerUrl: url,
    esploraUrl: '/esplora',
    walletMode: 'static',
    settlementConfig: false,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
  })
  try {
    await (await wallet.getContractManager()).createContract(vaultPolicyV1Contract(script, status.spendingArkAddress!))
    const result = await new RestIndexerProvider(url).getVtxos({ scripts: [hex.encode(script.pkScript)] })
    const coin = result.vtxos.find(
      (c) => c.txid === journal.txid && c.vout === journal.vout && c.value === journal.valueSats && !c.isSpent,
    )
    if (!coin) throw new Error('Prototype input is not live')
    const deletion = await wallet.makeDeleteIntentSignature([
      {
        ...coin,
        tapTree: script.encode(),
        forfeitTapLeafScript: script.forfeit(),
        intentTapLeafScript: script.forfeit(),
      },
    ])
    saveSetup({ ...journal, deleteIntent: { proof: deletion.proof, message: JSON.stringify(deletion.message) } })
  } finally {
    await wallet.dispose()
    secret.fill(0)
  }
}
