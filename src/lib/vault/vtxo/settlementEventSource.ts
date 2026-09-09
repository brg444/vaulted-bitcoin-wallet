import { configureEventSource, type EventSourceLike } from '@arkade-os/sdk'

const SETTLEMENT_EVENTS_PATH = '/v1/batch/events'
const EVENT_SOURCE_CONNECTING = 0
const EVENT_SOURCE_OPEN = 1
const EVENT_SOURCE_CLOSED = 2
/** Mainnet Operator SSE often takes several seconds before `open`/first event. */
const STREAM_READY_TIMEOUT_MS = 60_000
const FETCH_SSE_RECONNECT_MS = 1_000

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Duck-typed EventSource used by the settlement wrapper. */
export type VaultEventSourceTransport = {
  readyState: number
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

type EventSourceTransportFactory = (url: string) => VaultEventSourceTransport

type SettlementStream = {
  topics: Set<string>
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: Error) => void
  state: 'connecting' | 'open' | 'closed'
  closed: boolean
}

const settlementStreams = new Set<SettlementStream>()

function armSettlementStream(record: SettlementStream): void {
  record.ready = new Promise<void>((resolve, reject) => {
    record.resolveReady = resolve
    record.rejectReady = reject
  })
  void record.ready.catch(() => undefined)
}

function settlementTopics(url: string): Set<string> | undefined {
  let parsed: URL
  try {
    parsed = new URL(url, 'https://local.invalid')
  } catch {
    return undefined
  }
  if (parsed.pathname !== SETTLEMENT_EVENTS_PATH) return undefined
  return new Set(parsed.searchParams.getAll('topics'))
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function flushSseLines(buffer: string, onData: (data: string) => void, end: boolean): string {
  const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const parts = normalized.split('\n')
  const rest = end ? '' : (parts.pop() ?? '')
  for (const line of parts) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) continue
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (data) onData(data)
  }
  if (end) {
    const trimmed = rest.trim()
    if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5).trim()
      if (data) onData(data)
    }
    return ''
  }
  return rest
}

async function readSseBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const onAbort = () => {
    void reader.cancel()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        flushSseLines(buffer + decoder.decode(), onData, true)
        return
      }
      buffer = flushSseLines(buffer + decoder.decode(value, { stream: true }), onData, false)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Service-worker-safe SSE transport. Native `EventSource` in a worker does not
 * reliably open a cross-origin Operator stream, so boarding never reached register.
 */
export function createFetchEventSource(url: string, fetchImpl: FetchLike = fetch): VaultEventSourceTransport {
  const target = new EventTarget()
  let readyState = EVENT_SOURCE_CONNECTING
  let closed = false
  let abort = new AbortController()
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const source: VaultEventSourceTransport = {
    get readyState() {
      return readyState
    },
    addEventListener(type, listener) {
      target.addEventListener(type, listener as EventListener)
    },
    removeEventListener(type, listener) {
      target.removeEventListener(type, listener as EventListener)
    },
    close() {
      if (closed) return
      closed = true
      readyState = EVENT_SOURCE_CLOSED
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      abort.abort()
    },
  }

  const connect = async () => {
    while (!closed) {
      readyState = EVENT_SOURCE_CONNECTING
      abort = new AbortController()
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
          signal: abort.signal,
          credentials: 'omit',
          cache: 'no-store',
          mode: 'cors',
        })
        if (closed) return
        if (!response.ok || !response.body) {
          throw new Error(`Vault settlement event stream HTTP ${response.status}`)
        }
        readyState = EVENT_SOURCE_OPEN
        target.dispatchEvent(new Event('open'))
        await readSseBody(response.body, abort.signal, (data) => {
          if (!closed) target.dispatchEvent(new MessageEvent('message', { data }))
        })
        if (closed) return
        readyState = EVENT_SOURCE_CONNECTING
        target.dispatchEvent(new Event('error'))
      } catch (error) {
        if (closed || isAbortError(error)) return
        readyState = EVENT_SOURCE_CONNECTING
        target.dispatchEvent(new Event('error'))
      }
      if (closed) return
      await new Promise<void>((resolve) => {
        reconnectTimer = setTimeout(resolve, FETCH_SSE_RECONNECT_MS)
      })
    }
  }
  void connect()
  return source
}

