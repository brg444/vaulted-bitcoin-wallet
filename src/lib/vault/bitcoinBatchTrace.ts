import type { Wallet } from '@arkade-os/sdk'
import { consoleError, consoleLog } from '../logs'

type Handler = ReturnType<Wallet['createBatchHandler']>

/** Observe completed SDK phases, not merely receipt of a broadcast event. */
export function traceBitcoinBatch(handler: Handler): Handler {
  const start = handler.onBatchStarted
  handler.onBatchStarted = async (event) => {
    consoleLog(`Bitcoin batch ${event.id}: checking participation`)
    try {
      const decision = await start(event)
      consoleLog(`Bitcoin batch ${event.id}: ${decision.skip ? 'not selected' : 'participation acknowledged'}`)
      return decision
    } catch (error) {
      consoleError(error, `Bitcoin batch ${event.id}: participation failed`)
      throw error
    }
  }
  const signing = handler.onTreeSigningStarted
  handler.onTreeSigningStarted = async (event, tree) => {
    consoleLog(`Bitcoin batch ${event.id}: validating tree (${tree.nbOfNodes()} transactions)`)
    try {
      const decision = await signing(event, tree)
      consoleLog(`Bitcoin batch ${event.id}: ${decision.skip ? 'signer not selected' : 'tree nonces submitted'}`)
      return decision
    } catch (error) {
      consoleError(error, `Bitcoin batch ${event.id}: tree signing failed`)
      throw error
    }
  }
  const nonces = handler.onTreeNonces
  handler.onTreeNonces = async (event) => {
    try {
      const decision = await nonces(event)
      if (decision.fullySigned) consoleLog(`Bitcoin batch ${event.id}: tree signatures submitted`)
      return decision
    } catch (error) {
      consoleError(error, `Bitcoin batch ${event.id}: nonce aggregation or signature submission failed`)
      throw error
    }
  }
  const final = handler.onBatchFinalization
  handler.onBatchFinalization = async (...args) => {
    consoleLog(`Bitcoin batch ${args[0].id}: finalization started`)
    try {
      await final(...args)
      consoleLog(`Bitcoin batch ${args[0].id}: finalization submitted`)
    } catch (error) {
      consoleError(error, `Bitcoin batch ${args[0].id}: finalization failed`)
      throw error
    }
  }
  return handler
}
