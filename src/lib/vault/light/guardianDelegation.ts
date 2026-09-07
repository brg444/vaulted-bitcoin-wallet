import { RestArkProvider, RestIndexerProvider, type ArkInfo } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { networkPins } from '../networkPins'
import { browserVaultLockManager, requireVaultLockManager } from '../vtxo/lock'
import { lightDescriptorDigest, validateLightDescriptor, type LightDescriptor } from './contract'
import { prepareGuardianDelegation, validateGuardianSchedule } from './delegationRequest'
import {
  guardianDelegateInfo,
  guardianDelegatePost,
  guardianDelegationTerminal,
  guardianReadRequest,
  listGuardianDelegations,
  validateGuardianDelegationStatus,
  requireStatusMatchesRequest,
  withoutRecovery,
  type GuardianReadRequest,
} from './delegationClient'
import {
  loadGuardianDelegations,
  saveGuardianDelegations,
  type GuardianDelegationJournal,
  type GuardianDelegationStatus,
} from './delegationStore'
import { importGuardianReplacement } from './delegationRecovery'
import { captureLightRecoveryArchive, loadLightRecoveryArchive, validateLightRecoveryArchive } from './recoveryArchive'
import { requireGuardianInputAncestry } from './delegationEligibility'
import { listPersistedVtxoSpends } from '../vtxo/spend'

const reads = new Map<string, Map<string, GuardianReadRequest>>()
const readEpoch = new Map<string, number>()
export function clearGuardianDelegationReads(vaultId: string) {
  reads.delete(vaultId)
  readEpoch.set(vaultId, (readEpoch.get(vaultId) || 0) + 1)
}
const point = (coin: { txid: string; vout: number }) => `${coin.txid}:${coin.vout}`
function assertResponse(journal: GuardianDelegationJournal, response: GuardianDelegationStatus) {
  const saved = journal.operations[response.operationId]
  if (saved?.plan) {
    requireStatusMatchesRequest(response, saved.plan.request)
    if (
      response.txid !== saved.plan.txid ||
      response.vout !== saved.plan.vout ||
      response.inputValueSats !== saved.plan.valueSats ||
      response.receiverSats !== saved.plan.receiverSats
    )
      throw new Error('Guardian renewal changed the authorized output')
  }
  if (saved?.status) {
    const prior = saved.status
    if (
      ['txid', 'vout', 'validAt', 'expiresAt', 'inputValueSats', 'receiverSats', 'descriptorHash'].some(
        (key) => prior[key as keyof typeof prior] !== response[key as keyof typeof response],
      )
    )
      throw new Error('Guardian renewal identity changed')
    if (guardianDelegationTerminal(prior.state) && response.state !== prior.state)
      throw new Error('Guardian renewal history moved backward')
    for (const key of ['commitmentTxid', 'receiverTxid', 'receiverVout', 'receiverExpiresAt'] as const)
      if (prior[key] !== undefined && prior[key] !== response[key])
        throw new Error('Guardian replacement identity changed')
  }
}
function rememberStatus(journal: GuardianDelegationJournal, response: GuardianDelegationStatus) {
  assertResponse(journal, response)
  journal.operations[response.operationId] = {
    ...journal.operations[response.operationId],
    status: withoutRecovery(response),
    checkedAt: new Date().toISOString(),
  }
}
async function retryPending(d: LightDescriptor, journal: GuardianDelegationJournal, errors: string[]) {
  for (const saved of Object.values(journal.operations)) {
    if (!saved.plan || saved.status) continue
    try {
      validateGuardianSchedule(saved.plan.request, d)
      // Never rebuild an ambiguous submission, including after its dispatch window.
      const result = validateGuardianDelegationStatus(
        await guardianDelegatePost('schedule', saved.plan.request),
        d,
        saved.plan.request.operationId,
      )
      rememberStatus(journal, result)
      await saveGuardianDelegations(d, journal)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Renewal submission is awaiting reconciliation')
    }
  }
}
async function checkedInputs(d: LightDescriptor) {
  const indexer = new RestIndexerProvider(networkPins(d.network).operatorOrigin)
  const result = await indexer.getVtxos({ scripts: [d.scriptPubKey] })
  const coins = result.vtxos.filter((c) => !c.isSpent && !c.isSwept && !c.isUnrolled)
  if (coins.length > 512) throw new Error('Too many outputs to authorize renewal safely')
  return { indexer, coins }
}
async function refreshOperation(
  d: LightDescriptor,
  journal: GuardianDelegationJournal,
  auth: GuardianReadRequest,
  info?: ArkInfo,
) {
  const response = validateGuardianDelegationStatus(await guardianDelegatePost('status', auth), d, auth.operationId)
  assertResponse(journal, response)
  if (response.state === 'confirmed' && !journal.operations[response.operationId]?.recoveryImported) {
    const pins = networkPins(d.network)
    const indexer = new RestIndexerProvider(pins.operatorOrigin)
    if (!response.receiverTxid || response.receiverVout === undefined)
      throw new Error('Guardian has not supplied replacement output identity')
    const { vtxos } = await indexer.getVtxos({
      outpoints: [{ txid: response.receiverTxid, vout: response.receiverVout }],
    })
    const coin = vtxos.find((c) => c.txid === response.receiverTxid && c.vout === response.receiverVout)
    if (!coin) throw new Error('Replacement output is not yet available from the indexer')
    await importGuardianReplacement(
      d,
      response,
      info || (await new RestArkProvider(pins.operatorOrigin).getInfo()),
      coin,
      true,
    )
    await captureLightRecoveryArchive(d)
    journal.operations[response.operationId] = { ...journal.operations[response.operationId], recoveryImported: true }
  }
  rememberStatus(journal, response)
  await saveGuardianDelegations(d, journal)
}

