import { createBoardingProgramScript } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { scalarSecret } from '../../program/fixtures'
import { BOARDING_PROGRAM } from '../../vtxo/board'
import { findMatureBoardingInputs } from '../../vtxo/boardingRecovery'
import { networkPins } from '../../networkPins'
import {
  chainProvider,
  exclusiveVaultLocks,
  memoryAttemptStore,
  signLiveMatureBoarding,
} from '../../vtxo/testdata/matureBoarding'
import { validateVaultRecoveryFile } from '../backupCodec'
import { ledgerRecoveryFixture } from './ledger'
import type { MatureBoardingAttempt } from '../../vtxo/matureBoardingJournal'

export async function signedPortableMatureBoarding(network: 'mainnet' | 'mutinynet') {
  const f = await ledgerRecoveryFixture(false, network)
  const descriptor = f.status.vtxoBoardingDescriptor!
  const pins = networkPins(network)
  const program = createBoardingProgramScript(
    {
      name: BOARDING_PROGRAM,
      boardingPubKey: hex.decode(descriptor.boardingPub).slice(1),
      cosignerPubKey: hex.decode(descriptor.vaultBoardCosignerPub).slice(1),
      recoveryPubKey: hex.decode(descriptor.recoveryPhonePub).slice(1),
    },
    hex.decode(pins.operatorSignerPub).slice(1),
    { type: 'seconds', value: BigInt(pins.boardExitDelay) },
  )
  const mature = {
    txid: '11'.repeat(32),
    vout: 0,
    value: 100_000,
    status: {
      confirmed: true,
      block_height: 1,
      block_time: Math.floor(Date.now() / 1000) - pins.boardExitDelay - 1,
    },
    tapTree: program.encode(),
    forfeitTapLeafScript: [] as never,
    intentTapLeafScript: [] as never,
  }
  const inputs = [mature, { ...mature, txid: '22'.repeat(32) }]
  const found = await findMatureBoardingInputs(f.status, { getBoardingUtxos: async () => inputs })
  if (found.inputs.length !== 2) {
    throw new Error(`portable mature boarding fixture expected 2 matured inputs, found ${found.inputs.length}`)
  }
  const { store, txid } = await signLiveMatureBoarding({
    enrollment: f.enrollment,
    status: f.status,
    inputs: found.inputs,
    phoneSecret: scalarSecret(3),
    store: memoryAttemptStore(),
    provider: chainProvider(),
    locks: exclusiveVaultLocks(),
  })
  const live = store.get() as MatureBoardingAttempt
  const file = validateVaultRecoveryFile({ ...f.file, matureBoardingJournal: live })
  return {
    f,
    live,
    file,
    txid,
  }
}
