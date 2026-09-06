export const MAX_RECOVERY_PLAIN_BYTES = 13_000_000
export async function compressRecoveryData(bytes: Uint8Array, decompress: boolean): Promise<Uint8Array<ArrayBuffer>> {
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(Uint8Array.from(bytes))
      controller.close()
    },
  })
  const stream = input.pipeThrough(decompress ? new DecompressionStream('gzip') : new CompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_RECOVERY_PLAIN_BYTES) {
        await reader.cancel()
        throw new Error('Recovery archive is too large')
      }
      chunks.push(value)
    }
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  } finally {
    reader.releaseLock()
  }
}
