/** Coalesce bursts, but never lose a receive/spend event during an upload. */
export function lightBackupScheduler(work: () => Promise<void>, failed: (error: unknown) => void) {
  let running = false
  let dirty = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const drain = async () => {
    if (disposed || running) return
    running = true
    try {
      while (dirty && !disposed) {
        dirty = false
        try {
          await work()
        } catch (error) {
          if (!disposed) failed(error)
          break
        }
      }
    } finally {
      running = false
    }
  }
  return {
    request() {
      if (disposed) return
      dirty = true
      if (running || timer) return
      timer = setTimeout(() => {
        timer = undefined
        void drain()
      }, 150)
    },
    dispose() {
      disposed = true
      dirty = false
      clearTimeout(timer)
    },
  }
}
