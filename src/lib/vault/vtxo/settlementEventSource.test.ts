import { describe, expect, it, vi } from 'vitest'
import { Batch, RestArkProvider } from '@arkade-os/sdk'
import {
  createFetchEventSource,
  createVaultEventSourceFactory,
  waitForVaultSettlementStream,
  vaultSettlementStreamGuard,
} from './settlementEventSource'

class FakeEventSource extends EventTarget {
  readyState = 0
  close = vi.fn(() => {
    this.readyState = 2
  })

  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  reconnectingError() {
    this.readyState = 0
    this.dispatchEvent(new Event('error'))
  }

  fatalError() {
    this.readyState = 2
    this.dispatchEvent(new Event('error'))
  }

  message(data: string) {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

describe('Vault settlement EventSource', () => {
  it('retries initial connection errors but fails a disconnected open stream', async () => {
    const native = new FakeEventSource()
    const factory = createVaultEventSourceFactory(() => native as unknown as EventSource)
    const topic = `${'ab'.repeat(32)}:1`
    const source = factory(`https://mutinynet.arkade.sh/v1/batch/events?topics=${encodeURIComponent(topic)}`)
    const message = vi.fn()
    const error = vi.fn()
    source.addEventListener('message', message)
    source.addEventListener('error', error)

    const ready = waitForVaultSettlementStream(topic, 100)
    native.reconnectingError()
    expect(error).not.toHaveBeenCalled()

    native.open()
    await expect(ready).resolves.toBeUndefined()
    native.message('{"type":"streamStarted"}')
    expect(message).toHaveBeenCalledTimes(1)

    native.reconnectingError()
    expect(error).toHaveBeenCalledTimes(1)
    expect(native.close).toHaveBeenCalledTimes(1)
    native.open()
    native.message('{"type":"batchFinalization"}')
    native.fatalError()
    expect(message).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
    source.close()
    expect(native.close).toHaveBeenCalledTimes(1)
  })

  it('treats the first settlement message as stream ready', async () => {
    const native = new FakeEventSource()
    const factory = createVaultEventSourceFactory(() => native as unknown as EventSource)
    const topic = `${'ab'.repeat(32)}:0`
    factory(`https://arkade.computer/v1/batch/events?topics=${encodeURIComponent(topic)}`)
    const ready = waitForVaultSettlementStream(topic, 100)
    native.message('{"streamStarted":{"id":"1"}}')
    await expect(ready).resolves.toBeUndefined()
  })

  it('tracks relative Operator settlement URLs', async () => {
    const native = new FakeEventSource()
    const factory = createVaultEventSourceFactory(() => native as unknown as EventSource)
    const topic = `${'aa'.repeat(32)}:7`
    const source = factory(`/v1/batch/events?topics=${encodeURIComponent(topic)}`)
    const ready = waitForVaultSettlementStream(topic, 100)
    native.open()
    await expect(ready).resolves.toBeUndefined()
    source.close()
  })

  it('waits for a settlement stream created after registration starts', async () => {
    const native = new FakeEventSource()
    const factory = createVaultEventSourceFactory(() => native as unknown as EventSource)
    const topic = `${'11'.repeat(32)}:0`
    const ready = waitForVaultSettlementStream(topic, 200)
    await Promise.resolve()
    factory(`https://arkade.computer/v1/batch/events?topics=${encodeURIComponent(topic)}`)
    native.open()
    await expect(ready).resolves.toBeUndefined()
  })

  it('fails closed when registration has no matching settlement stream', async () => {
    await expect(waitForVaultSettlementStream(`${'cd'.repeat(32)}:0`, 10)).rejects.toThrow(
      /was not created before registration/,
    )
  })

  it('never lets a replacement stream revive an old final signing continuation', async () => {
    const first = new FakeEventSource()
    const second = new FakeEventSource()
    const sources = [first, second]
    const factory = createVaultEventSourceFactory(() => sources.shift()!)
    const topic = `${'12'.repeat(32)}:0`
    const url = `https://arkade.computer/v1/batch/events?topics=${encodeURIComponent(topic)}`
    const original = factory(url)
    expect(() => vaultSettlementStreamGuard(topic)).toThrow(/interrupted/)
    first.open()
    const assertOriginalOpen = vaultSettlementStreamGuard(topic)
    expect(assertOriginalOpen).not.toThrow()
    first.reconnectingError()
    expect(assertOriginalOpen).toThrow(/interrupted/)

    const replacement = factory(url)
    second.open()
    await waitForVaultSettlementStream(topic, 100)
    expect(vaultSettlementStreamGuard(topic)).not.toThrow()
    expect(assertOriginalOpen).toThrow(/interrupted/)
    original.close()
    replacement.close()
  })

  it('leaves non-settlement EventSource behavior unchanged', () => {
    const native = new FakeEventSource()
    const factory = createVaultEventSourceFactory(() => native as unknown as EventSource)
    expect(factory('https://mutinynet.arkade.sh/v1/indexer/events')).toBe(native)
  })

  it('binds readiness to the newest stream for the same outpoint', async () => {
    const first = new FakeEventSource()
    const second = new FakeEventSource()
    const sources = [first, second]
    const factory = createVaultEventSourceFactory(() => sources.shift()! as unknown as EventSource)
    const topic = `${'ef'.repeat(32)}:0`
    const url = `https://mutinynet.arkade.sh/v1/batch/events?topics=${encodeURIComponent(topic)}`
    const firstWrapped = factory(url)
    first.open()
    const secondWrapped = factory(url)

    let ready = false
    const waiting = waitForVaultSettlementStream(topic, 100).then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)
    second.open()
    await waiting

    firstWrapped.close()
    secondWrapped.close()
  })
})

function hangingSse(chunks: string[] = []) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  let resolveCancel: () => void = () => undefined
  const cancelled = new Promise<void>((resolve) => {
    resolveCancel = resolve
  })
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
    },
    cancel() {
      resolveCancel()
    },
  })
  return {
    response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push(chunk: string) {
      controller.enqueue(encoder.encode(chunk))
    },
    end() {
      controller.close()
    },
    cancelled,
  }
}

