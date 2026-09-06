import { describe, expect, it } from 'vitest'
import { buildVaultProgramDescriptor, familyFromDescriptor } from './descriptor'
import { PROGRAM_FIXTURE } from './fixtures'
import { buildRecoveryKit } from './kit'
import { parseKitCli, runKitCli } from './kitCli'
import { inspectTransitionPsbt } from './spend'

function fixtureKit() {
  return buildRecoveryKit(buildVaultProgramDescriptor(PROGRAM_FIXTURE))
}

describe('Recovery Kit CLI', () => {
  it('inspects every tree and rebuilds the family from the kit', () => {
    const kit = fixtureKit()
    const out = runKitCli({ name: 'inspect', kit })
    expect(out).toContain(kit.descriptor.savings.address)
    expect(out).toContain(kit.descriptor.pending['savings-hardware'].address)
    expect(out).toContain('Normal Savings can be recovered with the phone and hardware keys without either service.')
    const family = familyFromDescriptor(kit.descriptor)
    expect(family.savings.address).toBe(kit.descriptor.savings.address)
    expect(family.pending['savings-recovery'].address).toBe(kit.descriptor.pending['savings-recovery'].address)
  })

  it('builds an initiate PSBT from CLI flags', () => {
    const kit = fixtureKit()
    const cmd = parseKitCli(
      [
        'initiate',
        'kit.json',
        '--claimant',
        'hardware',
        '--txid',
        '11'.repeat(32),
        '--vout',
        '0',
        '--value',
        '50000',
        '--fee',
        '500',
      ],
      () => kit,
    )
    const out = runKitCli(cmd)
    const [dest, psbt] = out.split('\n')
    expect(dest).toBe(kit.descriptor.pending['savings-hardware'].address)
    expect(inspectTransitionPsbt(psbt).p2aSats).toBe(240)
  })

  it('refuses a clawback whose guardian is the suspected claimant', () => {
    const kit = fixtureKit()
    const cmd = parseKitCli(
      [
        'clawback',
        'kit.json',
        '--claimant',
        'hardware',
        '--guardian',
        'hardware',
        '--txid',
        '11'.repeat(32),
        '--vout',
        '0',
        '--value',
        '50000',
        '--fee',
        '500',
      ],
      () => kit,
    )
    expect(() => runKitCli(cmd)).toThrow(/guardian/)
  })

  it('reports remaining CSV from chain heights, not Normal UTXO age', () => {
    const kit = fixtureKit()
    const cmd = parseKitCli(
      ['status', 'kit.json', '--claimant', 'hardware', '--tip', '105', '--height', '100'],
      () => kit,
    )
    const out = runKitCli(cmd)
    expect(out).toContain('state claimable')
    expect(out).toContain('remaining 0')
    const early = runKitCli(
      parseKitCli(['status', 'kit.json', '--claimant', 'hardware', '--tip', '104', '--height', '100'], () => kit),
    )
    expect(early).toContain('state pending')
    expect(early).toContain('remaining 1')
    expect(early).toContain('claimable no')
  })

  it('accepts Esplora-backed status without a local tip', () => {
    const kit = fixtureKit()
    const cmd = parseKitCli(
      ['status', 'kit.json', '--claimant', 'hardware', '--esplora', 'https://mutinynet.com/api'],
      () => kit,
    )
    expect(cmd).toMatchObject({ name: 'status', esplora: 'https://mutinynet.com/api' })
    expect(() => runKitCli(cmd)).toThrow(/runKitCliAsync/)
  })

  it('bumps a transition fee without changing dest', () => {
    const kit = fixtureKit()
    const built = runKitCli(
      parseKitCli(
        [
          'initiate',
          'kit.json',
          '--claimant',
          'hardware',
          '--txid',
          '11'.repeat(32),
          '--vout',
          '0',
          '--value',
          '50000',
          '--fee',
          '500',
        ],
        () => kit,
      ),
    )
    const psbt = built.split('\n')[1]
    const bumped = runKitCli({ name: 'bump', psbtHex: psbt, fee: 800 })
    expect(bumped.startsWith('800\n')).toBe(true)
    expect(inspectTransitionPsbt(bumped.split('\n')[1]).destScript).toBe(inspectTransitionPsbt(psbt).destScript)
  })

  it('refuses a suspect clawback from the CLI', () => {
    const kit = fixtureKit()
    const cmd = parseKitCli(
      [
        'clawback',
        'kit.json',
        '--claimant',
        'hardware',
        '--guardian',
        'hardware',
        '--txid',
        '11'.repeat(32),
        '--vout',
        '0',
        '--value',
        '50000',
        '--fee',
        '500',
      ],
      () => kit,
    )
    expect(() => runKitCli(cmd)).toThrow(/guardian/)
  })
})
