import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { ledgerRecoveryFacts } from './helpers'
import { ledgerSavingsContextDigest, type LedgerSavingsKeyContext } from '../../program/ledgerNativeKeys'
import { ledgerWalletPolicyId } from '../../program/ledgerEnrollment'
import { deriveBoardingKey } from '../../vtxo/board'
import { scalarSecret } from '../../program/fixtures'
import { wrapPhoneSecret } from '../../prfEnvelope'
import { wrapLedgerPhoneSeed } from '../../ledgerPhoneBackup'
import { buildRecoveryHeader, type VaultRecoveryFile } from '../backupCodec'
import { recoveryLightningBinding } from '../journals'
import vectors from '../../program/ledger-key-vectors.json'
import { deriveDirectP256 } from '../../ceremony/directauth'

export const ledgerFixtureSeed = new Uint8Array(32).fill(0x43)
export const ledgerFixturePRF = new Uint8Array(32).fill(0x71)

export async function ledgerRecoveryFixture(
  advanced = false,
  network: 'mainnet' | 'mutinynet' = 'mutinynet',
  vaultId?: string,
) {
  const context = structuredClone(
    vectors.find((v) => Boolean(v.input.recovery) === advanced && v.input.network === network)!.input,
  ) as LedgerSavingsKeyContext
  if (vaultId !== undefined) context.vaultId = vaultId
  const direct = await deriveDirectP256(ledgerFixturePRF)
  context.phoneDirectP256 = hex.encode(direct.pub)
  direct.scalar.fill(0)
  const board = await deriveBoardingKey(scalarSecret(3), context.vaultId, network)
  const facts = ledgerRecoveryFacts(advanced, network, {
    context,
    boardingPub: board.boardingPub,
  })
  board.secret.fill(0)
  const { kit, status, composite, family, archive } = facts
  const trees = [
    kit.descriptor.savings,
    kit.descriptor.savingsChange,
    ...Object.values(kit.descriptor.pending),
    ...Object.values(kit.descriptor.quarantine),
  ]
  archive.onchain = trees.map((tree, index) => {
    const parent = new Transaction({ version: 2, allowUnknownInputs: true, allowUnknownOutputs: true })
    parent.addInput({ txid: '01'.repeat(32), index: index + 100 })
    parent.addOutput({ script: hex.decode(tree.script), amount: 100000n })
    return {
      txid: parent.id,
      vout: 0,
      value: 100000,
      script: tree.script,
      parentHex: hex.encode(parent.toBytes(true, true)),
    }
  })
  const enrollment = {
    vaultId: context.vaultId,
    credId: 'ab'.repeat(32),
    webauthnP256: context.phoneDirectP256,
    phoneDirectP256: context.phoneDirectP256,
    phoneBip340Pub: status.phoneBip340Pub!,
    ...(await wrapPhoneSecret(ledgerFixturePRF, scalarSecret(3))),
    ledgerSavings: {
      version: 1 as const,
      contract: composite.savings,
      registration: {
        name: 'vaulted-ledger-registration' as const,
        version: 1 as const,
        contextDigest: hex.encode(ledgerSavingsContextDigest(context)),
        walletId: ledgerWalletPolicyId(family.walletPolicy),
        walletHmac: 'ab'.repeat(32),
        walletPolicy: family.walletPolicy,
        receiveAddress: family.receive.address,
        changeAddress: family.change.address,
      },
      phoneSeedBackup: await wrapLedgerPhoneSeed(ledgerFixtureSeed, ledgerFixturePRF, 'passkey-prf', context),
    },
  }
  const file: VaultRecoveryFile = {
    name: 'vaulted-recovery',
    version: 1,
    header: buildRecoveryHeader(kit, status, enrollment),
    archive,
    spendingJournal: { version: 1, vaultId: context.vaultId, operations: [] },
    lightningJournal: {
      name: 'vaulted-lightning-recovery',
      version: 1,
      binding: recoveryLightningBinding(status),
      entries: [],
    },
  }
  return { ...facts, file, enrollment }
}