describe('Vault fetch settlement EventSource', () => {
  it('marks the Operator stream ready when fetch headers arrive', async () => {
    const sse = hangingSse()
    const fetchImpl = vi.fn(async () => sse.response)
    const factory = createVaultEventSourceFactory((url) => createFetchEventSource(url, fetchImpl))
    const topic = `${'ab'.repeat(32)}:0`
    const url = `https://arkade.computer/v1/batch/events?topics=${encodeURIComponent(topic)}`
    const source = factory(url)
    await expect(waitForVaultSettlementStream(topic, 500)).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        headers: expect.objectContaining({ Accept: 'text/event-stream' }),
      }),
    )
    source.close()
    await sse.cancelled
  })

  it('handles cancellation rejection when the connection is closed', async () => {
    const cancel = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError')
    })
    const body = new ReadableStream<Uint8Array>({ cancel })
    const factory = createVaultEventSourceFactory((url) => createFetchEventSource(url, async () => new Response(body)))
    const topic = `${'ef'.repeat(32)}:0`
    const source = factory(`https://arkade.computer/v1/batch/events?topics=${encodeURIComponent(topic)}`)
    await waitForVaultSettlementStream(topic, 500)
    source.close()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })
  it('forwards SSE data lines as settlement messages', async () => {
    const sse = hangingSse()
    const factory = createVaultEventSourceFactory((url) => createFetchEventSource(url, async () => sse.response))
    const topic = `${'cd'.repeat(32)}:1`
    const source = factory(`https://arkade.computer/v1/batch/events?topics=${encodeURIComponent(topic)}`)
    const message = vi.fn()
    source.addEventListener('message', message)
    await waitForVaultSettlementStream(topic, 500)
    sse.push('data: {"streamStarted":{"id":"1"}}\n\n')
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(1))
    expect(message.mock.calls[0][0]).toEqual(expect.objectContaining({ data: '{"streamStarted":{"id":"1"}}' }))
    source.close()
  })

  it('rejects the active SDK batch after disconnect and lets a fresh attempt open', async () => {
    const first = hangingSse()
    const second = hangingSse()
    const responses = [first.response, second.response]
    const fetchImpl = vi.fn(async () => {
      const next = responses.shift()
      if (!next) throw new Error('unexpected extra SSE fetch')
      return next
    })
    const factory = createVaultEventSourceFactory((url) => createFetchEventSource(url, fetchImpl))
    const provider = new RestArkProvider('https://arkade.computer', { eventSource: factory })
    const topic = `${'ef'.repeat(32)}:0`
    const abort = new AbortController()
    const stream = provider.getEventStream(abort.signal, [topic])
    const started = vi.fn(async () => ({ skip: false }))
    const finalization = vi.fn()
    const joined = Batch.join(
      stream,
      {
        onBatchStarted: started,
        onTreeSigningStarted: async () => ({ skip: false }),
        onTreeNonces: async () => ({ fullySigned: true }),
        onBatchFinalization: finalization,
      },
      { abortController: abort },
    )
    // Attach the rejection assertion before closing the transport.
    const rejected = expect(joined).rejects.toThrow('EventSource error')
    await waitForVaultSettlementStream(topic, 500)
    first.push('data: {"batchStarted":{"id":"old-batch","intentIdHashes":[],"batchExpiry":"2592000"}}\n\n')
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    first.end()
    await rejected
    expect(finalization).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    abort.abort()
    await stream.return?.()

    // Reconciliation owns the next registration; this stream has no stale SDK state.
    const retry = factory(`https://arkade.computer/v1/batch/events?topics=${encodeURIComponent(topic)}`)
    await expect(waitForVaultSettlementStream(topic, 500)).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    retry.close()
    await second.cancelled
  })
})
