// Explicit Mutinynet-only funded contract/recovery drill; never runs in unit tests.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ArkAddress,
  getNetwork,
  RestIndexerProvider,
  Wallet,
  SingleKey,
  InMemoryWalletRepository,
  InMemoryContractRepository,
} from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { p256 } from '@noble/curves/nist.js'
import { p2tr } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { buildLightDescriptor, defaultLightPolicy, LightScript } from '../../src/lib/vault/light/contract'
import { wrapLightOwnerKey } from '../../src/lib/vault/light/keyBackup'
import { type LightEnrollment } from '../../src/lib/vault/light/enrollment'
import {
  prepareLightRecoveryWithSecret,
  executeLightRecovery,
  validateLightRecoveryFile,
} from '../../src/lib/vault/light/recovery'
import { networkPins } from '../../src/lib/vault/networkPins'

const directory = process.env.VAULT_LIGHT_DRILL_DIRECTORY
if (!directory || !directory.startsWith('/'))
  throw new Error('Set an absolute VAULT_LIGHT_DRILL_DIRECTORY for private test state')
const action = process.argv[2]
if (!['prepare', 'fund-fees', 'offboard-fees', 'execute', 'status'].includes(action))
  throw new Error('Choose prepare, fund-fees, execute or status')
mkdirSync(directory, { recursive: true, mode: 0o700 })
chmodSync(directory, 0o700)
const privatePath = resolve(directory, 'mutinynet-keys.json')
const recoveryPath = resolve(directory, 'mutinynet-recovery.json')
const eventPath = resolve(directory, 'events.json')
const pins = networkPins('mutinynet')
const fetchNetwork = globalThis.fetch.bind(globalThis)
let executionOnly = false
const requests: string[] = []
globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = raw.startsWith('/esplora/') ? `https://mutinynet.com/api/${raw.slice('/esplora/'.length)}` : raw
  if (executionOnly && !url.startsWith('https://mutinynet.com/api/'))
    throw new Error('Recovery attempted a non-Bitcoin provider request')
  requests.push(`${init?.method || 'GET'} ${url}`)
  return fetchNetwork(url, init)
}
function save(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
}
interface State {
  record: LightEnrollment
  secret: string
  destination: string
  fundingRequested?: boolean
}
let state: State
if (existsSync(privatePath)) {
  state = JSON.parse(readFileSync(privatePath, 'utf8'))
} else {
  if (action !== 'prepare') throw new Error('Prepare this drill first')
  const owner = schnorr.utils.randomSecretKey()
  const cosigner = schnorr.utils.randomSecretKey()
  const secret = crypto.getRandomValues(new Uint8Array(32))
  const prf = crypto.getRandomValues(new Uint8Array(32))
  const pass = p256.utils.randomSecretKey()
  const direct = p256.utils.randomSecretKey()
  const destinationKey = schnorr.utils.randomSecretKey()
  const descriptor = buildLightDescriptor({
    vaultId: hex.encode(crypto.getRandomValues(new Uint8Array(32))),
    network: 'mutinynet',
    ownerPub: hex.encode(schnorr.getPublicKey(owner)),
    cosignerPub: hex.encode(schnorr.getPublicKey(cosigner)),
    operatorPub: pins.operatorSignerPub.slice(2),
    exitDelaySeconds: pins.policyExitDelay,
    spendingPolicy: defaultLightPolicy('mutinynet'),
  })
  const lightKeyBackup = await wrapLightOwnerKey(owner, prf, 'passkey-prf', descriptor)
  state = {
    record: {
      descriptor,
      recoveryBackup: await wrapLightOwnerKey(owner, secret, 'recovery-secret', descriptor),
      enrollment: {
        vaultId: descriptor.vaultId,
        credId: hex.encode(crypto.getRandomValues(new Uint8Array(32))),
        webauthnP256: hex.encode(p256.getPublicKey(pass, true)),
        phoneDirectP256: hex.encode(p256.getPublicKey(direct, true)),
        phoneBip340Pub: `02${descriptor.ownerPub}`,
        nonce: lightKeyBackup.nonce,
        ciphertext: lightKeyBackup.ciphertext,
        lightKeyBackup,
      },
    },
    secret: hex.encode(secret),
    destination: p2tr(schnorr.getPublicKey(destinationKey), undefined, getNetwork('mutinynet')).address!,
  }
  // Persist before faucet dispatch; this material is test-only and never logged.
  save(privatePath, {
    ...state,
    owner: hex.encode(owner),
    cosigner: hex.encode(cosigner),
    prf: hex.encode(prf),
    pass: hex.encode(pass),
    direct: hex.encode(direct),
    destinationKey: hex.encode(destinationKey),
  })
  for (const key of [owner, cosigner, secret, prf, pass, direct, destinationKey]) key.fill(0)
}
if (state.record.descriptor.network !== 'mutinynet') throw new Error('This drill refuses non-Mutinynet state')
const script = new LightScript(state.record.descriptor)
const address = new ArkAddress(
  hex.decode(state.record.descriptor.operatorPub),
  script.tweakedPublicKey,
  pins.arkHrp,
).encode()
const indexer = new RestIndexerProvider(pins.operatorOrigin)
if (action === 'prepare') {
  if (!state.fundingRequested) {
    const original = JSON.parse(readFileSync(privatePath, 'utf8'))
    save(privatePath, { ...original, fundingRequested: true })
    const res = await fetch('https://faucet.mutinynet.arkade.sh/faucet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, amount: 50000 }),
    })
    if (!res.ok) throw new Error(`Faucet returned ${res.status}; inspect before repeating funding`)
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await indexer.getVtxos({ scripts: [state.record.descriptor.scriptPubKey] })
    if (result.vtxos.some((coin) => !coin.isSpent)) break
    if (attempt === 19) throw new Error('Funded output not indexed yet; run prepare again')
    await new Promise((done) => setTimeout(done, 3000))
  }
  const file = await prepareLightRecoveryWithSecret(state.record, state.secret, state.destination)
  if (!file.exitPackage) throw new Error('Funded recovery package is empty')
  save(recoveryPath, file)
  console.log(
    JSON.stringify({
      prepared: true,
      address,
      destination: state.destination,
      feeFundingAddress: file.feeFundingAddress,
      totals: file.exitPackage.totals,
      outputs: file.exitPackage.vtxos.map((coin) => coin.outpoint),
      steps: file.exitPackage.steps.map((step) => step.kind),
    }),
  )
} else if (action === 'fund-fees') {
  const file = validateLightRecoveryFile(JSON.parse(readFileSync(recoveryPath, 'utf8')))
  const original = JSON.parse(readFileSync(privatePath, 'utf8'))
  if (original.feesRequested) throw new Error('Fee funding was already requested; inspect its confirmation')
  save(privatePath, { ...original, feesRequested: true })
  const res = await fetch('https://faucet.mutinynet.arkade.sh/faucet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: file.feeFundingAddress, amount: 10000 }),
  })
  if (!res.ok) throw new Error(`Fee faucet returned ${res.status}; inspect before repeating funding`)
  console.log(JSON.stringify({ feeFundingRequested: true, address: file.feeFundingAddress }))
} else if (action === 'offboard-fees') {
  // Separate disposable faucet wallet funds Bitcoin fees; Light outputs never enter it.
  const file = validateLightRecoveryFile(JSON.parse(readFileSync(recoveryPath, 'utf8')))
  const path = resolve(directory, 'fee-wallet.json')
  let feeState = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { key: hex.encode(schnorr.utils.randomSecretKey()) }
  save(path, feeState)
  const key = hex.decode(feeState.key)
  const wallet = await Wallet.create({
    identity: SingleKey.fromPrivateKey(key),
    arkServerUrl: pins.operatorOrigin,
    esploraUrl: '/esplora',
    walletMode: 'static',
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: { boardingUtxoSweep: false, deprecatedSignerMigration: false, autoRenewVtxos: false },
  })
  try {
    if (feeState.commitmentTxid) {
      console.log(JSON.stringify({ commitmentTxid: feeState.commitmentTxid }))
    } else {
      if (!feeState.fundingRequested) {
        feeState = { ...feeState, fundingRequested: true }
        save(path, feeState)
        const response = await fetch('https://faucet.mutinynet.arkade.sh/faucet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: await wallet.getAddress(), amount: 10000 }),
        })
        if (!response.ok) throw new Error(`Fee wallet faucet returned ${response.status}`)
      }
      const manager = await wallet.getContractManager()
      await manager.refreshVtxos()
      const coins = await wallet.getVtxos()
      if (!coins.length) throw new Error('Fee wallet not indexed; inspect and retry')
      if (feeState.submitting) throw new Error('Prior fee settlement outcome is uncertain; inspect before retry')
      feeState = { ...feeState, submitting: true }
      save(path, feeState)
      const commitmentTxid = await wallet.settle({
        inputs: coins,
        outputs: [
          { address: file.feeFundingAddress!, amount: BigInt(coins.reduce((sum, coin) => sum + coin.value, 0)) },
        ],
      })
      save(path, { ...feeState, commitmentTxid })
      console.log(JSON.stringify({ commitmentTxid, feeFundingAddress: file.feeFundingAddress }))
    }
  } finally {
    await wallet.dispose()
    key.fill(0)
  }
} else if (action === 'execute') {
  const file = validateLightRecoveryFile(JSON.parse(readFileSync(recoveryPath, 'utf8')))
  executionOnly = true
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  const events: unknown[] = []
  try {
    await executeLightRecovery(file, state.secret, controller.signal, (event) => {
      events.push(event)
      save(eventPath, { events, requests })
      console.log(JSON.stringify(event))
    })
    save(eventPath, { complete: true, events, requests })
  } finally {
    executionOnly = false
  }
} else {
  const result = await indexer.getVtxos({ scripts: [state.record.descriptor.scriptPubKey] })
  console.log(
    JSON.stringify({
      address,
      outputs: result.vtxos.map(({ txid, vout, value, isSpent, batchExpiry }) => ({
        txid,
        vout,
        value,
        isSpent,
        batchExpiry,
      })),
    }),
  )
}