/** Existing owner ceremony only: no passkey call, secret storage, or worker signing. */
export async function authorizeGuardianRenewals(
  descriptor: LightDescriptor,
  ownerKey: Uint8Array,
  excluded: ReadonlySet<string> = new Set(),
): Promise<GuardianDelegationJournal | null> {
  const d = validateLightDescriptor(descriptor),
    owner = Uint8Array.from(ownerKey)
  const epoch = readEpoch.get(d.vaultId) || 0
  try {
    if (hex.encode(schnorr.getPublicKey(owner)) !== d.ownerPub) throw new Error('Guardian renewal owner changed')
    const locks = requireVaultLockManager(browserVaultLockManager())
    return await locks.request(`vaulted-light:delegation:${d.vaultId}`, { mode: 'exclusive' }, async () => {
      const journal = await loadGuardianDelegations(d)
      const errors: string[] = []
      const deadline = Date.now() + 30000
      try {
        journal.available = false
        const capability = await guardianDelegateInfo(d)
        journal.available = true
        const info = await new RestArkProvider(networkPins(d.network).operatorOrigin).getInfo()
        const { coins, indexer } = await checkedInputs(d)
        const archive = await loadLightRecoveryArchive(d).catch(() => null)
        const archived = archive ? validateLightRecoveryArchive(archive, d).coins : []
        const liveCovered = coins.every((coin) =>
          archived.some(
            (saved) => point(saved) === point(coin) && saved.value === coin.value && saved.script === coin.script,
          ),
        )
        const hasArchivedReplacement = (s: GuardianDelegationStatus) =>
          archived.some(
            (coin) =>
              coin.txid === s.receiverTxid &&
              coin.vout === s.receiverVout &&
              coin.value === s.receiverSats &&
              coin.commitmentTxIds?.includes(s.commitmentTxid!) &&
              (s.receiverExpiresAt === undefined || coin.expiresAt?.getTime() === s.receiverExpiresAt * 1000),
          )
        const live = new Set(coins.map(point)),
          spent = new Set<string>()
        const remote = await listGuardianDelegations(d, owner, async (page) => {
          // Keep history bounded by relevant outputs, not the wallet's lifetime.
          // Missing, swept, or unrolled outputs are not positive spend evidence.
          const missing = page.filter(
            (s) =>
              s.state === 'confirmed' &&
              s.receiverTxid &&
              s.receiverVout !== undefined &&
              !live.has(`${s.receiverTxid}:${s.receiverVout}`),
          )
          if (missing.length) {
            const result = await indexer.getVtxos({
              outpoints: missing.map((s) => ({ txid: s.receiverTxid!, vout: s.receiverVout! })),
            })
            for (const coin of result.vtxos) if (coin.isSpent) spent.add(point(coin))
          }
          for (const operation of page)
            if (journal.operations[operation.operationId]) rememberStatus(journal, operation)
          return page.filter(
            (s) =>
              !guardianDelegationTerminal(s.state) ||
              (s.state === 'confirmed' &&
                !hasArchivedReplacement(s) &&
                !(liveCovered && spent.has(`${s.receiverTxid}:${s.receiverVout}`))),
          )
        })
        for (const [id, saved] of Object.entries(journal.operations)) {
          const s = saved.status
          if (
            s &&
            guardianDelegationTerminal(s.state) &&
            (s.state !== 'confirmed' ||
              hasArchivedReplacement(s) ||
              (liveCovered && spent.has(`${s.receiverTxid}:${s.receiverVout}`)))
          )
            delete journal.operations[id]
        }
        const sessions = new Map<string, GuardianReadRequest>()
        if ((readEpoch.get(d.vaultId) || 0) !== epoch) throw new Error('Wallet locked during renewal authorization')
        reads.set(d.vaultId, sessions)
        for (const operation of remote) {
          rememberStatus(journal, operation)
          const auth = guardianReadRequest(d, operation.operationId, owner)
          sessions.set(operation.operationId, auth)
          if (operation.state === 'confirmed' && !journal.operations[operation.operationId].recoveryImported) {
            try {
              await refreshOperation(d, journal, auth, info)
              if (journal.operations[operation.operationId]?.recoveryImported) {
                delete journal.operations[operation.operationId]
                sessions.delete(operation.operationId)
              }
            } catch (error) {
              errors.push(error instanceof Error ? error.message : 'Replacement recovery paths are pending')
            }
          }
        }
        // Save discoveries before preparing any new owner signature.
        await saveGuardianDelegations(d, journal)
        await retryPending(d, journal, errors)
        const reserved = new Set(
          listPersistedVtxoSpends(d.vaultId).flatMap((spend) => (spend.reservedInputs || []).map(point)),
        )
        for (const coin of coins) {
          if ((readEpoch.get(d.vaultId) || 0) !== epoch) break
          if (Date.now() >= deadline) {
            errors.push('More outputs will be checked at the next normal unlock')
            break
          }
          if (
            excluded.has(point(coin)) ||
            reserved.has(point(coin)) ||
            !coin.commitmentTxIds?.length ||
            !coin.expiresAt ||
            coin.expiresAt.getTime() < Date.now() + 300000 ||
            coin.assets?.length
          )
            continue
          const existing = Object.values(journal.operations).some((saved) => {
            const input = saved.plan || saved.status
            return (
              input &&
              point(input) === point(coin) &&
              (!saved.status || !guardianDelegationTerminal(saved.status.state) || saved.status.state === 'confirmed')
            )
          })
          if (existing) continue
          try {
            await requireGuardianInputAncestry(d, coin, info, indexer)
            const plan = await prepareGuardianDelegation(d, coin, info, capability, owner)
            journal.operations[plan.request.operationId] = { plan }
            await saveGuardianDelegations(d, journal)
            const response = validateGuardianDelegationStatus(
              await guardianDelegatePost('schedule', plan.request),
              d,
              plan.request.operationId,
            )
            rememberStatus(journal, response)
            sessions.set(plan.request.operationId, guardianReadRequest(d, plan.request.operationId, owner))
            await saveGuardianDelegations(d, journal)
          } catch (error) {
            errors.push(error instanceof Error ? error.message : 'An output could not yet be authorized')
          }
        }
        journal.checkedAt = new Date().toISOString()
        journal.error = errors.length ? errors[0] : undefined
      } catch (error) {
        journal.error = error instanceof Error ? error.message : 'Automatic renewal could not be updated'
        if (journal.available === undefined) journal.available = false
      }
      await saveGuardianDelegations(d, journal)
      return journal
    })
  } catch {
    return null
  } finally {
    owner.fill(0)
    if ((readEpoch.get(d.vaultId) || 0) !== epoch) reads.delete(d.vaultId)
  }
}

