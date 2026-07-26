// LocalModelLock — process-global semaphore for llama-server inference.
//
// llama-server serves a bounded number of inference slots (--parallel N, 2 since
// 2026-07-18). When multiple rooms are active, local-model agents contend for
// them, so this semaphore serializes past capacity. Cloud agents bypass the lock
// entirely (they hit independent endpoints).
//
// Capacity is injected (config.localSlots, PIPELINE_LOCAL_SLOTS) rather than
// hardcoded: a lock that claims 1 slot while the server serves 2 makes every
// occupancy report a lie, and `pipeline_status` reports occupancy to an agent
// that routes on it (docs/orchestrator-room.md).
//
// The lock is held by RoomManager and injected into each Room at creation.
// Room.executeAgent() acquires before inference, releases in `finally`, and
// labels both with its roomId so the holder is nameable.

/** Async counting semaphore for local-model inference. Capacity defaults to 1. */
export class LocalModelLock {
  /** One entry per in-flight acquisition, labelled with its owner. */
  private readonly holders: string[] = []
  private readonly queue: Array<{ owner: string; resolve: () => void }> = []

  constructor(readonly capacity: number = 1) {}

  /**
   * Acquire a slot. Resolves immediately while below capacity; otherwise queues
   * and waits until a holder calls release(). `owner` is a label for reporting
   * (the roomId) — it does not affect scheduling.
   */
  async acquire(owner = "?"): Promise<void> {
    if (this.holders.length < this.capacity) {
      this.holders.push(owner)
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ owner, resolve })
    })
  }

  /**
   * Release a slot. If callers are waiting, the next one is unblocked and takes
   * the freed slot directly. Releasing without a matching acquire is a no-op
   * (safe). An unknown owner drops an arbitrary slot rather than none — losing
   * the label is recoverable, leaking a slot is not.
   */
  release(owner = "?"): void {
    const i = this.holders.indexOf(owner)
    if (i >= 0) this.holders.splice(i, 1)
    else this.holders.pop()
    const next = this.queue.shift()
    if (next) {
      this.holders.push(next.owner)
      next.resolve()
    }
  }

  /** Whether any slot is currently taken. */
  get isHeld(): boolean {
    return this.holders.length > 0
  }

  /** Slots currently taken. */
  get inUse(): number {
    return this.holders.length
  }

  /** Number of callers waiting to acquire. */
  get waitCount(): number {
    return this.queue.length
  }

  /** Labels of the current holders, in acquisition order. */
  get owners(): string[] {
    return [...this.holders]
  }

  /** Labels of the queued callers, in wait order. */
  get waiters(): string[] {
    return this.queue.map((q) => q.owner)
  }
}
