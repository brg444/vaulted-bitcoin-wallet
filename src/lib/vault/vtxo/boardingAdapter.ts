import type { BoardingSigningAdapter, Recipient, ValidatedBoardingBatch, Intent } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import {
  vaultCosignerClient,
  type BoardingDeleteMessageWire,
  type BoardingRecipientWire,
  type BoardingRegisterMessageWire,
} from '../cosignerClient'
import { hexToBytes } from '../hex'
import type { BoardingDescriptor } from '../types'
import { waitForVaultSettlementStream, vaultSettlementStreamGuard } from './settlementEventSource'
import { persistBoardingTranscript } from './boardingJournal'

function exactRecipient(recipient: Recipient): BoardingRecipientWire {
  if (
    recipient.assets?.length ||
    recipient.extensions?.length ||
    recipient.tapTree ||
    !Number.isSafeInteger(recipient.amount) ||
    Number(recipient.amount) <= 0 ||
    !recipient.address
  ) {
    throw new Error('vault-board-v1 requires one BTC-only recipient')
  }
  return { address: recipient.address, amountSats: Number(recipient.amount) }
}

function safeBatchExpiry(value: bigint): number {
  if (value <= 0n || value > BigInt(0xffffffff)) throw new Error('vault-board-v1 batch expiry is invalid')
  return Number(value)
}

function registerMessage(message: Intent.RegisterMessage): BoardingRegisterMessageWire {
  if (
    message.type !== 'register' ||
    !Array.isArray(message.onchain_output_indexes) ||
    !Array.isArray(message.cosigners_public_keys) ||
    !Number.isSafeInteger(message.valid_at) ||
    !Number.isSafeInteger(message.expire_at)
  ) {
    throw new Error('vault-board-v1 register message is invalid')
  }
  return {
    type: 'register',
    onchain_output_indexes: [...message.onchain_output_indexes],
    valid_at: message.valid_at,
    expire_at: message.expire_at,
    cosigners_public_keys: [...message.cosigners_public_keys],
  }
}

function deleteMessage(message: Intent.DeleteMessage): BoardingDeleteMessageWire {
  if (message.type !== 'delete' || !Number.isSafeInteger(message.expire_at)) {
    throw new Error('vault-board-v1 delete message is invalid')
  }
  return { type: 'delete', expire_at: message.expire_at }
}

function finalBatch(batch: ValidatedBoardingBatch) {
  const recipients = batch.expectedRecipients.map(exactRecipient)
  if (recipients.length !== 1) throw new Error('vault-board-v1 requires one validated recipient')
  return {
    batchId: batch.batchId,
    batchExpiry: safeBatchExpiry(batch.batchExpiry),
    unsignedCommitmentTx: batch.unsignedCommitmentTx,
    vtxoTree: batch.vtxoTree.map((node) => ({
      txid: node.txid,
      tx: node.tx,
      children: { ...node.children },
    })),
    expectedRecipients: recipients,
  }
}

export function createBoardingSigningAdapter(vaultId: string, descriptor: BoardingDescriptor): BoardingSigningAdapter {
  const publicKey = hexToBytes(descriptor.vaultBoardCosignerPub).slice(1)
  if (publicKey.length !== 32 || hex.encode(publicKey) !== descriptor.vaultBoardCosignerPub.slice(2)) {
    throw new Error('vault-board-v1 cosigner key is invalid')
  }
  let generation = 0
  let preparedStream: { handle: string; topic: string; requireOpen?: () => void } | undefined
  return {
    publicKey,
    async prepareRegistration(request) {
      const current = ++generation
      preparedStream = undefined
      if (request.inputs.length !== 1 || request.recipients.length !== 1) {
        throw new Error('vault-board-v1 requires one boarding input and one recipient')
      }
      const input = request.inputs[0]
      if (!/^[0-9a-f]{64}$/.test(input.txid) || !Number.isSafeInteger(input.vout) || input.vout < 0) {
        throw new Error('vault-board-v1 outpoint is invalid')
      }
      const prepared = await vaultCosignerClient.boarding.prepare({
        vaultId,
        inputs: [{ txid: input.txid, vout: input.vout }],
        recipients: [exactRecipient(request.recipients[0])],
      })
      if (current !== generation) throw new Error('Boarding preparation was superseded')
      preparedStream =
        prepared.status === 'ready' && prepared.handle
          ? { handle: prepared.handle, topic: `${input.txid}:${input.vout}` }
          : undefined
      return prepared
    },
    async registerIntent(request) {
      const stream = preparedStream
      if (!stream || stream.handle !== request.handle) {
        throw new Error('vault-board-v1 registration is not bound to the prepared outpoint')
      }
      await waitForVaultSettlementStream(stream.topic)
      if (preparedStream !== stream) throw new Error('Boarding registration was superseded')
      stream.requireOpen = vaultSettlementStreamGuard(stream.topic)
      return vaultCosignerClient.boarding.register({
        handle: request.handle,
        psbt: request.psbt,
        inputIndexes: [...request.inputIndexes],
        message: registerMessage(request.message),
      })
    },
    releaseIntent(request) {
      return vaultCosignerClient.boarding.release({
        handle: request.handle,
        psbt: request.psbt,
        inputIndexes: [...request.inputIndexes],
        message: deleteMessage(request.message),
      })
    },
    async submitCommitment(request) {
      const stream = preparedStream
      if (!stream?.requireOpen || stream.handle !== request.handle)
        throw new Error('Boarding final request is not bound to its registered stream')
      const requireOpen = stream.requireOpen
      requireOpen()
      const exact = {
        handle: request.handle,
        psbt: request.psbt,
        inputIndexes: [...request.inputIndexes],
        signedForfeits: [...request.signedForfeits],
        validatedBatch: finalBatch(request.validatedBatch),
      }
      await persistBoardingTranscript(vaultId, descriptor, exact)
      if (preparedStream !== stream || stream.requireOpen !== requireOpen)
        throw new Error('Boarding final request was superseded')
      requireOpen()
      return vaultCosignerClient.boarding.final(exact)
    },
  }
}
