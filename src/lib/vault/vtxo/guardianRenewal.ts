import { RestArkProvider, RestIndexerProvider, type ArkInfo } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import type { VaultStatus } from '../types'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import { networkPins } from '../networkPins'
import { LIGHT_PROFILE } from '../light/contract'
import { withoutRecovery } from '../light/delegationClient'
import { captureVaultRecoveryFile } from '../recovery/capture'
import { validateExitArchive } from '../recovery/exitArchive'
import { kitFromFacts } from '../program/kitBackup'
import { browserVaultLockManager, requireVaultLockManager } from './lock'
import { listPersistedVtxoSpends, type VtxoSpendPasskey } from './spend'
import { guardianRenewalContext } from './renewalContext'
import { prepareSpendingDelegation, type SpendingDelegationPlan } from './renewalRequest'
import { signSpendingRenewalSet } from './renewalSet'
import { loadSpendingRenewals, saveSpendingRenewals, type SpendingRenewalJournal } from './renewalStore'
import {
  guardianDelegationTerminal,
  listSpendingRenewals,
  requireSpendingRenewalMatchesPlan,
  spendingRenewalInfo,
  spendingRenewalPost,
  spendingRenewalRead,
  submitSpendingRenewalSet,
  validateSpendingRenewalStatus,
  type SpendingRenewalRead,
  type SpendingRenewalStatus,
} from './renewalClient'
import { importSpendingRenewalReplacement, requireSpendingRenewalAncestry } from './renewalRecovery'
import { loadVaultRecoveryArchive, vaultRecoveryBinding } from './recoveryArchive'

const reads = new Map<string, Map<string, SpendingRenewalRead>>()
const epochs = new Map<string, number>()
const point = (v: { txid: string; vout: number }) => `${v.txid}:${v.vout}`
export function clearSpendingRenewalReads(vaultId: string) {
  reads.delete(vaultId)
  epochs.set(vaultId, (epochs.get(vaultId) || 0) + 1)
}
function remember(journal: SpendingRenewalJournal, result: SpendingRenewalStatus, status: VaultStatus) {
  const saved = journal.operations[result.operationId]
  if (saved?.plan) requireSpendingRenewalMatchesPlan(result, saved.plan.request, status)
  const prior = saved?.status
  if (prior) {
    for (const key of [
      'program',
      'descriptorHash',
      'txid',
      'vout',
      'validAt',
      'expiresAt',
      'inputValueSats',
      'receiverSats',
    ] as const)
      if (prior[key] !== result[key]) throw new Error('Renewal history identity changed')
    if (guardianDelegationTerminal(prior.state) && prior.state !== result.state)
      throw new Error('Renewal history moved backward')
    for (const key of ['commitmentTxid', 'receiverTxid', 'receiverVout', 'receiverExpiresAt'] as const)
      if (prior[key] !== undefined && prior[key] !== result[key])
        throw new Error('Renewal replacement identity changed')
  }
  journal.operations[result.operationId] = { ...saved, status: withoutRecovery(result) as SpendingRenewalStatus }
}
function pruneSets(journal: SpendingRenewalJournal) {
  for (const [id, set] of Object.entries(journal.sets))
    if (set.plans.every((p) => journal.operations[p.operationId]?.status)) delete journal.sets[id]
}
async function retrySets(status: VaultStatus, journal: SpendingRenewalJournal, errors: string[]) {
  for (const set of Object.values(journal.sets)) {
    try {
      for (const result of await submitSpendingRenewalSet(set, status)) remember(journal, result, status)
      pruneSets(journal)
      await saveSpendingRenewals(status, journal)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Renewal submission needs reconciliation')
    }
  }
}
async function refreshOperation(
  status: VaultStatus,
  enrollment: EnrollmentSecrets,
  journal: SpendingRenewalJournal,
  auth: SpendingRenewalRead,
  info?: ArkInfo,
) {
  const result = validateSpendingRenewalStatus(await spendingRenewalPost('status', auth), status, auth.operationId)
  remember(journal, result, status)
  if (result.state === 'confirmed' && !journal.operations[result.operationId].recoveryImported) {
    if (!result.receiverTxid || result.receiverVout === undefined)
      throw new Error('Renewal replacement identity is unavailable')
    const origin = networkPins(status.network).operatorOrigin
    const { vtxos } = await new RestIndexerProvider(origin).getVtxos({
      outpoints: [{ txid: result.receiverTxid, vout: result.receiverVout }],
    })
    const coin = vtxos.find((v) => v.txid === result.receiverTxid && v.vout === result.receiverVout)
    if (!coin) throw new Error('Renewal replacement is not yet available from the indexer')
    await importSpendingRenewalReplacement(status, result, info || (await new RestArkProvider(origin).getInfo()), coin)
    await captureVaultRecoveryFile(status, enrollment)
    journal.operations[result.operationId].recoveryImported = true
  }
  await saveSpendingRenewals(status, journal)
}

