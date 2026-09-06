import { hex } from '@scure/base'
import { validateRecoveryHeader, type RecoveryHeader } from '../recovery/backupCodec'
import { validateConnectorRecoveryRecord, type ConnectorPendingRecord } from './connectorStore'
import { CONNECTOR_TEMPLATE } from './connector'
import type { SavingsRecoveryChain } from './onchainRecovery'
export interface ConnectorRecoveryFile {
  name: 'vaulted-connector-recovery'
  version: 1
  header: RecoveryHeader
  record: ConnectorPendingRecord
}
export function validateConnectorRecoveryFile(file: ConnectorRecoveryFile) {
  if (!file || file.name !== 'vaulted-connector-recovery' || file.version !== 1)
    throw new Error('Invalid connector recovery file')
  const header = validateRecoveryHeader(file.header)
  if (header.binding.templateVersion !== CONNECTOR_TEMPLATE)
    throw new Error('Connector recovery needs its enrolled contract')
  return validateConnectorRecoveryRecord(
    { vaultId: header.binding.vaultId, enrollmentDigest: header.status.connectorEnrollment!.enrollmentDigest },
    file.record,
  )
}
export function connectorRecoveryHandoff(file: ConnectorRecoveryFile) {
  const view = validateConnectorRecoveryFile(file)
  if (!view.record.savingsWitness)
    throw new Error('This saved operation still needs its existing Guardian and Emulator approval')
  return view.prepared.forHardware(view.record.savingsWitness.map((item) => hex.decode(item))).psbt()
}
export function acceptConnectorRecoverySignature(file: ConnectorRecoveryFile, psbt: string): ConnectorRecoveryFile {
  const view = validateConnectorRecoveryFile(file)
  if (!view.record.savingsWitness) throw new Error('Missing Savings approval')
  const signed = view.prepared.forHardware(view.record.savingsWitness.map((item) => hex.decode(item))).accept(psbt)
  const result: ConnectorRecoveryFile = {
    ...file,
    record: { ...file.record, signaturesMayHaveIssued: true, signedTxHex: signed.txHex, txid: signed.txid },
  }
  validateConnectorRecoveryFile(result)
  return result
}
export async function executeConnectorRecovery(value: ConnectorRecoveryFile, chain: SavingsRecoveryChain) {
  const file = JSON.parse(JSON.stringify(value)) as ConnectorRecoveryFile
  const view = validateConnectorRecoveryFile(file)
  if (!view.record.signedTxHex || !view.record.txid) throw new Error('The required connector signature is missing')
  for (const coin of [view.record.savings, view.record.reserve]) {
    const spent = await chain.outspend(coin.txid, coin.vout)
    if (spent.spent) {
      if (spent.txid !== view.record.txid)
        throw new Error('A connector input is spent by another transaction; retain this file')
      const status = await chain.status(view.record.txid)
      return { txid: view.record.txid, confirmed: status.confirmed }
    }
  }
  const txid = await chain.broadcast(view.record.signedTxHex)
  if (txid !== view.record.txid) throw new Error('Connector broadcast outcome is uncertain; retain this file')
  return { txid, confirmed: false }
}
