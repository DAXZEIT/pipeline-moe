// LocalModelLock — process-global semaphore(1) for llama-server inference.
//
// llama-server runs with --parallel 1: only one inference slot. When multiple
// rooms are active, local-model agents must be serialized. Cloud agents bypass
// this lock entirely (they hit independent endpoints).
//
// The lock is held by RoomManager and injected into each Room at creation.
// Room.executeAgent() acquires before inference, releases in `finally`.

/** Async semaphore with capacity 1 for serializing local-model inference. */
export class LocalModelLock {
  private held = false
  private readonly queue: Array<() => void> = []

  /**
   * Acquire the lock. Resolves immediately if free; otherwise queues and waits
   * until the current holder calls release().
   */
  async acquire(): Promise<void> {
    if (!this.held) {
      this.held = true
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  /**
   * Release the lock. If there are waiting callers, the next one is unblocked.
   * Calling release() when nothing was acquired is a no-op (safe).
   */
  release(): void {
    const next = this.queue.shift()
    if (next) {
      // Hand ownership directly to the next waiter — held stays true.
      next()
    } else {
      this.held = false
    }
  }

  /** Whether the lock is currently held (useful for testing). */
  get isHeld(): boolean {
    return this.held
  }

  /** Number of callers waiting to acquire (useful for testing). */
  get waitCount(): number {
    return this.queue.length
  }
}
