/** A canceled approval can drain a response, but cannot issue another signing or Operator call. */
export function cancellableSdkCapability<T extends object>(target: T, signal?: AbortSignal): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        signal?.throwIfAborted()
        const result = Reflect.apply(value, object, args)
        return property === 'signerSession' ? cancellableSdkCapability(result, signal) : result
      }
    },
  })
}
