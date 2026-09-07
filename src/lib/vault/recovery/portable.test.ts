import { afterEach, describe, expect, it, vi } from 'vitest'
import { Transaction, type OnchainProvider } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { CONNECTOR_TEMPLATE, DUAL_CONNECTOR_TEMPLATE } from '../program/connector'
import { recoveryFixture } from './testdata/helpers'
import { scalarSecret, FIXTURE_PHONE_DIRECT_P256 } from '../program/fixtures'
import { wrapPhoneSecret } from '../prfEnvelope'
import {
  buildRecoveryHeader,
  decryptRecoveryBackup,
  recoveryBackupKey,
  validateVaultRecoveryFile,
  type VaultRecoveryFile,
} from './backupCodec'
import { createPortableRecoveryPackage, parsePortableRecoveryPackage, portableRecoverySource } from './portable'
import { prepareVaultSpendingRecovery } from '../vtxo/spendingRecovery'
import { recoveryLightningBinding } from './journals'

afterEach(() => vi.restoreAllMocks())
async function fixture(advanced = true, connector?: Parameters<typeof recoveryFixture>[4]) {
  const { archive, status, kit } = recoveryFixture(advanced, 'mutinynet', undefined, undefined, connector)
  const enrollment = {
    vaultId: status.vaultId,
    credId: 'ab'.repeat(32),
    webauthnP256: FIXTURE_PHONE_DIRECT_P256,
    phoneBip340Pub: kit.descriptor.keys.phoneBip340,
    phoneDirectP256: kit.descriptor.keys.phoneDirectP256,
    ...(await wrapPhoneSecret(scalarSecret(9), scalarSecret(3))),
  }
  const header = buildRecoveryHeader(kit, status, enrollment)
  const file: VaultRecoveryFile = {
    name: 'vaulted-recovery',
    version: 1,
    header,
    archive,
    ...(connector ? { connectorJournal: { version: 1 as const, pending: null, history: [] } } : {}),
    spendingJournal: { version: 1, vaultId: status.vaultId, operations: [] },
    lightningJournal: {
      name: 'vaulted-lightning-recovery',
      version: 1,
      binding: recoveryLightningBinding(status),
      entries: [],
    },
  }
  const key = await recoveryBackupKey(scalarSecret(3), header)
  return { file, key }
}

describe('portable recovery data', () => {
  for (const templateVersion of [CONNECTOR_TEMPLATE, DUAL_CONNECTOR_TEMPLATE]) {
    for (const connectorType of ['p2wpkh', 'p2tr'] as const) {
      it.each([false, true])(
        `exports ${templateVersion} ${connectorType} without changing enrollment, advanced=%s`,
        async (advanced) => {
          const { file, key } = await fixture(advanced, { templateVersion, connectorType })
          const pkg = await createPortableRecoveryPackage(file, key)
          expect(pkg.backup.header).toEqual(file.header)
          expect(portableRecoverySource(pkg).archive.kit).toEqual(file.header.kit)
        },
      )
    }
  }
  it('accepts reordered JSON properties and rejects unknown public identity fields', async () => {
    const { file, key } = await fixture()
    const reordered = structuredClone(file)
    reordered.header.enrollment = Object.fromEntries(
      Object.entries(file.header.enrollment).reverse(),
    ) as typeof file.header.enrollment
    expect((await createPortableRecoveryPackage(reordered, key)).backup.header).toEqual(file.header)
    const extended = structuredClone(file)
    Object.assign(extended.header.enrollment, { token: 'private-test-marker' })
    await expect(createPortableRecoveryPackage(extended, key)).rejects.toThrow('unsupported export fields')
  })
  it('keeps operational data encrypted while making the public exit paths independently readable', async () => {
    const { file, key } = await fixture()
    const internal = { ...structuredClone(file), internalSession: 'test-private-journal-marker' }
    const coins = JSON.parse(internal.archive.spending.coins)
    coins[0].internalAuthorization = 'test-private-journal-marker'
    internal.archive.spending.coins = JSON.stringify(coins)
    internal.archive.spending.info = JSON.stringify({
      ...JSON.parse(internal.archive.spending.info),
      authentication: 'test-private-journal-marker',
    })
    const pkg = await createPortableRecoveryPackage(internal, key)
    const encoded = JSON.stringify(pkg)
    expect(encoded).not.toContain('test-private-journal-marker')
    expect(encoded).not.toContain(hex.encode(scalarSecret(3)))
    const source = portableRecoverySource(JSON.parse(encoded))
    expect(JSON.parse(source.archive.spending.coins)).toEqual(JSON.parse(file.archive.spending.coins))
    expect(source.archive.spending.transactions).toEqual(file.archive.spending.transactions)
    expect('spendingJournal' in source).toBe(false)
    expect(() => validateVaultRecoveryFile(source as unknown as VaultRecoveryFile)).toThrow('Invalid recovery file')
    expect(await decryptRecoveryBackup(pkg.backup, key)).toEqual(internal)
  })
  it('prepares Advanced Spending with hardware and recovery signatures while the phone and services are unavailable', async () => {
    const { file, key } = await fixture()
    const pkg = await createPortableRecoveryPackage(file, key)
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('services unavailable'))
    const source = portableRecoverySource(JSON.parse(JSON.stringify(pkg)))
    const provider = {
      getCoins: async () => [],
      getFeeRate: async () => 1,
      getTxStatus: async () => ({ confirmed: true, blockTime: 1, blockHeight: 1 }),
      getChainTip: async () => ({ height: 10000, time: 2_000_000_000, hash: '01'.repeat(32) }),
      getTxOutspends: async () => [{ spent: false }],
      getTransactions: async () => [],
      watchAddresses: async () => () => {},
      broadcastTransaction: vi.fn(async () => {
        throw new Error('must not broadcast during preparation')
      }),
    } satisfies OnchainProvider
    const prepared = await prepareVaultSpendingRecovery(
      source.archive,
      file.header.kit.descriptor.savings.address,
      async ({ psbt, requiredKeys }) => {
        expect(requiredKeys.map((item) => item.role)).toEqual(['hardware', 'recovery'])
        const tx = Transaction.fromPSBT(hex.decode(psbt))
        tx.sign(scalarSecret(4))
        tx.sign(scalarSecret(5))
        return hex.encode(tx.toPSBT())
      },
      provider,
    )
    expect(prepared.exitPackage.steps.some((step) => step.kind === 'sweep')).toBe(true)
    expect(provider.broadcastTransaction).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })
  it('rejects missing paths and a readable archive belonging to another account', async () => {
    const { file, key } = await fixture()
    const pkg = await createPortableRecoveryPackage(file, key)
    const missing = structuredClone(pkg)
    missing.archive.spending.transactions = {}
    expect(() => parsePortableRecoveryPackage(missing)).toThrow()
    const foreign = await fixture(false)
    expect(() => parsePortableRecoveryPackage({ ...pkg, archive: foreign.file.archive })).toThrow()
  })
})
