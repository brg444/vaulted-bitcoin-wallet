import './LedgerRecovery.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { fetchAddressUtxos, fetchTxHex, fetchTipHeight, broadcastTx, type EsploraUtxo } from '../../lib/vault/esplora'
import { readBounded } from '../../lib/vault/bounded'
import { loadEnrollment } from '../../lib/vault/enrollmentStore'
import { unlockLedgerSavingsSeed } from '../../lib/vault/savingsSpend'
import { connectLedgerSavings } from '../../lib/vault/ledgerClient'
import {
  approveLedgerRecovery,
  discardUnsignedLedgerRecoveryRecord,
  exportLedgerRecoveryJournal,
  saveLedgerRecoveryRecord,
  saveLedgerStandaloneRecovery,
  validateLedgerRecoveryRecord,
  type LedgerRecoveryRecord,
} from '../../lib/vault/ledgerRecoveryWallet'
import {
  inspectLedgerRecoveryTransition,
  requireLedgerRecoveryUserApproval,
  type LedgerRecoveryAction,
} from '../../lib/vault/ledgerRecovery'
import { canonicalLedgerValue } from '../../lib/vault/program/ledgerEnrollment'
import { signLedgerSavingsRecoveryWithDevice } from '../../lib/vault/program/ledgerRecoveryDevice'
import {
  prepareSavingsRecovery,
  signLedgerSavingsRecoveryWithSeed,
  acceptSavingsRecoverySignature,
  validateSavingsRecovery,
  executeSavingsRecovery,
  type SavingsRecoveryFile,
  type SavingsRecoveryPath,
} from '../../lib/vault/program/onchainRecovery'
import type { LedgerRecoveryKit } from '../../lib/vault/program/kit'
import type { Claimant } from '../../lib/vault/program/constants'
import type { VaultStatus } from '../../lib/vault/types'
import QgScreen, { QgPrimary, QgSecondary } from './qg/QgScreen'

const download = (body: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'Vaulted Ledger recovery.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function json(path: string) {
  const response = await fetch(`/esplora${path}`, { cache: 'no-store' })
  const text = await readBounded(response)
  if (!response.ok) throw new Error('Bitcoin recovery status unavailable')
  return JSON.parse(text)
}
const chain = {
  status: async (id: string) => {
    const s = await json(`/tx/${id}/status`)
    return { confirmed: s.confirmed, blockHeight: s.block_height }
  },
  tipHeight: fetchTipHeight,
  outspend: (id: string, vout: number) => json(`/tx/${id}/outspend/${vout}`),
  broadcast: broadcastTx,
}