/** Uses only previously signed requests; expiry of read authorization never releases an input. */
export async function refreshGuardianRenewals(d: LightDescriptor): Promise<GuardianDelegationJournal | null> {
  try {
    const locks = requireVaultLockManager(browserVaultLockManager())
    return await locks.request(`vaulted-light:delegation:${d.vaultId}`, { mode: 'exclusive' }, async () => {
      const journal = await loadGuardianDelegations(d)
      const errors: string[] = []
      try {
        await retryPending(d, journal, errors)
        for (const [id, auth] of reads.get(d.vaultId) || []) {
          if (auth.expiresAt <= Math.floor(Date.now() / 1000)) {
            reads.get(d.vaultId)?.delete(id)
            continue
          }
          try {
            await refreshOperation(d, journal, auth)
            journal.checkedAt = new Date().toISOString()
          } catch (error) {
            errors.push(error instanceof Error ? error.message : 'Renewal status could not be checked')
          }
        }
        journal.error = errors.length ? errors[0] : undefined
      } catch (error) {
        journal.error = error instanceof Error ? error.message : 'Automatic renewal could not be updated'
      }
      await saveGuardianDelegations(d, journal)
      return journal
    })
  } catch {
    return null
  }
}
export function guardianRenewalCoverage(
  d: LightDescriptor,
  journal: GuardianDelegationJournal | null,
  coins: { txid: string; vout: number }[],
  now = Date.now(),
) {
  const valid = journal && journal.descriptorHash === lightDescriptorDigest(d) ? journal : null
  const covered = new Set<string>(),
    running = new Set<string>(),
    cleanup = new Set<string>()
  for (const saved of Object.values(valid?.operations || {})) {
    const s = saved.status
    if (!s || guardianDelegationTerminal(s.state)) continue
    if (s.state === 'armed' && s.expiresAt * 1000 > now) covered.add(point(s))
    else if (s.state === 'cleanup_pending') cleanup.add(point(s))
    else if (s.state !== 'armed') running.add(point(s))
  }
  const total = coins.length
  const scheduled = coins.filter((c) => covered.has(point(c))).length
  const renewing = coins.filter((c) => running.has(point(c))).length
  const cancelling = coins.filter((c) => cleanup.has(point(c))).length
  return {
    total,
    scheduled,
    renewing,
    cancelling,
    pending: Math.max(0, total - scheduled - renewing - cancelling),
    checkedAt: valid?.checkedAt,
    error: valid?.error,
    available: valid?.available === true,
  }
}
