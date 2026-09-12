export type VaultMaintenanceName =
  | 'spending-balance'
  | 'savings-balance'
  | 'wallet-sync'
  | 'wallet-reconnect'
  | 'lightning-observer'
  | 'spending-renewals'
  | 'bitcoin-payment'
  | 'ledger-payment'
  | 'recovery-archive'

export interface VaultMaintenanceTask<T> {
  refresh: () => Promise<T>
  request: (delayMs?: number) => void
  isDisposed: () => boolean
  dispose: () => Promise<void>
}

interface Observation {
  run: (signal: AbortSignal) => Promise<unknown>
  intervalMs: number | (() => number)
  events: readonly string[]
  failed?: (error: unknown) => void
  requested?: () => void
  controller: AbortController
  trailing: boolean
}

interface Task {
  observation?: Observation
  flight?: { observation: Observation; promise: Promise<unknown> }
  due: number
  dirty: boolean
  cadences: Map<symbol, number>
  completedAt?: number
}

/** One foreground clock and one pending result for each named account task. */
export function createVaultAccountMaintenance(
  vaultId: string,
  isVisible = () => document.visibilityState !== 'hidden',
) {
  const tasks = new Map<VaultMaintenanceName, Task>()
  const events = new Set<string>()
  let disposed = false
  let paused = 0
  let timer = 0
  let resume: Promise<void> | undefined
  let releasePause: (() => void) | undefined
  const visible = () => !disposed && !paused && isVisible()
  const interval = (task: Task) => {
    const own = task.observation?.intervalMs ?? Infinity
    return Math.min(typeof own === 'function' ? own() : own, ...task.cadences.values())
  }
  const taskFor = (name: VaultMaintenanceName) => {
    let task = tasks.get(name)
    if (!task) {
      task = { due: Infinity, dirty: false, cadences: new Map() }
      tasks.set(name, task)
    }
    return task
  }

  const arm = () => {
    window.clearTimeout(timer)
    timer = 0
    if (!visible()) return
    const due = Math.min(
      ...[...tasks.values()].filter((task) => task.observation && !task.flight).map((task) => task.due),
    )
    if (!Number.isFinite(due)) return
    timer = window.setTimeout(
      () => {
        timer = 0
        if (!visible()) return
        for (const task of tasks.values()) {
          if (task.observation && !task.flight && task.due <= Date.now())
            void refresh(task, task.observation).catch(() => undefined)
        }
        arm()
      },
      Math.max(0, due - Date.now()),
    )
  }

  const refresh = (task: Task, observation: Observation): Promise<unknown> => {
    if (disposed || observation.controller.signal.aborted || task.observation !== observation)
      return Promise.reject(new DOMException('Account observation ended', 'AbortError'))
    if (paused) return resume!.then(() => refresh(task, observation))
    if (task.flight) {
      if (task.flight.observation === observation) return task.flight.promise
      // A replacement owner waits for the previous owner to drain. It must
      // neither consume the previous result nor overlap the same named task.
      return task.flight.promise.catch(() => undefined).then(() => refresh(task, observation))
    }
    if (!task.dirty) observation.requested?.()
    task.dirty = false
    task.due = Infinity
    const promise = Promise.resolve()
      .then(() => {
        observation.controller.signal.throwIfAborted()
        return observation.run(observation.controller.signal)
      })
      .catch((error) => {
        if (!observation.controller.signal.aborted && task.observation === observation) observation.failed?.(error)
        throw error
      })
      .finally(() => {
        if (task.flight?.promise === promise) task.flight = undefined
        task.completedAt = Date.now()
        if (task.observation) task.due = task.completedAt + (task.dirty ? 0 : interval(task))
        else if (!task.cadences.size) tasks.forEach((entry, name) => entry === task && tasks.delete(name))
        arm()
      })
    task.flight = { observation, promise }
    arm()
    return promise
  }

  const request = (task: Task, delayMs = 150) => {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Nonnegative maintenance delay required')
    if (disposed || !task.observation) return
    if (task.flight?.observation === task.observation && !task.observation.trailing) return
    task.observation.requested?.()
    task.dirty = true
    task.due = Math.min(task.due, Date.now() + delayMs)
    arm()
  }

  const invalidate = (name: string, event?: Event) => {
    if (disposed) return
    const target = (event as CustomEvent<unknown> | undefined)?.detail
    if (typeof target === 'string' && target && target !== vaultId) return
    for (const task of tasks.values()) {
      if (task.observation?.events.includes(name)) request(task)
    }
    arm()
  }
  const receive = (event: Event) => invalidate(event.type, event)
  const visibility = () => {
    if (isVisible()) invalidate('visibilitychange')
    arm()
  }
  document.addEventListener('visibilitychange', visibility)

  return {
    /** A view requests freshness from the existing owner without starting another poller. */
    requestCadence(name: VaultMaintenanceName, intervalMs: number): () => void {
      if (disposed) throw new Error('Account runtime is disposed')
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Positive maintenance interval required')
      const task = taskFor(name)
      const consumer = Symbol(name)
      task.cadences.set(consumer, intervalMs)
      request(task)
      return () => {
        if (!task.cadences.delete(consumer)) return
        if (!task.observation && !task.flight && !task.cadences.size) tasks.delete(name)
        else if (task.observation && !task.flight && !task.dirty && task.completedAt !== undefined)
          task.due = task.completedAt + interval(task)
        arm()
      }
    },
    observe<T>(
      name: VaultMaintenanceName,
      run: (signal: AbortSignal) => Promise<T>,
      options: {
        intervalMs: number | (() => number)
        events?: readonly string[]
        failed?: (error: unknown) => void
        requested?: () => void
        trailing?: boolean
      },
    ): VaultMaintenanceTask<T> {
      if (disposed) throw new Error('Account runtime is disposed')
      const task = taskFor(name)
      if (task.observation) throw new Error(`Account maintenance already owns ${name}`)
      const observation: Observation = {
        run,
        intervalMs: options.intervalMs,
        events: options.events || ['focus', 'online', 'visibilitychange'],
        failed: options.failed,
        requested: options.requested,
        controller: new AbortController(),
        trailing: options.trailing ?? false,
      }
      task.observation = observation
      for (const name of observation.events) {
        if (name === 'wallet' || name === 'visibilitychange' || events.has(name)) continue
        window.addEventListener(name, receive)
        events.add(name)
      }
      if (task.cadences.size) request(task)
      return {
        refresh: () => refresh(task, observation) as Promise<T>,
        request: (delayMs) => {
          if (task.observation === observation) request(task, delayMs)
        },
        isDisposed: () => observation.controller.signal.aborted,
        dispose: async () => {
          observation.controller.abort()
          if (task.observation === observation) {
            task.observation = undefined
            task.dirty = false
            task.due = Infinity
          }
          arm()
          await Promise.allSettled(task.flight ? [task.flight.promise] : [])
          if (!task.observation && !task.cadences.size && tasks.get(name) === task) tasks.delete(name)
        },
      }
    },
    invalidate,
    /** SDK replacement drains its page-side consumers before stopping it. */
    async withPaused<T>(run: () => Promise<T>): Promise<T> {
      if (!paused) resume = new Promise<void>((resolve) => (releasePause = resolve))
      paused++
      arm()
      try {
        // The reconnect task drives replacement and never consumes wallet state.
        // Waiting on it here would make replacement wait on its own caller.
        await Promise.allSettled(
          [...tasks.entries()].flatMap(([name, task]) =>
            name !== 'wallet-reconnect' && task.flight ? [task.flight.promise] : [],
          ),
        )
        return await run()
      } finally {
        paused--
        if (!paused) releasePause?.()
        arm()
      }
    },
    async dispose() {
      disposed = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
      for (const name of events) window.removeEventListener(name, receive)
      for (const task of tasks.values()) task.observation?.controller.abort()
      await Promise.allSettled([...tasks.values()].flatMap((task) => (task.flight ? [task.flight.promise] : [])))
      tasks.clear()
    },
  }
}

export type VaultAccountMaintenance = ReturnType<typeof createVaultAccountMaintenance>
