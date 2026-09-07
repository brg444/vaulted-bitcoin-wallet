import { describe, expect, it } from 'vitest'
import { importConnectorOrigin } from './connectorOrigin'

// Public fixtures from the well-known BIP84 test mnemonic
// ("abandon" x11 + "about", empty passphrase). The BIP84 receive/change
// vectors below are published in BIP84 itself; the remaining values were
// generated once with @scure/bip32/@scure/btc-signer, checksums
// cross-checked against @bitcoinerlab/descriptors-core, and pasted here as
// independent literals (never recomputed by the module under test).
const FP = 0x73c5da0a
const ACC84 =
  'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V'
const ACC86 =
  'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ'
const ELEC =
  'xpub68jrRzQopSUQm76hJ6TNtiJMJfhj38u1X12xCzExrw388hcN443UVnYpswdUkV7vPJ3KayiCdp3Q5E23s4wvkucohVTh7eSstJdBFyn2DMx'
const TACC84 =
  'tpubDC8msFGeGuwnKG9Upg7DM2b4DaRqg3CUZa5g8v2SRQ6K4NSkxUgd7HsL2XVWbVm39yBA4LAxysQAm397zwQSQoQgewGiYZqrA9DsP4zbQ1M'
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
const VPUB =
  'vpub5Y6cjg78GGuNLsaPhmYsiw4gYX3HoQiRBiSwDaBXKUafCt9bNwWQiitDk5VZ5BVxYnQdwoTyXSs2JHRPAgjAvtbBrf8ZhDYe2jWAqvZVnsc'
const YPUB =
  'ypuSw8S6ehYXBMvx1yGsoyfd4TGzz3yTCeKKyW8S7eiCZRYWPHQhgDNoYNVaikg2YsqUDGPCaZzeRxjbT1wWf81XYzpKyJit8VV1a6n3mU7r2VA'
const XPRV84 =
  'xprv9ybY78BftS5UGANki6oSifuQEjkpyAC8ZmBvBNTshQnCBcxnefjHS7buPMkkqhcRzmoGZ5bokx7GuyDAiktd5HemohAU4wV1ZPMDRmLpBMm'
const ZPUB86 =
  'zpub6qLiJCzi7t1C7qRZx8ULcy2eGbXpmbbQZmu3znjqoR4VZADKELunndvcw4iSVaGx2KhviLLXuB3vcyGcdd2q8XXBQJc5T5qrtorRowa1zfs'
const ZPRV84 =
  'zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE'

const H = 0x80000000
const P84 = [H + 84, H, H]
const P86 = [H + 86, H, H]

function rejectsWith(input: string, network: 'mainnet' | 'mutinynet', message: string, index = 0) {
  expect(() => importConnectorOrigin(input, network, index)).toThrowError(message)
}

