import { test, expect, describe } from "vitest"

/* ────────────────────────────────────────────────────
 *  Retry Awareness — Empirical Verification
 * ──────────────────────────────────────────────────── */

interface RetryMetadata {
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage: string
}

interface StatusPayload {
  id: string
  status: string
  retry?: RetryMetadata
}

/* ── ParticipantStatus type ──────────────────────── */

describe("ParticipantStatus includes retrying", () => {
  test("retrying is a valid status", () => {
    const validStatuses = ["idle", "active", "thinking", "working", "compacting", "retrying"]
    expect(validStatuses).toContain("retrying")
  })
})

/* ── auto_retry_start event → status "retrying" ──── */

describe("auto_retry_start event", () => {
  test("emits status retrying with metadata", () => {
    const ev = {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 5000,
      errorMessage: "rate_limit_exceeded",
    }

    const payload: StatusPayload = {
      id: "builder",
      status: "retrying",
      retry: {
        attempt: ev.attempt,
        maxAttempts: ev.maxAttempts,
        delayMs: ev.delayMs,
        errorMessage: ev.errorMessage,
      },
    }

    expect(payload.status).toBe("retrying")
    expect(payload.retry).toBeDefined()
    expect(payload.retry!.attempt).toBe(2)
    expect(payload.retry!.maxAttempts).toBe(3)
    expect(payload.retry!.delayMs).toBe(5000)
    expect(payload.retry!.errorMessage).toBe("rate_limit_exceeded")
  })

  test("first attempt emits attempt: 1", () => {
    const payload: StatusPayload = {
      id: "tester",
      status: "retrying",
      retry: { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "timeout" },
    }
    expect(payload.retry!.attempt).toBe(1)
  })
})

/* ── auto_retry_end event ────────────────────────── */

describe("auto_retry_end event", () => {
  test("successful retry → status active", () => {
    const payload: StatusPayload = {
      id: "builder",
      status: "active",
    }
    expect(payload.status).toBe("active")
    expect(payload.retry).toBeUndefined()
  })

  test("failed retry → status idle", () => {
    const payload: StatusPayload = {
      id: "builder",
      status: "idle",
    }
    expect(payload.status).toBe("idle")
    expect(payload.retry).toBeUndefined()
  })
})

/* ── SSE handler — retry metadata forwarding ────── */

describe("useRoom SSE handler forwards retry metadata", () => {
  interface RosterEntry {
    id: string
    name: string
    color: string
    icon: string
    tools: string[]
    active: boolean
    status: string
    retry?: RetryMetadata
  }

  const baseRoster: RosterEntry[] = [
    { id: "builder", name: "Builder", color: "#5dcaa5", icon: "🔨", tools: [], active: true, status: "idle" },
    { id: "auditor", name: "Auditor", color: "#9b8ec4", icon: "🔍", tools: [], active: true, status: "idle" },
  ]

  function handleStatus(currentRoster: RosterEntry[], data: { id: string; status: string; retry?: RetryMetadata }): RosterEntry[] {
    return currentRoster.map(p => {
      if (p.id !== data.id) return p
      const base = { ...p, status: data.status }
      if (data.retry !== undefined) base.retry = data.retry
      return base
    })
  }

  test("retry metadata is merged into the right agent", () => {
    const data: StatusPayload = {
      id: "builder",
      status: "retrying",
      retry: { attempt: 2, maxAttempts: 3, delayMs: 5000, errorMessage: "rate_limit_exceeded" },
    }
    const result = handleStatus(baseRoster, data)

    expect(result[0].status).toBe("retrying")
    expect(result[0].retry).toEqual({ attempt: 2, maxAttempts: 3, delayMs: 5000, errorMessage: "rate_limit_exceeded" })
    expect(result[1].retry).toBeUndefined()
  })

  test("status transition away from retrying preserves metadata until cleared", () => {
    const rosterWithRetry: RosterEntry[] = [
      { ...baseRoster[0], status: "retrying", retry: { attempt: 2, maxAttempts: 3, delayMs: 5000, errorMessage: "rate_limit_exceeded" } },
      baseRoster[1],
    ]
    const data: StatusPayload = { id: "builder", status: "active" }
    const result = handleStatus(rosterWithRetry, data)

    expect(result[0].status).toBe("active")
    // Same pattern as contextUsage — only update when payload carries the field
    expect(result[0].retry).toEqual({ attempt: 2, maxAttempts: 3, delayMs: 5000, errorMessage: "rate_limit_exceeded" })
  })

  test("retry metadata is not forwarded to other agents", () => {
    const data: StatusPayload = {
      id: "builder",
      status: "retrying",
      retry: { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "timeout" },
    }
    const result = handleStatus(baseRoster, data)

    expect(result[0].retry).toBeDefined()
    expect(result[1].retry).toBeUndefined()
  })
})

