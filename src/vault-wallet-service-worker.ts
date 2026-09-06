import { loadLightWorkerDescriptor, lightObserverIdentity } from './lib/vault/light/workerIdentity'
import { registerLightContractHandler, lightContract } from './lib/vault/light/contractHandler'
import { lightStatusMatchesDescriptor } from './lib/vault/light/status'
import { LightScript } from './lib/vault/light/contract'
import {
  IndexedDBContractRepository,
  IndexedDBIntentRepository,
  IndexedDBWalletRepository,
  MessageBus,
  RestArkProvider,
  SingleKey,
  Wallet,
  WalletMessageHandler,
} from '@arkade-os/sdk'
import { hexToBytes } from './lib/vault/hex'
import { requireSupportedVaultNetwork } from './lib/vault/constants'
import { fetchVaultStatusUnpinned } from './lib/vault/status'
import { registerVaultPolicyV1ContractHandler, vaultPolicyV1Contract } from './lib/vault/vtxo/contractHandler'
import {
  loadActiveBoardingKeyForNamespace,
  boardingWorkerPins,
  requireBoardingStatus,
  BOARDING_PROGRAM,
} from './lib/vault/vtxo/board'
import { createBoardingSigningAdapter } from './lib/vault/vtxo/boardingAdapter'
import { installVaultSettlementEventSource } from './lib/vault/vtxo/settlementEventSource'
import {
  vaultWalletIntentDatabaseForNamespace,
  vaultWalletUpdaterTagForNamespace,
  vaultWalletDatabaseForNamespace,
} from './lib/vault/vtxo/walletWorkerNames'
import { vaultArkServer, vaultPolicyV1ScriptFromStatus } from './lib/vault/vtxo/spend'

declare const self: ServiceWorkerGlobalScope

const workerLocation = new URL(self.location.href)
const namespace = workerLocation.searchParams.get('vault') || ''
const pinnedNetwork = workerLocation.searchParams.get('network') || ''

installVaultSettlementEventSource()
registerVaultPolicyV1ContractHandler()

const walletRepository = new IndexedDBWalletRepository(vaultWalletDatabaseForNamespace(namespace))
const contractRepository = new IndexedDBContractRepository(vaultWalletDatabaseForNamespace(namespace))
const intentRepository = new IndexedDBIntentRepository(vaultWalletIntentDatabaseForNamespace(namespace))