/** One unconsumed local-unlock assertion or fresh renewal-setup ceremony. Never a payment assertion. */
export async function authorizeSpendingRenewals(
  status: VaultStatus,
  enrollment: EnrollmentSecrets,
  auth: VtxoSpendPasskey,
  canAuthorizeNew = true,
): Promise<SpendingRenewalJournal | null> {
  if (status.templateVersion === LIGHT_PROFILE) throw new Error('Light retains its existing renewal lifecycle')
  const context = guardianRenewalContext(status),
    owner = Uint8Array.from(auth.phoneSecret)
  const epoch = epochs.get(status.vaultId) || 0
  try {
    if (hex.encode(schnorr.getPublicKey(owner)) !== context.ownerPub) throw new Error('Renewal owner changed')
    return await requireVaultLockManager(browserVaultLockManager()).request(
      `vaulted:renewal:${status.vaultId}`,
      { mode: 'exclusive' },
      async () => {
        const journal = await loadSpendingRenewals(status),
          errors: string[] = []
        try {
          journal.available = false
          const capability = await spendingRenewalInfo(status)
          journal.available = true
          const origin = networkPins(status.network).operatorOrigin,
            indexer = new RestIndexerProvider(origin)
          const info = await new RestArkProvider(origin).getInfo()
          const { vtxos } = await indexer.getVtxos({ scripts: [context.scriptPubKey] })
          const coins = vtxos.filter((c) => !c.isSpent && !c.isSwept && !c.isUnrolled)
          if (coins.length > 512) throw new Error('Too many outputs for bounded renewal authorization')
          const kit = kitFromFacts({ status, enrollment })
          if (!kit) throw new Error('Renewal recovery descriptor unavailable')
          const archive = await loadVaultRecoveryArchive(kit, status)
          const archived = archive ? validateExitArchive(archive.spending, vaultRecoveryBinding(kit, status)).coins : []
          // A spent renewal may still be an ancestor of current change. Spending
          // alone is insufficient; the complete current outputs must be archived.
          const liveCovered = coins.every((coin) =>
            archived.some(
              (saved) => point(saved) === point(coin) && saved.value === coin.value && saved.script === coin.script,
            ),
          )
          const live = new Set(coins.map(point)),
            spent = new Set<string>()
          const archivedReplacement = (s: SpendingRenewalStatus) =>
            archived.some(
              (c) =>
                c.txid === s.receiverTxid &&
                c.vout === s.receiverVout &&
                c.value === s.receiverSats &&
                c.commitmentTxIds?.includes(s.commitmentTxid!) &&
                (s.receiverExpiresAt === undefined || c.expiresAt?.getTime() === s.receiverExpiresAt * 1000),
            )
          const remote = await listSpendingRenewals(status, owner, async (page) => {
            const missing = page.filter(
              (s) =>
                s.state === 'confirmed' &&
                s.receiverTxid &&
                s.receiverVout !== undefined &&
                !live.has(`${s.receiverTxid}:${s.receiverVout}`),
            )
            if (missing.length)
              for (const c of (
                await indexer.getVtxos({
                  outpoints: missing.map((s) => ({ txid: s.receiverTxid!, vout: s.receiverVout! })),
                })
              ).vtxos)
                if (c.isSpent) spent.add(point(c))
            for (const result of page) if (journal.operations[result.operationId]) remember(journal, result, status)
            return page.filter(
              (s) =>
                !guardianDelegationTerminal(s.state) ||
                (s.state === 'confirmed' &&
                  !archivedReplacement(s) &&
                  !(liveCovered && spent.has(`${s.receiverTxid}:${s.receiverVout}`))),
            )
          })
          pruneSets(journal)
          const pendingSetIds = new Set(Object.values(journal.sets).flatMap((s) => s.plans.map((p) => p.operationId)))
          for (const [id, saved] of Object.entries(journal.operations))
            if (
              saved.status &&
              !pendingSetIds.has(id) &&
              guardianDelegationTerminal(saved.status.state) &&
              (saved.status.state !== 'confirmed' ||
                archivedReplacement(saved.status) ||
                (liveCovered && spent.has(`${saved.status.receiverTxid}:${saved.status.receiverVout}`)))
            )
              delete journal.operations[id]
          if ((epochs.get(status.vaultId) || 0) !== epoch) throw new Error('Wallet locked during renewal authorization')
          const sessions = new Map<string, SpendingRenewalRead>()
          reads.set(status.vaultId, sessions)
          for (const result of remote) {
            remember(journal, result, status)
            const read = spendingRenewalRead(status, result.operationId, owner)
            sessions.set(result.operationId, read)
            if (result.state === 'confirmed')
              try {
                await refreshOperation(status, enrollment, journal, read, info)
              } catch (error) {
                errors.push(error instanceof Error ? error.message : 'Renewal recovery capture pending')
              }
          }
          await saveSpendingRenewals(status, journal)
          await retrySets(status, journal, errors)
          const reserved = new Set(
            listPersistedVtxoSpends(status.vaultId).flatMap((s) => (s.reservedInputs || []).map(point)),
          )
          const plans: SpendingDelegationPlan[] = [],
            deadline = Date.now() + 30000
          for (const coin of coins) {
            if (!canAuthorizeNew) break
            if ((epochs.get(status.vaultId) || 0) !== epoch || Date.now() > deadline || plans.length === 50) break
            if (
              reserved.has(point(coin)) ||
              coin.assets?.length ||
              !coin.expiresAt ||
              coin.expiresAt.getTime() < Date.now() + 300000 ||
              !coin.commitmentTxIds?.length
            )
              continue
            if (
              Object.values(journal.operations).some((s) => {
                const input = s.plan || s.status
                return (
                  input &&
                  point(input) === point(coin) &&
                  (!s.status || !guardianDelegationTerminal(s.status.state) || s.status.state === 'confirmed')
                )
              })
            )
              continue
            try {
              await requireSpendingRenewalAncestry(status, coin, info, indexer)
              const plan = await prepareSpendingDelegation(status, coin, info, capability, owner)
              if (JSON.stringify([...plans, plan]).length > 900000) break
              plans.push(plan)
            } catch (error) {
              errors.push(error instanceof Error ? error.message : 'Output authorization pending')
            }
          }
          if (plans.length && (epochs.get(status.vaultId) || 0) === epoch) {
            const set = signSpendingRenewalSet(
              status,
              plans.map((p) => p.request),
              { ...auth, phoneSecret: owner },
            )
            journal.sets[set.setId] = set
            for (const plan of plans) {
              journal.operations[plan.request.operationId] = { plan }
              sessions.set(plan.request.operationId, spendingRenewalRead(status, plan.request.operationId, owner))
            }
            await saveSpendingRenewals(status, journal)
            await retrySets(status, journal, errors)
          }
          journal.checkedAt = new Date().toISOString()
        } catch (error) {
          errors.push(error instanceof Error ? error.message : 'Automatic renewal unavailable')
        }
        journal.error = errors[0]
        await saveSpendingRenewals(status, journal)
        return journal
      },
    )
  } finally {
    owner.fill(0)
    if ((epochs.get(status.vaultId) || 0) !== epoch) reads.delete(status.vaultId)
  }
}

export async function refreshSpendingRenewals(status: VaultStatus, enrollment: EnrollmentSecrets) {
  return requireVaultLockManager(browserVaultLockManager()).request(
    `vaulted:renewal:${status.vaultId}`,
    { mode: 'exclusive' },
    async () => {
      const journal = await loadSpendingRenewals(status),
        errors: string[] = []
      await retrySets(status, journal, errors)
      for (const [id, auth] of reads.get(status.vaultId) || []) {
        if (auth.expiresAt <= Math.floor(Date.now() / 1000)) {
          reads.get(status.vaultId)?.delete(id)
          continue
        }
        try {
          await refreshOperation(status, enrollment, journal, auth)
        } catch (error) {
          errors.push(error instanceof Error ? error.message : 'Renewal reconciliation pending')
        }
      }
      journal.error = errors[0]
      journal.checkedAt = new Date().toISOString()
      await saveSpendingRenewals(status, journal)
      return journal
    },
  )
}
