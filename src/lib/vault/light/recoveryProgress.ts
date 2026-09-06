import type { ExecutorEvent } from '@arkade-os/sdk'
import { humanDuration } from '../policy'

export const lightExitDelayLabel = (seconds: number) =>
  seconds < 86400 ? `about ${Math.ceil(seconds / 60).toLocaleString()} minutes` : humanDuration(seconds)

export function lightRecoveryProgress(event: ExecutorEvent): string {
  const step = `Step ${event.stepIndex + 1}`
  switch (event.status) {
    case 'waiting_csv':
      if (event.maturesAtTime && Number.isFinite(event.maturesAtTime))
        return `${step}: the owner-only delay ends around ${new Date(event.maturesAtTime * 1000).toLocaleString()}.`
      if (event.maturesAtHeight) return `${step}: waiting for Bitcoin block ${event.maturesAtHeight.toLocaleString()}.`
      return `${step}: waiting for the owner-only recovery delay.`
    case 'broadcast':
      return `${step}: submitted to Bitcoin; waiting for confirmation.`
    case 'confirmed':
      return `${step}: confirmed on Bitcoin.`
    case 'skipped':
      // The pinned SDK emits a reason for skipped failed branches; a txid
      // without a reason means its Bitcoin confirmation was already observed.
      if (event.txid && !event.reason) return `${step}: already confirmed on Bitcoin.`
      return `${step}: skipped${event.reason ? ` — ${event.reason}` : ''}.`
    case 'failed':
    case 'warning':
      return `${step}: needs attention${event.reason ? ` — ${event.reason}` : ''}.`
  }
}