/**
 * Retry connection setup, but fail an interrupted open settlement stream.
 * Reconnecting cannot replay missed batch events; continuing the old SDK batch
 * would leave it waiting for a phase or terminal event that has already passed.
 */
export function createVaultEventSourceFactory(
  nativeFactory: EventSourceTransportFactory = (url) => createFetchEventSource(url),
): (url: string) => EventSourceLike {
  return (url) => {
    const source = nativeFactory(url)
    const topics = settlementTopics(url)
    // The SDK types error callbacks as MessageEvent; DOM transports emit Event.
    // Preserve transport identity and listeners for non-settlement URLs.
    if (!topics) return source as unknown as EventSourceLike

    const record: SettlementStream = {
      topics,
      ready: Promise.resolve(),
      resolveReady: () => undefined,
      rejectReady: () => undefined,
      state: 'connecting',
      closed: false,
    }
    armSettlementStream(record)
    settlementStreams.add(record)

    const messageListeners = new Set<(event: MessageEvent) => void>()
    const errorListeners = new Set<(event: MessageEvent) => void>()
    const markOpen = () => {
      if (record.closed) return
      record.state = 'open'
      record.resolveReady()
    }
    const onOpen = () => markOpen()
    const onMessage = (event: Event) => {
      markOpen()
      for (const listener of messageListeners) listener(event as MessageEvent)
    }
    const onError = (event: Event) => {
      if (record.closed) return
      if (source.readyState === EVENT_SOURCE_CONNECTING && record.state === 'connecting') return
      const listeners = [...errorListeners]
      close()
      for (const listener of listeners) listener(event as MessageEvent)
    }
    source.addEventListener('open', onOpen)
    source.addEventListener('message', onMessage)
    source.addEventListener('error', onError)

    const close = () => {
      if (record.closed) return
      record.closed = true
      record.state = 'closed'
      settlementStreams.delete(record)
      source.removeEventListener('open', onOpen)
      source.removeEventListener('message', onMessage)
      source.removeEventListener('error', onError)
      source.close()
      record.rejectReady(new Error('Vault settlement event stream closed before opening'))
      messageListeners.clear()
      errorListeners.clear()
    }

    return {
      addEventListener(type, listener) {
        if (type === 'message') messageListeners.add(listener)
        else errorListeners.add(listener)
      },
      removeEventListener(type, listener) {
        if (type === 'message') messageListeners.delete(listener)
        else errorListeners.delete(listener)
      },
      close,
    }
  }
}

export function installVaultSettlementEventSource(): void {
  configureEventSource(createVaultEventSourceFactory((url) => createFetchEventSource(url)))
}

function latestSettlementStream(topic: string): SettlementStream | undefined {
  const matching = [...settlementStreams].filter((candidate) => !candidate.closed && candidate.topics.has(topic))
  return matching[matching.length - 1]
}

/** Bind an async signing continuation to its original uninterrupted stream. */
export function vaultSettlementStreamGuard(topic: string): () => void {
  const stream = latestSettlementStream(topic)
  const assertOpen = () => {
    if (!stream || stream.closed || stream.state !== 'open') {
      throw new Error('Vault settlement event stream interrupted before final submission')
    }
  }
  assertOpen()
  return assertOpen
}

/** Fail closed unless the outpoint-filtered Operator stream is already open. */
export async function waitForVaultSettlementStream(topic: string, timeoutMs = STREAM_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const stream = latestSettlementStream(topic)
    if (stream?.state === 'open') return
    if (stream?.state === 'closed') throw new Error('Vault settlement event stream closed before registration')
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(
        stream
          ? 'Vault settlement event stream did not become ready before registration'
          : 'Vault settlement event stream was not created before registration',
      )
    }
    if (!stream) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)))
      continue
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        stream.ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Vault settlement event stream did not become ready before registration')),
            remaining,
          )
        }),
      ])
    } catch (error) {
      if (Date.now() >= deadline) throw error
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
}
