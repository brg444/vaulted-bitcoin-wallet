import { it } from 'vitest'
import { ArkAddress, RestArkProvider } from '@arkade-os/sdk'
import { InMemoryAssetSwapRepository } from '@arkade-os/swap'
import { nostrRfqTransport } from '@arkade-os/swap/nostr'
import { hex } from '@scure/base'
import { discoverVaultLightningSolver } from '../../src/lib/vault/lightningConfig'
import { requestVaultLightningReceive, receiveProfile } from '../../src/lib/vault/lightningReceive'
import { networkPins } from '../../src/lib/vault/networkPins'
import { memoryContracts } from '../../src/lib/vault/lightningTestUtils'
import type { VaultStatus } from '../../src/lib/vault/types'

it.skipIf(process.env.VAULT_LN_RECEIVE_PROBE !== 'true')(
  'requests one unfunded mainnet invoice without exposing it',
  async () => {
    const pins = networkPins('mainnet'),
      profile = (await discoverVaultLightningSolver('mainnet'))!
    const pub = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    const address = new ArkAddress(hex.decode(pins.operatorSignerPub).slice(1), hex.decode(pub).slice(1), 'ark')
    const status = {
      enrolled: true,
      vaultId: 'ab'.repeat(32),
      network: 'mainnet',
      phoneBip340Pub: pub,
      spendingArkAddress: address.encode(),
      spendingArkScript: hex.encode(address.pkScript),
    } as VaultStatus
    const transport = nostrRfqTransport({ relays: [...profile.relays], solverPubkey: profile.pubkey, timeoutMs: 15000 })
    try {
      const record = await requestVaultLightningReceive({
        status,
        amountSats: 1000,
        profile,
        transport: {
          ...transport,
          requestQuote: async (request) => {
            const q = await transport.requestQuote(request)
            console.log(
              JSON.stringify({
                sameId: q.rfq_id === request.rfq_id,
                pair: q.pair,
                side: q.amount_side,
                from: q.from_amount,
                to: q.to_amount,
                solver: q.solver_pubkey,
              }),
            )
            return q
          },
        },
        repository: new InMemoryAssetSwapRepository(),
        contracts: memoryContracts().contracts,
        operatorInfo: await new RestArkProvider(pins.operatorOrigin).getInfo(),
      })
      const p = receiveProfile(record)
      console.log(
        JSON.stringify({
          verifiedQuote: true,
          solver: profile.pubkey,
          receiveSats: record.amount,
          paySats: p.quote.from_amount,
          expires: p.invoiceExpiresAt,
        }),
      )
    } finally {
      await transport.close()
    }
  },
  30000,
)
