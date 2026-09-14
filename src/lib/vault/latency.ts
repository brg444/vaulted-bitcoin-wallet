/**
 * Narrow, opt-in latency and request-count instrumentation for interactive
 * payment phases. The recorder keeps a bounded ring of durations and simple
 * counters; it never captures arguments, addresses, invoices or secrets.
 *
 * Enable/disable at runtime with `vaultLatency.setEnabled(false)`; browser
 * qualification builds can expose the singleton as `window.__vaultLatency`
 * by setting `VITE_VAULT_LATENCY_METRICS=true`.
 */
export type VaultLatencyPhase =
  | 'review'
  | 'quote'
  | 'passkey'
  | 'reserve'
  | 'authorize'
  | 'submit'
  | 'receipt'
  | 'snapshot'
  | 'retirement'
  | 'balance-publication'
  | 'notification-delivery'

export interface VaultLatencySample {
  phase: VaultLatencyPhase
  ms: number
  at: number
}

export interface VaultLatencySummary {
  phase: VaultLatencyPhase
  count: number
  p50: number
  p95: number
  max: number
}

const MAX_SAMPLES = 512

function clock(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

class VaultLatencyRecorder {
  private enabled = true
  private samples: VaultLatencySample[] = []
  private cursor = 0
  private counts = new Map<VaultLatencyPhase, number>()

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Record a completed span duration. */
  record(phase: VaultLatencyPhase, ms: number): void {
    if (!this.enabled) return
    const sample: VaultLatencySample = { phase, ms, at: Date.now() }
    if (this.samples.length < MAX_SAMPLES) this.samples.push(sample)
    else {
      this.samples[this.cursor] = sample
      this.cursor = (this.cursor + 1) % MAX_SAMPLES
    }
  }

  count(phase: VaultLatencyPhase, delta = 1): void {
    if (!this.enabled) return
    this.counts.set(phase, (this.counts.get(phase) ?? 0) + delta)
  }

  /** Wrap an async phase, recording its duration on success and failure. */
  async measure<T>(phase: VaultLatencyPhase, run: () => Promise<T>): Promise<T> {
    if (!this.enabled) return run()
    const start = clock()
    try {
      return await run()
    } finally {
      this.record(phase, clock() - start)
    }
  }

  /** Wrap a synchronous phase. */
  measureSync<T>(phase: VaultLatencyPhase, run: () => T): T {
    if (!this.enabled) return run()
    const start = clock()
    try {
      return run()
    } finally {
      this.record(phase, clock() - start)
    }
  }

  /** Start a span that the caller closes on an arbitrary boundary. */
  span(phase: VaultLatencyPhase): () => void {
    if (!this.enabled) return () => undefined
    const start = clock()
    let closed = false
    return () => {
      if (closed) return
      closed = true
      this.record(phase, clock() - start)
    }
  }

  samplesFor(phase?: VaultLatencyPhase): readonly VaultLatencySample[] {
    const ordered = this.ordered()
    return phase ? ordered.filter((sample) => sample.phase === phase) : ordered
  }

  counters(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.counts)
  }

  summary(): VaultLatencySummary[] {
    const byPhase = new Map<VaultLatencyPhase, number[]>()
    for (const sample of this.ordered()) {
      const values = byPhase.get(sample.phase)
      if (values) values.push(sample.ms)
      else byPhase.set(sample.phase, [sample.ms])
    }
    return [...byPhase.entries()].map(([phase, values]) => {
      const sorted = [...values].sort((left, right) => left - right)
      return {
        phase,
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1] ?? 0,
      }
    })
  }

  reset(): void {
    this.samples = []
    this.cursor = 0
    this.counts.clear()
  }

  private ordered(): VaultLatencySample[] {
    if (this.samples.length < MAX_SAMPLES) return [...this.samples]
    return [...this.samples.slice(this.cursor), ...this.samples.slice(0, this.cursor)]
  }
}

export const vaultLatency = new VaultLatencyRecorder()

declare global {
  interface Window {
    __vaultLatency?: VaultLatencyRecorder
  }
}

if (typeof window !== 'undefined' && import.meta.env?.VITE_VAULT_LATENCY_METRICS === 'true') {
  window.__vaultLatency = vaultLatency
}