/** Explicit native Ledger route. Legacy and connector recovery retain their existing planners. */
export default function LedgerRecovery({
  kit,
  status,
  back,
}: {
  kit: LedgerRecoveryKit
  status: VaultStatus
  back: () => void
}) {
  const [mode, setMode] = useState('initiate')
  const [claimant, setClaimant] = useState<Claimant>('hardware')
  const [acting, setActing] = useState<Claimant>('phone')
  const [change, setChange] = useState<0 | 1>(0)
  const [coins, setCoins] = useState<EsploraUtxo[]>([])
  const [coinIndex, setCoinIndex] = useState(0)
  const [destination, setDestination] = useState('')
  const [fee, setFee] = useState('500')
  const [record, setRecord] = useState<LedgerRecoveryRecord>()
  const [standalone, setStandalone] = useState<SavingsRecoveryFile>()
  const [imported, setImported] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef(false)
  const lifetime = useMemo(() => ({ controller: new AbortController() }), [kit.descriptorHash, status.vaultId])
  const operation = useRef<AbortSignal>()
  useEffect(() => {
    if (lifetime.controller.signal.aborted) lifetime.controller = new AbortController()
    const controller = lifetime.controller
    return () => controller.abort(new Error('Recovery screen closed or wallet changed'))
  }, [lifetime])
  const signal = () => operation.current || lifetime.controller.signal
  const live = () => signal().throwIfAborted()
  const roles =
    kit.protectionTier === 'advanced' ? (['phone', 'hardware', 'recovery'] as const) : (['phone', 'hardware'] as const)
  const source =
    mode === 'initiate' || mode === 'savings-admin'
      ? change === 0
        ? kit.descriptor.savings
        : kit.descriptor.savingsChange
      : (mode === 'quarantine' ? kit.descriptor.quarantine : kit.descriptor.pending)[`savings-${claimant}`]
  const saved = useMemo(() => {
    try {
      return exportLedgerRecoveryJournal(kit.descriptor.ledgerSavings)
    } catch {
      return { records: [], standalone: [] }
    }
  }, [kit, record, standalone])
  const review = record
    ? inspectLedgerRecoveryTransition(record.transition)
    : standalone
      ? validateSavingsRecovery(standalone)
      : null
  const allowedActors = standalone ? validateSavingsRecovery(standalone).signers : roles.filter((r) => r !== claimant)
  const signingRole = allowedActors.includes(acting) ? acting : allowedActors[0]
  const complete = record ? Boolean(record.txHex) : standalone ? validateSavingsRecovery(standalone).complete : false
  async function run(action: () => Promise<void>) {
    if (active.current) return
    operation.current = lifetime.controller.signal
    active.current = true
    setBusy(true)
    setError('')
    try {
      live()
      await action()
    } catch (e) {
      if (!signal().aborted) setError(e instanceof Error ? e.message : 'Recovery failed')
    } finally {
      active.current = false
      if (!signal().aborted) setBusy(false)
    }
  }
  const enrollment = () => loadEnrollment(localStorage, status.vaultId) || undefined
  async function prepare() {
    const coin = coins[coinIndex]
    if (!coin) throw new Error('Choose a confirmed Bitcoin output')
    const parentHex = await fetchTxHex(coin.txid)
    live()
    const parent = Transaction.fromRaw(hex.decode(parentHex))
    if (parent.id !== coin.txid || parent.getOutput(coin.vout).amount !== BigInt(coin.value))
      throw new Error('Bitcoin parent changed')
    if (mode === 'initiate' || mode === 'clawback') {
      const action: LedgerRecoveryAction =
        mode === 'initiate'
          ? { kind: mode, claimant, change }
          : { kind: mode, claimant, remainingUser: signingRole, change: 0 }
      const next = await saveLedgerRecoveryRecord({
        version: 1,
        transition: {
          contract: kit.descriptor.ledgerSavings,
          action,
          coin: { txid: coin.txid, vout: coin.vout, value: coin.value, parentTxHex: parentHex },
          feeSats: Number(fee),
        },
      })
      live()
      setRecord(next)
      setStandalone(undefined)
    } else {
      const path: SavingsRecoveryPath =
        mode === 'savings-admin'
          ? { program: mode, change }
          : { program: mode as 'pending-claim' | 'pending-cancel' | 'quarantine', claimant }
      setStandalone(
        await saveLedgerStandaloneRecovery(
          prepareSavingsRecovery({ kit, path, parentHex, vout: coin.vout, destination, feeSats: Number(fee) }),
        ),
      )
      setRecord(undefined)
    }
  }
  async function approve() {
    if (record) {
      const result = await approveLedgerRecovery(record, status, enrollment(), undefined, signal())
      live()
      setRecord(result)
      return
    }
    if (!standalone) throw new Error('Review the recovery transaction first')
    if (signingRole === 'phone') {
      const saved = enrollment()
      if (!saved) throw new Error('Original passkey enrollment required')
      const seed = await unlockLedgerSavingsSeed(saved, status)
      try {
        live()
        const next = await saveLedgerStandaloneRecovery(signLedgerSavingsRecoveryWithSeed(standalone, seed))
        live()
        setStandalone(next)
      } finally {
        seed.fill(0)
      }
    } else {
      const device = await connectLedgerSavings()
      try {
        live()
        const next = await saveLedgerStandaloneRecovery(
          await signLedgerSavingsRecoveryWithDevice(device.app, standalone, signingRole, signal()),
        )
        live()
        setStandalone(next)
      } finally {
        await device.close()
      }
    }
  }
  async function broadcast() {
    if (standalone) {
      live()
      download(standalone)
      const guarded = {
        status: async (id: string) => {
          live()
          const result = await chain.status(id)
          live()
          return result
        },
        tipHeight: async () => {
          live()
          const result = await chain.tipHeight()
          live()
          return result
        },
        outspend: async (id: string, vout: number) => {
          live()
          const result = await chain.outspend(id, vout)
          live()
          return result
        },
        broadcast: async (raw: string) => {
          live()
          return chain.broadcast(raw)
        },
      }
      const outcome = await executeSavingsRecovery(standalone, guarded)
      live()
      setMessage(
        `Recovery transaction ${outcome.txid} ${outcome.confirmed ? 'confirmed' : 'submitted'}. Keep the saved file.`,
      )
      return
    }
    if (!record?.txHex) throw new Error('Complete the recovery approval first')
    const valid = validateLedgerRecoveryRecord(record),
      tx = Transaction.fromRaw(hex.decode(valid.txHex!))
    download(valid)
    const spent = await chain.outspend(valid.transition.coin.txid, valid.transition.coin.vout)
    live()
    if (spent.spent) {
      if (spent.txid !== tx.id) throw new Error('This output was spent by a different transaction')
      setMessage(`Recovery transaction ${tx.id} is already submitted. Keep the saved file.`)
    } else {
      const id = await broadcastTx(valid.txHex!)
      live()
      if (id !== tx.id) throw new Error('Bitcoin returned a different transaction ID')
      setMessage(`Recovery transaction ${id} submitted. Keep the saved file.`)
    }
  }
  const prepared = Boolean(record || standalone)
  return (
    <QgScreen
      title='Recover Ledger Savings'
      back={back}
      footer={
        <QgPrimary
          label={complete ? 'Save and broadcast recovery' : prepared ? 'Approve recovery' : 'Review recovery'}
          loading={busy}
          onClick={() => void run(complete ? broadcast : prepared ? approve : prepare)}
        />
      }
    >
      <div className='ledger-recovery-form'>
        <p className='qg-copy'>
          Initiation and Guardian cancellation require the acting key and Guardian. Timed claims, cancellation with all
          remaining keys, and quarantine withdrawals use the committed Bitcoin paths without a service.
        </p>
        {!prepared && (
          <>
            <label className='qg-copy'>
              Recovery path
              <select
                aria-label='Recovery path'
                value={mode}
                disabled={busy}
                onChange={(e) => {
                  setMode(e.target.value)
                  setCoins([])
                }}
              >
                <option value='initiate'>Start recovery</option>
                <option value='clawback'>Cancel with Guardian</option>
                <option value='pending-claim'>Claim after recovery delay</option>
                <option value='pending-cancel'>Cancel with all remaining keys</option>
                <option value='quarantine'>Withdraw from quarantine</option>
                <option value='savings-admin'>Phone and hardware withdrawal</option>
              </select>
            </label>
            <label className='qg-copy'>
              Recovery claimant
              <select
                aria-label='Recovery claimant'
                value={claimant}
                disabled={busy}
                onChange={(e) => {
                  setClaimant(e.target.value as Claimant)
                  setCoins([])
                }}
              >
                {roles.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            {(mode === 'initiate' || mode === 'savings-admin') && (
              <label className='qg-copy'>
                Savings address
                <select
                  value={change}
                  disabled={busy}
                  onChange={(e) => {
                    setChange(Number(e.target.value) as 0 | 1)
                    setCoins([])
                  }}
                >
                  <option value={0}>Receive</option>
                  <option value={1}>Change</option>
                </select>
              </label>
            )}
            <QgSecondary
              label='Find confirmed outputs'
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const found = await fetchAddressUtxos(source.address)
                  live()
                  setCoins(found.filter((c) => c.status.confirmed))
                  setCoinIndex(0)
                })
              }
            />
            <label className='qg-copy'>
              Bitcoin output
              <select
                aria-label='Bitcoin output'
                value={coinIndex}
                disabled={busy}
                onChange={(e) => setCoinIndex(Number(e.target.value))}
              >
                {coins.map((c, i) => (
                  <option value={i} key={`${c.txid}:${c.vout}`}>
                    {c.value} sats · {c.txid.slice(0, 8)}:{c.vout}
                  </option>
                ))}
              </select>
            </label>
            {mode !== 'initiate' && mode !== 'clawback' && (
              <label className='qg-copy'>
                Bitcoin destination
                <input
                  aria-label='Bitcoin destination'
                  value={destination}
                  disabled={busy}
                  onChange={(e) => setDestination(e.target.value.trim())}
                />
              </label>
            )}
            <label className='qg-copy'>
              Network fee in sats
              <input
                type='number'
                aria-label='Recovery fee'
                value={fee}
                disabled={busy}
                onChange={(e) => setFee(e.target.value)}
              />
            </label>
            {saved.records.length > 0 || saved.standalone?.length ? (
              <label className='qg-copy'>
                Resume a saved recovery
                <select
                  aria-label='Resume recovery'
                  value=''
                  disabled={busy}
                  onChange={(e) => {
                    const [kind, index] = e.target.value.split(':')
                    if (kind === 'record') setRecord(saved.records[Number(index)])
                    if (kind === 'standalone') setStandalone(saved.standalone![Number(index)])
                  }}
                >
                  <option value=''>Choose a saved transaction</option>
                  {saved.records.map((r, i) => (
                    <option
                      value={`record:${i}`}
                      key={`record:${r.transition.coin.txid}:${r.transition.coin.vout}:${r.transition.action.kind}`}
                    >
                      {r.transition.action.kind} · {r.transition.coin.txid.slice(0, 8)} ·{' '}
                      {r.guardianPsbt ? 'approved' : 'approval pending'}
                    </option>
                  ))}
                  {saved.standalone?.map((f, i) => (
                    <option value={`standalone:${i}`} key={`standalone:${validateSavingsRecovery(f).tx.id}`}>
                      {f.path.program} · {validateSavingsRecovery(f).tx.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        )}
        {mode === 'clawback' || standalone ? (
          <label className='qg-copy'>
            Signing account
            <select
              aria-label='Signing account'
              value={signingRole}
              disabled={busy}
              onChange={(e) => setActing(e.target.value as Claimant)}
            >
              {allowedActors.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        ) : null}
        {prepared ? (
          <>
            <p className='qg-copy'>
              Destination:{' '}
              {record ? inspectLedgerRecoveryTransition(record.transition).destinationAddress : standalone!.destination}
              <br />
              Receive:{' '}
              {record
                ? inspectLedgerRecoveryTransition(record.transition).amountSats
                : Number(validateSavingsRecovery(standalone!).tx.getOutput(0).amount)}{' '}
              sats
              <br />
              Network fee: {record?.transition.feeSats ?? standalone!.feeSats} sats
            </p>
            <p className='qg-copy'>
              {record?.transition.action.kind === 'initiate'
                ? `The claim becomes eligible ${kit.descriptor.pending[`savings-${record.transition.action.claimant}`].delay} blocks after this recovery transaction confirms.`
                : standalone?.path.program === 'pending-claim'
                  ? `This claim requires ${validateSavingsRecovery(standalone).sequence} blocks after its parent confirms. Bitcoin confirmation and maturity are checked again before broadcast.`
                  : 'This selected path has no additional relative waiting period. Bitcoin spend status is checked before broadcast.'}
            </p>
            <p className='qg-copy'>
              {record
                ? `${inspectLedgerRecoveryTransition(record.transition).user} approval ${record.userPsbt ? 'saved' : 'required'}; Guardian ${record.guardianPsbt ? 'approved' : 'pending'}.`
                : `Required: ${review && 'signers' in review ? review.signers.join(' and ') : ''}.`}
            </p>
            <QgSecondary label='Save recovery file' onClick={() => download(record || standalone)} />
            <label className='qg-copy'>
              Signed partial PSBT
              <textarea value={imported} disabled={busy} onChange={(e) => setImported(e.target.value.trim())} />
            </label>
            <QgSecondary
              label='Import reviewed signature'
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (record)
                    setRecord(
                      await saveLedgerRecoveryRecord({
                        ...record,
                        userPsbt: hex.encode(requireLedgerRecoveryUserApproval(record.transition, imported).toPSBT()),
                      }),
                    )
                  else if (standalone)
                    setStandalone(
                      await saveLedgerStandaloneRecovery(
                        acceptSavingsRecoverySignature(standalone, imported, signingRole),
                      ),
                    )
                  setImported('')
                })
              }
            />
            <QgSecondary
              label='Choose another path'
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (record && !record.userPsbt) await discardUnsignedLedgerRecoveryRecord(record)
                  live()
                  setRecord(undefined)
                  setStandalone(undefined)
                  setMessage('')
                })
              }
            />
          </>
        ) : null}
        <label className='qg-copy'>
          Resume a saved recovery file
          <input
            type='file'
            accept='.json'
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              void run(async () => {
                if (file.size > 12_000_000) throw new Error('Recovery file exceeds 12 MB')
                const raw = JSON.parse(await file.text())
                live()
                if (raw.name === 'vaulted-savings-recovery') {
                  const parsed = validateSavingsRecovery(raw)
                  if (parsed.kit.descriptorHash !== kit.descriptorHash)
                    throw new Error('Recovery file belongs to another wallet')
                  setStandalone(await saveLedgerStandaloneRecovery(raw))
                  setRecord(undefined)
                } else {
                  const valid = validateLedgerRecoveryRecord(raw)
                  if (
                    canonicalLedgerValue(valid.transition.contract) !==
                    canonicalLedgerValue(kit.descriptor.ledgerSavings)
                  )
                    throw new Error('Recovery file belongs to another wallet')
                  setRecord(await saveLedgerRecoveryRecord(valid))
                  setStandalone(undefined)
                }
              })
            }}
          />
        </label>
        {error ? (
          <p className='qg-copy' role='alert'>
            {error}
          </p>
        ) : null}
        {message ? (
          <p className='qg-copy' role='status'>
            {message}
          </p>
        ) : null}
      </div>
    </QgScreen>
  )
}
