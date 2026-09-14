import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listRetiredLightningReceiveReceipts,
  readRetiredLightningReceive,
  writeRetiredLightningReceive,
  type VaultLightningRetiredReceive,
} from './lightningEvidence'

const RFQ = 'ab'.repeat(32)
const CLAIM = 'cd'.repeat(32)
const LOCKUP_SCRIPT = '5120' + 'ef'.repeat(32)
const PAYOUT_SCRIPT = '5120' + '12'.repeat(32)
const KEY = `vaulted-lightning-retired-receive:${RFQ}`

function receipt(overrides: Partial<VaultLightningRetiredReceive> = {}): VaultLightningRetiredReceive {
  return {
    rfqId: RFQ,
    claimArkTxid: CLAIM,
    lockupAddress: 'tark1lockup',
    lockupPkScriptHex: LOCKUP_SCRIPT,
    amountSats: 1000,
    displayAmount: 1000,
    fee: 4,
    payoutAddress: 'tark1payout',
    payoutPkScriptHex: PAYOUT_SCRIPT,
    state: 'settled',
    createdAt: 100,
    network: 'mutinynet',
    vaultId: 'vault-1',
    descriptorHash: 'ff'.repeat(32),
    fileDigest: '00'.repeat(32),
    retiredAt: 200,
    ...overrides,
  }
}

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('Lightning receive retirement receipt', () => {
  it('writes, reads back, and enumerates only for its own vault and network', () => {
    writeRetiredLightningReceive(receipt())
    expect(readRetiredLightningReceive(RFQ)).toEqual(receipt())
    expect(listRetiredLightningReceiveReceipts({ vaultId: 'vault-1', network: 'mutinynet' })).toEqual([receipt()])
    expect(listRetiredLightningReceiveReceipts({ vaultId: 'other-vault', network: 'mutinynet' })).toEqual([])
    expect(listRetiredLightningReceiveReceipts({ vaultId: 'vault-1', network: 'mainnet' })).toEqual([])
  })

  it('rejects a stored receipt whose embedded rfqId differs from the requested key', () => {
    writeRetiredLightningReceive(receipt())
    localStorage.setItem(KEY, JSON.stringify({ ...receipt(), rfqId: '99'.repeat(32) }))
    expect(readRetiredLightningReceive(RFQ)).toBeNull()
    expect(listRetiredLightningReceiveReceipts({ vaultId: 'vault-1', network: 'mutinynet' })).toEqual([])
  })

  it('ignores a receipt stored under a key that is not its derived key', () => {
    const other = '77'.repeat(32)
    localStorage.setItem(`vaulted-lightning-retired-receive:${other}`, JSON.stringify(receipt({ rfqId: other })))
    expect(listRetiredLightningReceiveReceipts({ vaultId: 'vault-1', network: 'mutinynet' })).toEqual([
      receipt({ rfqId: other }),
    ])
    localStorage.setItem(`vaulted-lightning-retired-receive:${other}-x`, JSON.stringify(receipt({ rfqId: other })))
    expect(listRetiredLightningReceiveReceipts({ vaultId: 'vault-1', network: 'mutinynet' })).toEqual([
      receipt({ rfqId: other }),
    ])
  })

  it.each([
    ['a non-settled state', { state: 'pending' }],
    ['a zero amount', { amountSats: 0 }],
    ['a negative fee', { fee: -1 }],
    ['a zero display amount', { displayAmount: 0 }],
    ['a negative createdAt', { createdAt: -1 }],
    ['a retiredAt before createdAt', { retiredAt: 50 }],
    ['a non-hex digest', { fileDigest: 'nope' }],
    ['an odd-length script', { lockupPkScriptHex: 'abc' }],
    ['an unsupported network', { network: 'testnet' }],
    ['an empty vault id', { vaultId: '' }],
    ['a malformed claim txid', { claimArkTxid: 'zz' }],
  ])('rejects a stored receipt with %s', (_label, overrides) => {
    localStorage.setItem(KEY, JSON.stringify({ ...receipt(), ...overrides }))
    expect(readRetiredLightningReceive(RFQ)).toBeNull()
    expect(listRetiredLightningReceiveReceipts({ vaultId: 'vault-1', network: 'mutinynet' })).toEqual([])
  })

  it('throws and leaves no valid receipt when the write fails its readback', () => {
    expect(() => writeRetiredLightningReceive(receipt({ state: 'pending' }))).toThrow('did not persist')
    expect(readRetiredLightningReceive(RFQ)).toBeNull()
  })
})