const bus = new MessageBus(walletRepository, contractRepository, {
  messageHandlers: [new WalletMessageHandler({ messageTag: vaultWalletUpdaterTagForNamespace(namespace) })],
  tickIntervalMs: 5_000,
  messageTimeoutMs: 60_000,
  messageTimeoutOverrides: { SETTLE: 15 * 60_000 },
  buildServices: async (config) => {
    const lightDescriptor = await loadLightWorkerDescriptor(namespace)
    if (lightDescriptor) {
      const status = lightStatusMatchesDescriptor(
        await fetchVaultStatusUnpinned(undefined, lightDescriptor.vaultId),
        lightDescriptor,
      )
      if (pinnedNetwork !== status.network || config.arkServer.url !== vaultArkServer(status.network))
        throw new Error('Light worker network mismatch')
      const operator = String(config.arkServer.publicKey || '').toLowerCase()
      if (operator && operator !== lightDescriptor.operatorPub && operator.slice(2) !== lightDescriptor.operatorPub)
        throw new Error('Light worker Operator mismatch')
      registerLightContractHandler()
      const wallet = await Wallet.create({
        identity: lightObserverIdentity(lightDescriptor),
        arkServerUrl: config.arkServer.url,
        arkServerPublicKey: config.arkServer.publicKey,
        indexerUrl: config.indexerUrl,
        esploraUrl: config.esploraUrl,
        storage: { walletRepository, contractRepository, intentRepository },
        walletMode: 'static',
        settlementConfig: { boardingUtxoSweep: false, deprecatedSignerMigration: false, autoRenewVtxos: false },
      })
      const manager = await wallet.getContractManager()
      for (const contract of (await manager.getContracts()).filter((c) => c.type === 'default')) {
        if (contract.state !== 'inactive') await manager.setContractState(contract.script, 'inactive')
        if ((contract.watch || 'watched') !== 'retained')
          await manager.setContractWatchState(contract.script, 'retained')
      }
      const spending = await manager.createContract(
        lightContract(new LightScript(lightDescriptor), String(status.spendingArkAddress)),
      )
      if (spending.script !== lightDescriptor.scriptPubKey) throw new Error('Light worker Spending contract mismatch')
      if (spending.state !== 'active') await manager.setContractState(spending.script, 'active')
      if ((spending.watch || 'watched') !== 'watched') await manager.setContractWatchState(spending.script, 'watched')
      return { arkProvider: new RestArkProvider(config.arkServer.url), wallet, readonlyWallet: wallet }
    }
    const active = await loadActiveBoardingKeyForNamespace(namespace)
    const transient = active.secret.slice()
    active.secret.fill(0)
    let identityOwnsSecret = false
    try {
      const status = await fetchVaultStatusUnpinned(undefined, active.vaultId)
      if (pinnedNetwork && status.network !== requireSupportedVaultNetwork(pinnedNetwork)) {
        throw new Error('worker network does not match this release')
      }
      const descriptor = requireBoardingStatus(status, active.boardingPub)
      const pins = boardingWorkerPins(active.network, status.network)
      if (active.descriptorHash !== status.vtxoBoardingDescriptorHash) {
        throw new Error('active vault-board-v1 key is bound to a different descriptor')
      }
      const expectedArkServer = vaultArkServer(pins.network)
      if (config.arkServer.url !== expectedArkServer) {
        throw new Error('worker Arkade Operator origin does not match this release')
      }
      const configuredOperator = String(config.arkServer.publicKey || '').toLowerCase()
      if (
        configuredOperator &&
        configuredOperator !== descriptor.operatorPub &&
        configuredOperator !== descriptor.operatorPub.slice(2)
      ) {
        throw new Error('worker Arkade Operator key does not match this release')
      }
      const identity = SingleKey.fromPrivateKey(transient)
      const signingAdapter = createBoardingSigningAdapter(status.vaultId, descriptor)
      const wallet = await Wallet.create({
        identity,
        arkServerUrl: config.arkServer.url,
        arkServerPublicKey: config.arkServer.publicKey,
        indexerUrl: config.indexerUrl,
        esploraUrl: config.esploraUrl,
        storage: { walletRepository, contractRepository, intentRepository },
        walletMode: 'static',
        boardingProgram: {
          name: BOARDING_PROGRAM,
          boardingPubKey: await identity.xOnlyPublicKey(),
          cosignerPubKey: signingAdapter.publicKey,
          recoveryPubKey: hexToBytes(descriptor.recoveryPhonePub).slice(1),
        },
        boardingSigningAdapter: signingAdapter,
        boardingTimelock: { type: 'seconds', value: BigInt(pins.boardExitDelay) },
        settlementConfig: {
          boardingUtxoSweep: false,
          deprecatedSignerMigration: false,
          autoRenewVtxos: false,
          maxBoardingInputsPerSettle: 1,
          boardingSettleAddress: String(status.spendingArkAddress || ''),
        },
      })
      if ((await wallet.getBoardingAddress()) !== descriptor.address) {
        throw new Error('SDK worker derived a different vault-board-v1 address')
      }
      const manager = await wallet.getContractManager()
      for (const contract of (await manager.getContracts()).filter((candidate) => candidate.type === 'default')) {
        if (contract.state !== 'inactive') await manager.setContractState(contract.script, 'inactive')
        if ((contract.watch || 'watched') !== 'retained') {
          await manager.setContractWatchState(contract.script, 'retained')
        }
      }
      const spending = await manager.createContract(
        vaultPolicyV1Contract(vaultPolicyV1ScriptFromStatus(status), String(status.spendingArkAddress || '')),
      )
      if (spending.script !== String(status.spendingArkScript || '').toLowerCase()) {
        throw new Error('SDK worker registered a different Spending contract')
      }
      if (spending.state !== 'active') await manager.setContractState(spending.script, 'active')
      if ((spending.watch || 'watched') !== 'watched') {
        await manager.setContractWatchState(spending.script, 'watched')
      }
      identityOwnsSecret = true
      return { arkProvider: new RestArkProvider(config.arkServer.url), wallet, readonlyWallet: wallet }
    } finally {
      if (!identityOwnsSecret) transient.fill(0)
    }
  },
})

bus.start().catch((error) => console.error('Vault wallet worker failed to start', error))