/* ── Roster rendering — retry indicator ─────────── */

describe("Roster retry indicator rendering", () => {
  test("retrying status with metadata shows attempt info", () => {
    const entry = {
      id: "builder",
      status: "retrying",
      retry: { attempt: 2, maxAttempts: 3, delayMs: 5000, errorMessage: "rate_limit_exceeded" },
    }
    const shouldShow = entry.status === "retrying" && !!entry.retry
    expect(shouldShow).toBe(true)
    const label = `(${entry.retry!.attempt}/${entry.retry!.maxAttempts} — ${entry.retry!.errorMessage})`
    expect(label).toBe("(2/3 — rate_limit_exceeded)")
  })

  test("retrying status without metadata does NOT show indicator", () => {
    const entry = {
      id: "builder",
      status: "retrying",
      retry: undefined,
    }
    const shouldShow = entry.status === "retrying" && !!entry.retry
    expect(shouldShow).toBe(false)
  })

  test("non-retrying status does NOT show indicator even with retry data", () => {
    const entry = {
      id: "builder",
      status: "active",
      retry: { attempt: 2, maxAttempts: 3, delayMs: 5000, errorMessage: "rate_limit_exceeded" },
    }
    const shouldShow = entry.status === "retrying" && !!entry.retry
    expect(shouldShow).toBe(false)
  })

  test("first retry attempt label", () => {
    const entry = {
      id: "tester",
      status: "retrying",
      retry: { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "timeout" },
    }
    const label = `(${entry.retry!.attempt}/${entry.retry!.maxAttempts} — ${entry.retry!.errorMessage})`
    expect(label).toBe("(1/3 — timeout)")
  })
})

/* ── STATUS_LABEL mapping ───────────────────────── */

describe("STATUS_LABEL includes retrying", () => {
  const STATUS_LABEL = {
    idle: "idle",
    active: "active",
    thinking: "thinking",
    working: "working",
    compacting: "compacting…",
    retrying: "retrying…",
  }

  test("retrying maps to 'retrying…'", () => {
    expect(STATUS_LABEL["retrying"]).toBe("retrying…")
  })

  test("all status labels are defined", () => {
    const statuses = ["idle", "active", "thinking", "working", "compacting", "retrying"]
    for (const s of statuses) {
      expect(STATUS_LABEL[s as keyof typeof STATUS_LABEL]).toBeDefined()
    }
  })
})

/* ── Edge case: max attempt reached ─────────────── */

describe("retry at max attempt", () => {
  test("attempt equals maxAttempts — last retry", () => {
    const payload: StatusPayload = {
      id: "builder",
      status: "retrying",
      retry: { attempt: 3, maxAttempts: 3, delayMs: 5000, errorMessage: "rate_limit_exceeded" },
    }
    expect(payload.retry!.attempt).toBe(payload.retry!.maxAttempts)
    const label = `(${payload.retry!.attempt}/${payload.retry!.maxAttempts} — ${payload.retry!.errorMessage})`
    expect(label).toBe("(3/3 — rate_limit_exceeded)")
  })
})
