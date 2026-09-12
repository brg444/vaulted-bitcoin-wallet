import type { ExitPackage, ExecutorEvent } from '@arkade-os/sdk'

/** An exhausted SDK iterator can still contain failed branches. Success requires every sweep. */
export async function requireConfirmedRecovery(
  pkg: ExitPackage,
  events: AsyncIterable<ExecutorEvent>,
  onEvent: (event: ExecutorEvent) => void,
) {
  const expected = new Map(
    pkg.steps.flatMap((step, index) => (step.kind === 'sweep' ? [[index, step.txid] as const] : [])),
  )
  if (!expected.size) throw new Error('Recovery file has no Bitcoin sweeps')
  const confirmed = new Set<number>()
  let failed = false
  for await (const event of events) {
    onEvent(event)
    if (event.status === 'failed') failed = true
    if (event.kind === 'sweep' && event.status === 'confirmed' && expected.get(event.stepIndex) === event.txid)
      confirmed.add(event.stepIndex)
  }
  if (failed || confirmed.size !== expected.size)
    throw new Error(
      'Recovery is incomplete. Keep the saved exit file and review the failed transactions before resuming.',
    )
}