describe('importConnectorOrigin supported forms', () => {
  it('derives the BIP84 published first receiving leaf from a multipath xpub descriptor', () => {
    const got = importConnectorOrigin(`wpkh([73c5da0a/84'/0'/0']${ACC84}/<0;1>/*)`, 'mainnet')
    expect(got).toEqual({
      type: 'p2wpkh',
      publicKey: '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c',
      fingerprint: FP,
      path: [...P84, 0, 0],
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      selectedPath: expect.stringContaining("m/84'/0'/0'/0/0"),
    })
    expect(got.selectedPath).toContain('receive branch 0')
    expect(got.selectedPath).toContain('<0;1>')
  })

  it('resolves multipath plus an explicit index to the BIP84 published second leaf', () => {
    const got = importConnectorOrigin(`wpkh([73c5da0a/84'/0'/0']${ACC84}/<0;1>/*)`, 'mainnet', 1)
    expect(got.publicKey).toBe('03e775fd51f0dfb8cd865d9ff1cca2a158cf651fe997fdc9fee9c1d3b5e995ea77')
    expect(got.address).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g')
    expect(got.path).toEqual([...P84, 0, 1])
  })

  it('derives a wildcard single-branch leaf at a caller-chosen index', () => {
    const got = importConnectorOrigin(`wpkh([73c5da0a/84'/0'/0']${ACC84}/0/*)`, 'mainnet', 2)
    expect(got.publicKey).toBe('038ffea936b2df76bf31220ebd56a34b30c6b86f40d3bd92664e2f5f98488dddfa')
    expect(got.address).toBe('bc1qp59yckz4ae5c4efgw2s5wfyvrz0ala7rgvuz8z')
    expect(got.path).toEqual([...P84, 0, 2])
    expect(got.selectedPath).toContain('wildcard * resolved to index 2')
  })

  it('accepts explicit concrete steps and an explicitly stated change branch', () => {
    const got = importConnectorOrigin(`wpkh([73c5da0a/84'/0'/0']${ACC84}/1/5)`, 'mainnet')
    expect(got.publicKey).toBe('0309e49da9dbf5174885570c87107b1b2e2552068068350ab832fcc8f64626d6c1')
    expect(got.address).toBe('bc1qu3936zt3c42xdz94752q07jg8656gfeh3agj6j')
    expect(got.path).toEqual([...P84, 1, 5])
    expect(got.selectedPath).toContain('change branch 1 (explicitly stated)')
  })

  it('accepts h markers as hardened origin steps', () => {
    const got = importConnectorOrigin(`wpkh([73c5da0a/84h/0h/0h]${ACC84}/<0;1>/*)`, 'mainnet')
    expect(got.publicKey).toBe('0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c')
    expect(got.path).toEqual([...P84, 0, 0])
  })

  it('accepts an uppercase origin fingerprint', () => {
    const got = importConnectorOrigin(`wpkh([73C5DA0A/84'/0'/0']${ACC84}/0/0)`, 'mainnet')
    expect(got.fingerprint).toBe(FP)
    expect(got.publicKey).toBe('0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c')
  })

  it('derives a taproot key-path leaf from a tr xpub descriptor', () => {
    const got = importConnectorOrigin(`tr([73c5da0a/86'/0'/0']${ACC86}/<0;1>/*)`, 'mainnet')
    expect(got).toEqual({
      type: 'p2tr',
      publicKey: '03cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115',
      fingerprint: FP,
      path: [...P86, 0, 0],
      address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
      selectedPath: expect.stringContaining("m/86'/0'/0'/0/0"),
    })
  })

  it("derives the native Electrum SegWit receive leaf m/0'/0/0", () => {
    const got = importConnectorOrigin(`wpkh([73c5da0a/0']${ELEC}/<0;1>/*)`, 'mainnet')
    expect(got.publicKey).toBe('026666422d00f1b308fc7527198749f06fedb028b979c09f60d0348ef79c985e41')
    expect(got.address).toBe('bc1qgv52mt89gpev6p56huggl970sppqkgftxakv7f')
    expect(got.fingerprint).toBe(FP)
    expect(got.path).toEqual([H, 0, 0])
    expect(got.selectedPath).toContain('receive branch 0')
  })

  it('derives a mutinynet leaf from a tpub descriptor with coin type 1', () => {
    const got = importConnectorOrigin(`wpkh([73c5da0a/84'/1'/0']${TACC84}/0/*)`, 'mutinynet')
    expect(got.publicKey).toBe('02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319')
    expect(got.address).toBe('tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl')
    expect(got.path).toEqual([H + 84, H + 1, H, 0, 0])
  })

  it('decodes a SLIP132 zpub to the same leaf as the matching xpub', () => {
    const body = `wpkh([73c5da0a/84'/0'/0']${ZPUB}/<0;1>/*)`
    const got = importConnectorOrigin(body, 'mainnet')
    expect(got.publicKey).toBe('0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c')
    expect(got.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')
    // The zpub above is the account key published in BIP84 itself.
    expect(ZPUB).toBe(
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs',
    )
  })

  it('decodes a SLIP132 vpub on mutinynet', () => {
    const got = importConnectorOrigin(`wpkh([73c5da0a/84'/1'/0']${VPUB}/0/*)`, 'mutinynet')
    expect(got.publicKey).toBe('02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319')
    expect(got.address).toBe('tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl')
  })

  it('accepts a concrete compressed key with a complete origin and no suffix', () => {
    const leaf = '03de7490bcca92a2fb57d782c3fd60548ce3a842cad6f3a8d4e76d1f2ff7fcdb89'
    const got = importConnectorOrigin(`wpkh([73c5da0a/84'/0'/0'/0/3]${leaf})`, 'mainnet')
    expect(got.publicKey).toBe(leaf)
    expect(got.address).toBe('bc1qgl5vlg0zdl7yvprgxj9fevsc6q6x5dmcyk3cn3')
    expect(got.path).toEqual([...P84, 0, 3])
  })

  it('accepts an uppercase concrete key but normalizes parity-preserving lowercase output', () => {
    const leaf = '03de7490bcca92a2fb57d782c3fd60548ce3a842cad6f3a8d4e76d1f2ff7fcdb89'
    const got = importConnectorOrigin(`wpkh([73c5da0a/84'/0'/0'/0/3]${leaf.toUpperCase()})`, 'mainnet')
    expect(got.publicKey).toBe(leaf)
    expect(got.publicKey.startsWith('03')).toBe(true)
  })

  it('accepts a concrete taproot key with a complete origin', () => {
    const leaf = '03cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115'
    const got = importConnectorOrigin(`tr([73c5da0a/86'/0'/0'/0/0]${leaf})`, 'mainnet')
    expect(got.type).toBe('p2tr')
    expect(got.address).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr')
  })

  it('accepts a mutinynet concrete key', () => {
    const leaf = '02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319'
    const got = importConnectorOrigin(`wpkh([73c5da0a/84'/1'/0'/0/0]${leaf})`, 'mutinynet')
    expect(got.address).toBe('tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl')
  })
})

describe('importConnectorOrigin checksums', () => {
  const body = `wpkh([73c5da0a/84'/0'/0']${ACC84}/<0;1>/*)`
  const expected = importConnectorOrigin(body, 'mainnet')

  it('accepts a descriptor carrying a valid checksum', () => {
    expect(importConnectorOrigin(`${body}#hpg6d6w2`, 'mainnet')).toEqual(expected)
  })

  it('accepts a valid tr checksum', () => {
    const trBody = `tr([73c5da0a/86'/0'/0']${ACC86}/<0;1>/*)`
    expect(importConnectorOrigin(`${trBody}#kjk9q86c`, 'mainnet')).toEqual(importConnectorOrigin(trBody, 'mainnet'))
  })

  it('rejects mutated, truncated, extended, and non-alphabet checksums', () => {
    rejectsWith(`${body}#hpg6d6w3`, 'mainnet', 'invalid descriptor checksum')
    rejectsWith(`${body}#hpg6d6w`, 'mainnet', 'invalid descriptor checksum')
    rejectsWith(`${body}#hpg6d6w22`, 'mainnet', 'invalid descriptor checksum')
    rejectsWith(`${body}#hpg6d6w!`, 'mainnet', 'invalid descriptor checksum')
    rejectsWith(`${body}#`, 'mainnet', 'invalid descriptor checksum')
    rejectsWith(`${body}#hpg6d6w2#hpg6d6w2`, 'mainnet', 'invalid descriptor checksum')
  })
})

describe('importConnectorOrigin adversarial inputs', () => {
  const wpkhAccount = `wpkh([73c5da0a/84'/0'/0']${ACC84}/<0;1>/*)`

  it('rejects mainnet/testnet key and coin mismatches', () => {
    rejectsWith(`wpkh([73c5da0a/84'/1'/0']${TACC84}/0/*)`, 'mainnet', 'extended key network mismatch')
    rejectsWith(wpkhAccount, 'mutinynet', 'extended key network mismatch')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ZPUB}/<0;1>/*)`, 'mutinynet', 'extended key network mismatch')
    rejectsWith(`wpkh([73c5da0a/84'/1'/0']${VPUB}/0/*)`, 'mainnet', 'extended key network mismatch')
    // Right key family, wrong coin type for the requested network.
    rejectsWith(`wpkh([73c5da0a/84'/1'/0']${ACC84}/<0;1>/*)`, 'mainnet', 'non-standard origin path')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${TACC84}/<0;1>/*)`, 'mutinynet', 'non-standard origin path')
  })

  it('rejects missing or malformed origins', () => {
    rejectsWith(`wpkh(${ACC84}/<0;1>/*)`, 'mainnet', 'descriptor origin fingerprint and path required')
    rejectsWith(`wpkh([84'/0'/0']${ACC84}/<0;1>/*)`, 'mainnet', 'descriptor origin fingerprint and path required')
    rejectsWith(`wpkh([73c5da0a]${ACC84}/<0;1>/*)`, 'mainnet', 'descriptor origin path required')
    rejectsWith(`wpkh([73c5da0/${ACC84}/<0;1>/*)`, 'mainnet', 'descriptor origin fingerprint and path required')
    rejectsWith(
      `wpkh([73c5da0a/84'/0'/0'${ACC84}/<0;1>/*)`,
      'mainnet',
      'descriptor origin fingerprint and path required',
    )
    rejectsWith(
      `wpkh([73c5da/84'/0'/0']${ACC84}/<0;1>/*)`,
      'mainnet',
      'descriptor origin fingerprint and path required',
    )
    rejectsWith(
      `wpkh([73c5da0a11/84'/0'/0']${ACC84}/<0;1>/*)`,
      'mainnet',
      'descriptor origin fingerprint and path required',
    )
  })

  it('rejects the native Electrum origin for taproot descriptors', () => {
    rejectsWith(`tr([73c5da0a/0']${ELEC}/0/*)`, 'mainnet', 'non-standard origin path')
  })

  it('rejects keys whose child index or parent fingerprint contradict the origin', () => {
    // Account-0 xpub claimed as account 1: same depth, correct script shape,
    // but wrong signer derivation metadata.
    rejectsWith(`wpkh([73c5da0a/84'/0'/1']${ACC84}/<0;1>/*)`, 'mainnet', 'origin does not match key')
    // Depth-1 Electrum key whose parent fingerprint is directly knowable.
    rejectsWith(`wpkh([deadbeef/0']${ELEC}/<0;1>/*)`, 'mainnet', 'origin does not match key')
  })

  it('restricts the multipath marker to a single branch-position occurrence', () => {
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/<0;1>/<0;1>)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/0/<0;1>)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/*/<0;1>)`, 'mainnet', 'unsupported descriptor derivation')
  })

  it('requires xpub/tpub for tr and keeps native SegWit versions on wpkh', () => {
    rejectsWith(`tr([73c5da0a/86'/0'/0']${ZPUB86}/<0;1>/*)`, 'mainnet', 'native SegWit versions require wpkh')
    rejectsWith(`tr([73c5da0a/84'/1'/0']${VPUB}/0/*)`, 'mutinynet', 'native SegWit versions require wpkh')
  })

  it('rejects private extended-key prefixes before decoding, without echo', () => {
    for (const prv of [XPRV84, ZPRV84]) {
      const input = `wpkh([73c5da0a/84'/0'/0']${prv}/<0;1>/*)`
      let message = ''
      try {
        importConnectorOrigin(input, 'mainnet')
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toBe('private extended keys are not accepted')
      expect(input.includes(message)).toBe(false)
    }
  })

  it('rejects purpose/type mismatches and non-standard purposes', () => {
    rejectsWith(`wpkh([73c5da0a/86'/0'/0']${ACC86}/<0;1>/*)`, 'mainnet', 'non-standard origin path')
    rejectsWith(`tr([73c5da0a/84'/0'/0']${ACC84}/<0;1>/*)`, 'mainnet', 'non-standard origin path')
    rejectsWith(`wpkh([73c5da0a/49'/0'/0']${ACC84}/<0;1>/*)`, 'mainnet', 'non-standard origin path')
    // Unhardened account step is not a BIP84 account (also trips key/origin consistency).
    rejectsWith(`wpkh([73c5da0a/84'/0'/0]${ACC84}/<0;1>/*)`, 'mainnet', 'origin does not match key')
  })

  it('rejects hardened or malformed derivation suffixes', () => {
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/0'/0)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/0h/0)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/*/0)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/*/*)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/0/)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}//0)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/-1)`, 'mainnet', 'unsupported descriptor derivation')
  })

  it('rejects account-only keys used as leaves', () => {
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84})`, 'mainnet', 'derivation suffix required')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/*)`, 'mainnet', 'non-standard origin path')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/<0;1>)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(
      `wpkh([73c5da0a/84'/0'/0']03de7490bcca92a2fb57d782c3fd60548ce3a842cad6f3a8d4e76d1f2ff7fcdb89)`,
      'mainnet',
      'non-standard origin path',
    )
  })

  it('rejects concrete keys with suffixes or invalid points', () => {
    const leaf = '03de7490bcca92a2fb57d782c3fd60548ce3a842cad6f3a8d4e76d1f2ff7fcdb89'
    rejectsWith(`wpkh([73c5da0a/84'/0'/0'/0/3]${leaf}/0)`, 'mainnet', 'concrete keys take no derivation suffix')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0'/0/3]${'02'.padEnd(66, '0')})`, 'mainnet', 'invalid compressed public key')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0'/0/3]${'04'.padEnd(66, '0')})`, 'mainnet', 'invalid compressed public key')
  })

  it('rejects private extended keys without echoing them', () => {
    const input = `wpkh([73c5da0a/84'/0'/0']${XPRV84}/<0;1>/*)`
    let message = ''
    try {
      importConnectorOrigin(input, 'mainnet')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe('private extended keys are not accepted')
    expect(message).not.toContain('xprv')
    expect(input.includes(message)).toBe(false)
  })

  it('rejects mnemonic text without echoing it', () => {
    const mnemonic = `${'abandon '.repeat(11)}about`
    let message = ''
    try {
      importConnectorOrigin(mnemonic, 'mainnet')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('abandon')
    rejectsWith(`wpkh(${mnemonic})`, 'mainnet', 'descriptor origin fingerprint and path required')
  })

  it('rejects nested-SegWit and unknown extended-key versions', () => {
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${YPUB}/<0;1>/*)`, 'mainnet', 'unsupported descriptor key')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']xpub661MyMwAqRbcFtXgS5sYJABqqG9YL)`, 'mainnet', 'unsupported descriptor key')
  })

  it('rejects tap trees, multisig, and unknown wrappers', () => {
    rejectsWith(
      `tr([73c5da0a/86'/0'/0']${ACC86}/<0;1>/*,{pk([73c5da0a/86'/0'/0']${ACC86}/<0;1>/*)})`,
      'mainnet',
      'unsupported descriptor derivation',
    )
    rejectsWith(
      `tr([73c5da0a/86'/0'/0'/0/0]03cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115,03cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115)`,
      'mainnet',
      'unsupported descriptor key',
    )
    rejectsWith(`wsh(wpkh([73c5da0a/84'/0'/0']${ACC84}/<0;1>/*))`, 'mainnet', 'only wpkh and key-path tr')
    rejectsWith(`sh(wpkh([73c5da0a/84'/0'/0']${ACC84}/<0;1>/*))`, 'mainnet', 'only wpkh and key-path tr')
    rejectsWith(`pkh([73c5da0a/44'/0'/0']${ACC84}/<0;1>/*)`, 'mainnet', 'only wpkh and key-path tr')
    rejectsWith("WPKH([73c5da0a/84'/0'/0']placeholder/<0;1>/*)", 'mainnet', 'only wpkh and key-path tr')
  })

  it('rejects malformed multipath grammar', () => {
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/<0;1;2>/*)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/<0>/*)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/<1;0>/*)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/{0,1}/*)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/<0;1/*)`, 'mainnet', 'unsupported descriptor derivation')
  })

  it('rejects numeric overflow in origins, suffixes, and the index argument', () => {
    rejectsWith(`wpkh([73c5da0a/84'/0'/2147483648']${ACC84}/<0;1>/*)`, 'mainnet', 'invalid descriptor origin path')
    rejectsWith(`wpkh([73c5da0a/84'/0'/2147483648h]${ACC84}/<0;1>/*)`, 'mainnet', 'invalid descriptor origin path')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/4294967296)`, 'mainnet', 'derivation index out of range')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/99999999999)`, 'mainnet', 'unsupported descriptor derivation')
    rejectsWith(wpkhAccount, 'mainnet', 'derivation index out of range', H)
    rejectsWith(wpkhAccount, 'mainnet', 'derivation index out of range', -1)
    rejectsWith(wpkhAccount, 'mainnet', 'derivation index out of range', 1.5)
    rejectsWith(`wpkh([73c5da0a/84'/0'/0']${ACC84}/0/0)`, 'mainnet', 'derivation index requires a wildcard step', 1)
  })

  it('rejects parent keys whose depth is inconsistent with the origin', () => {
    rejectsWith(`wpkh([73c5da0a/84'/0']${ACC84}/<0;1>/*)`, 'mainnet', 'origin depth does not match key depth')
    rejectsWith(`wpkh([73c5da0a/84'/0'/0'/0]${ACC84}/<0;1>/*)`, 'mainnet', 'origin depth does not match key depth')
    rejectsWith(`wpkh([73c5da0a/0'/0]${ELEC}/<0;1>/*)`, 'mainnet', 'origin depth does not match key depth')
  })

  it('rejects malformed envelopes and arguments', () => {
    rejectsWith('', 'mainnet', 'invalid descriptor')
    rejectsWith('wpkh()', 'mainnet', 'invalid descriptor')
    rejectsWith('wpkh(', 'mainnet', 'only wpkh and key-path tr')
    rejectsWith(`${wpkhAccount} `, 'mainnet', 'only wpkh and key-path tr')
    rejectsWith(` ${wpkhAccount}`, 'mainnet', 'only wpkh and key-path tr')
    rejectsWith('x'.repeat(1025), 'mainnet', 'invalid descriptor')
    rejectsWith(wpkhAccount, 'testnet' as 'mainnet', 'unsupported network')
    expect(() => importConnectorOrigin(null as unknown as string, 'mainnet')).toThrowError('invalid descriptor')
  })
})
