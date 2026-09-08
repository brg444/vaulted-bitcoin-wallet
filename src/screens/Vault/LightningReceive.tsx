import { useEffect, useRef, useState } from 'react'
import { RestArkProvider, RestEmulatorProvider } from '@arkade-os/sdk'
import type { RfqSwapRecord } from '@arkade-os/swap'
import QrCode from '../../components/QrCode'
import { copyToClipboard } from '../../lib/clipboard'
import { discoverVaultLightningSolver, withVaultLightningTransport } from '../../lib/vault/lightning'
import { vaultLightningReceivePlan, vaultLightningSolverProfile } from '../../lib/vault/lightningConfig'
import {
  requestVaultLightningReceive,
  approveVaultLightningReceive,
  receiveProfile,
} from '../../lib/vault/lightningReceive'
import { withVaultLightningLifecycleLock } from '../../lib/vault/lightningLock'
import { withVaultWalletState } from '../../lib/vault/vtxo/walletWorker'
import { networkPins } from '../../lib/vault/networkPins'
import type { VaultStatus } from '../../lib/vault/types'
import QgScreen, { QgPrimary, QgSecondary } from './qg/QgScreen'

export default function LightningReceive({
  onBack,
  status,
  backupRecoveryArchive,
  refreshBalance,
}: {
  onBack: () => void
  status: VaultStatus
  backupRecoveryArchive: () => Promise<void>
  refreshBalance: () => Promise<void>
}) {
  const actions = useRef({ status, backupRecoveryArchive, refreshBalance })
  actions.current = { status, backupRecoveryArchive, refreshBalance }
  const vaultId = status.vaultId
  const [amount, setAmount] = useState('')
  const [record, setRecord] = useState<RfqSwapRecord>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [now, setNow] = useState(Math.floor(Date.now() / 1000))
  const [backedUpApproval, setBackedUpApproval] = useState<string>()
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const current = record ? receiveProfile(record) : undefined
  const rfqId = record?.rfqId
  const approved = !!current && current.approvedPaySats === current.quote.from_amount && backedUpApproval === rfqId
  const paid = record?.state === 'settled'
  const expired = current ? now >= current.invoiceExpiresAt : false
  const profile = vaultLightningSolverProfile(status?.network)
  let estimate: ReturnType<typeof vaultLightningReceivePlan> | undefined
  try {
    if (profile && /^\d+$/.test(amount)) estimate = vaultLightningReceivePlan(Number(amount), profile)
  } catch {
    /* field is incomplete */
  }

  useEffect(() => {
    const { status, backupRecoveryArchive } = actions.current
    let stopped = false
    setRecord(undefined)
    setBackedUpApproval(undefined)
    setError('')
    setBusy(true)
    const restore = async () => {
      try {
        const saved = await withVaultLightningLifecycleLock(status.vaultId, () =>
          withVaultWalletState(
            status,
            async ({ swapRepository }) =>
              (await swapRepository.getAllRfqSwaps())
                .filter((r) => r.kind === 'lightning_receive')
                .sort((a, b) => b.createdAt - a.createdAt)[0],
          ),
        )
        if (saved) {
          await backupRecoveryArchive()
          if (!stopped) {
            setRecord(saved)
            setBackedUpApproval(receiveProfile(saved).approvedPaySats ? saved.rfqId : undefined)
          }
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : 'Could not restore the Lightning invoice.')
      } finally {
        if (!stopped) setBusy(false)
      }
    }
    void restore()
    return () => {
      stopped = true
    }
  }, [vaultId])

  useEffect(() => {
    if (!rfqId || paid) return
    const { status } = actions.current
    let stopped = false,
      running = false
    const poll = async () => {
      if (running) return
      running = true
      try {
        await actions.current.refreshBalance()
        const saved = await withVaultLightningLifecycleLock(status.vaultId, () =>
          withVaultWalletState(status, ({ swapRepository }) => swapRepository.getRfqSwap(rfqId)),
        )
        if (!stopped && saved) setRecord(saved)
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : 'Waiting for payment status. Keep this wallet open.')
      } finally {
        running = false
      }
    }
    const timer = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000))
      void poll()
    }, 5000)
    void poll()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [rfqId, vaultId, paid])

  const create = async () => {
    if (!status || !estimate || busy) return
    setBusy(true)
    setError('')
    try {
      if (!status.arkadeCosignerOrigin) throw new Error('The enrolled Emulator endpoint is missing.')
      const emulatorInfo = await new RestEmulatorProvider(status.arkadeCosignerOrigin).getInfo()
      if (emulatorInfo.signerPubkey !== networkPins(status.network).emulatorSignerPub)
        throw new Error('The Lightning claim service does not match this wallet.')
      const verified = await discoverVaultLightningSolver(status.network)
      if (!verified) throw new Error('The Lightning solver card could not be verified.')
      const saved = await withVaultLightningLifecycleLock(status.vaultId, () =>
        withVaultWalletState(status, async ({ swapRepository, contracts }) => {
          const outstanding = (await swapRepository.getAllRfqSwaps()).find(
            (r) =>
              r.kind === 'lightning_receive' &&
              r.state !== 'settled' &&
              r.state !== 'refunded' &&
              Math.floor(Date.now() / 1000) < receiveProfile(r).quote.refund_locktime!,
          )
          if (outstanding) return outstanding
          return withVaultLightningTransport(verified, async (transport) =>
            requestVaultLightningReceive({
              status,
              amountSats: Number(amount),
              profile: verified,
              transport,
              repository: swapRepository,
              contracts,
              operatorInfo: await new RestArkProvider(networkPins(status.network).operatorOrigin).getInfo(),
            }),
          )
        }),
      )
      await backupRecoveryArchive()
      if (mounted.current && actions.current.status.vaultId === status.vaultId) {
        setRecord(saved)
        setBackedUpApproval(receiveProfile(saved).approvedPaySats ? saved.rfqId : undefined)
        setNow(Math.floor(Date.now() / 1000))
        setCopied(false)
      }
    } catch (e) {
      if (mounted.current && actions.current.status.vaultId === status.vaultId)
        setError(e instanceof Error ? e.message : 'Could not create a Lightning invoice.')
    } finally {
      if (mounted.current && actions.current.status.vaultId === status.vaultId) setBusy(false)
    }
  }
  const approve = async () => {
    if (!status || !current || !record || busy) return
    setBusy(true)
    setError('')
    try {
      const saved = await withVaultLightningLifecycleLock(status.vaultId, () =>
        withVaultWalletState(status, ({ swapRepository }) =>
          approveVaultLightningReceive(swapRepository, record.rfqId, current.quote.from_amount),
        ),
      )
      await backupRecoveryArchive()
      if (mounted.current && actions.current.status.vaultId === status.vaultId) {
        setRecord(saved)
        setBackedUpApproval(saved.rfqId)
      }
    } catch (e) {
      if (mounted.current && actions.current.status.vaultId === status.vaultId)
        setError(e instanceof Error ? e.message : 'Could not confirm this invoice.')
    } finally {
      if (mounted.current && actions.current.status.vaultId === status.vaultId) setBusy(false)
    }
  }
  return (
    <QgScreen
      title='Receive Lightning'
      dismiss={onBack}
      footer={
        current && !paid && !expired && !approved ? (
          <QgPrimary label='Confirm fee and show invoice' loading={busy} onClick={() => void approve()} />
        ) : current && !paid && !expired ? (
          <QgPrimary
            label={copied ? 'Copied' : 'Copy invoice'}
            disabled={busy}
            onClick={() =>
              void copyToClipboard(current.invoice)
                .then(() => setCopied(true))
                .catch(() => setError('Could not copy the invoice.'))
            }
          />
        ) : current ? (
          <QgPrimary label='Back to receive' onClick={onBack} />
        ) : (
          <QgPrimary label='Create invoice' loading={busy} disabled={!estimate} onClick={() => void create()} />
        )
      }
    >
      {current ? (
        <div className='qg-receive'>
          <p className='qg-copy' role='status'>
            {paid
              ? `${record!.amount?.toLocaleString()} sats received in Spending.`
              : expired
                ? 'This invoice has expired. Any payment already in progress is still being checked.'
                : approved
                  ? 'Keep Vaulted open until the payment reaches Spending.'
                  : 'Review the total before sharing this invoice.'}
          </p>
          {!paid && !expired && !approved ? (
            <>
              <p className='qg-copy'>Receive {record!.amount?.toLocaleString()} sats in Spending.</p>
              <p className='qg-copy'>
                The payer sends {current.quote.from_amount.toLocaleString()} sats. Total fee:{' '}
                {(current.quote.from_amount - record!.amount!).toLocaleString()} sats.
              </p>
              {current.quote.from_amount > current.estimatedPaySats ? (
                <p className='qg-copy'>
                  This includes {(current.quote.from_amount - current.estimatedPaySats).toLocaleString()} sats above the
                  solver’s advertised fee estimate.
                </p>
              ) : null}
            </>
          ) : null}
          {!paid && !expired && approved ? (
            <>
              <div className='qg-qr' role='img' aria-label='Lightning invoice QR code'>
                <QrCode large value={`lightning:${current.invoice}`} />
              </div>
              <p className='qg-copy'>
                Receive {record!.amount?.toLocaleString()} sats. The payer sends{' '}
                {current.quote.from_amount.toLocaleString()} sats, including the fee.
              </p>
              <p className='qg-copy'>
                Expires in {Math.max(0, Math.ceil((current.invoiceExpiresAt - now) / 60))} minutes.
              </p>
            </>
          ) : null}
          {paid || now >= current.quote.refund_locktime! ? (
            <QgSecondary
              label='Another invoice'
              onClick={() => {
                setRecord(undefined)
                setAmount('')
                setError('')
              }}
            />
          ) : null}
        </div>
      ) : (
        <>
          <label className='qg-dest-field'>
            Amount to receive (sats)
            <input
              aria-label='Amount to receive (sats)'
              inputMode='numeric'
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <p className='qg-copy'>
            {estimate
              ? `Estimated payer total: ${estimate.maxPaySats.toLocaleString()} sats. Review the exact total before sharing.`
              : 'Enter the amount you want to receive in Spending.'}
          </p>
          <p className='qg-copy'>
            Keep this wallet open while the payer sends. The invoice is saved in your recovery backup before you share
            it.
          </p>
        </>
      )}
      {error ? (
        <p className='qg-copy' role='alert'>
          {error}
        </p>
      ) : null}
    </QgScreen>
  )
}
