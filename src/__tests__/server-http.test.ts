// HTTP-level coverage for src/server.ts. The Express layer (REST + SSE +
// middleware) was the project's biggest coverage hole — nothing in
// src/__tests__ imported server.ts, so ~60 routes, the rate limiters, the CORS
// setup and the SSE framing were only ever exercised manually (live-verify).
//
// The whole app is built inside main() with nothing exported, so rather than
// carve a seam out of a 2300-line closure these tests boot the REAL server as
// a subprocess (tsx src/server.ts) against a throwaway workspace and drive it
// over fetch. That covers the layer as shipped: middleware order, validation
// status codes, the shell rate limiter, and SSE event framing included.
//
// Hermetic by construction: the child runs with cwd = fresh tmpdir (so the
// repo's .env is never loaded), WORKSPACE_DIR/SESSIONS_DIR/PIPELINE_PLANS_DIR
// pointed into the tmpdir, skills from the bundled repo dir, and VITEST
// stripped from its env so config.ts takes the production code path.
// PIPELINE_MAX_ROOMS=3 makes the room-cap rejection (429) reachable with the
// default room live. No model is ever called — only routes that queue turns
// are tested on their validation paths, never through to inference.

import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx")

let child: ChildProcess
let base = ""
let wsDir = ""
let logTail: string[] = []

function pushLog(chunk: unknown): void {
  for (const line of String(chunk).split("\n")) {
    if (line.trim()) {
      logTail.push(line)
      if (logTail.length > 60) logTail.shift()
    }
  }
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers:
      body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

/** JSON body + status in one call — every assertion here is on both. */
async function j<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await api(method, path, body)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
}

interface SseEvent {
  event: string
  data: string
}

/** Incremental SSE frame reader: buffers across chunk boundaries until a full
 *  `event:`/`data:` block terminated by a blank line arrives. */
function sseReader(res: Response): {
  next(): Promise<SseEvent>
  cancel(): Promise<void>
} {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  return {
    async next(): Promise<SseEvent> {
      for (;;) {
        const sep = buf.indexOf("\n\n")
        if (sep >= 0) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          // The hub opens every stream with a ": connected" comment frame —
          // comment-only blocks carry no event; skip them.
          if (block.startsWith(":")) continue
          const event = /(?:^|\n)event: (.*)/.exec(block)?.[1] ?? "message"
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n")
          return { event, data }
        }
        const { done, value } = await reader.read()
        if (done)
          throw new Error(
            `SSE stream closed early; server log tail:\n${logTail.join("\n")}`,
          )
        buf += decoder.decode(value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}

beforeAll(async () => {
  wsDir = mkdtempSync(join(tmpdir(), "pmoe-http-ws-"))
  const port = await new Promise<number>((done) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port
      probe.close(() => done(p))
    })
  })
  base = `http://127.0.0.1:${port}`

  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(port),
    WORKSPACE_DIR: wsDir,
    SESSIONS_DIR: join(wsDir, "sessions"),
    PIPELINE_PLANS_DIR: join(wsDir, ".pi", "plans"),
    PIPELINE_SKILLS_DIR: join(repoRoot, "skills"),
    PIPELINE_MAX_ROOMS: "3",
  }
  delete env.VITEST // run the production config path, not the test one

  child = spawn(tsxBin, [join(repoRoot, "src", "server.ts")], {
    cwd: wsDir,
    env,
  })
  child.stdout!.on("data", pushLog)
  child.stderr!.on("data", pushLog)

  // tsx cold-compiles the pi packages and builds every seed session — poll
  // rather than betting on one fixed budget.
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(
        `server did not become healthy in 120s; log tail:\n${logTail.join("\n")}`,
      )
    }
    if (child.exitCode !== null) {
      throw new Error(
        `server exited during boot (code ${child.exitCode}); log tail:\n${logTail.join("\n")}`,
      )
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}, 150_000)

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    const exited = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), 15_000)
      child.once("exit", () => {
        clearTimeout(timer)
        done(true)
      })
    })
    if (!exited) child.kill("SIGKILL")
  }
  rmSync(wsDir, { recursive: true, force: true })
}, 30_000)

describe("health & read-only surface", () => {
  test("GET /api/health reports ok and the test workspace", async () => {
    const { status, body } = await j<{
      ok: boolean
      workspace: string
      clients: number
    }>("GET", "/api/health")
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.workspace).toBe(wsDir)
    expect(typeof body.clients).toBe("number")
  })

  test("GET /api/participants returns the seeded default roster", async () => {
    const { status, body } = await j<Array<{ id: string }>>(
      "GET",
      "/api/participants",
    )
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThan(0)
  })

  test("GET /api/persona-templates lists the seed templates", async () => {
    const { status, body } = await j<
      Array<{ id: string; name: string; tools: string[] }>
    >("GET", "/api/persona-templates")
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]).toHaveProperty("tools")
  })

  test("GET /api/models enforces the local-only policy", async () => {
    const { status, body } = await j<{
      models: unknown[]
      allowCloud: boolean
    }>("GET", "/api/models")
    expect(status).toBe(200)
    expect(body.allowCloud).toBe(false)
    expect(Array.isArray(body.models)).toBe(true)
  })

  test("GET /api/providers lists providers without secrets", async () => {
    const { status, body } = await j<{
      providers: unknown[]
      explicitlyEnabled: string[]
    }>("GET", "/api/providers")
    expect(status).toBe(200)
    expect(Array.isArray(body.providers)).toBe(true)
    expect(body.explicitlyEnabled).toEqual([])
  })

  test("GET /api/transcript, /api/tasks and /api/workspace return listings", async () => {
    expect((await j("GET", "/api/transcript")).status).toBe(200)
    expect((await j("GET", "/api/tasks")).status).toBe(200)
    const ws = await j<Array<{ path: string }>>("GET", "/api/workspace")
    expect(ws.status).toBe(200)
    expect(Array.isArray(ws.body)).toBe(true)
  })

  test("GET /api/settings returns the full settings payload", async () => {
    const { status, body } = await j<Record<string, unknown>>(
      "GET",
      "/api/settings",
    )
    expect(status).toBe(200)
    expect(body).toHaveProperty("routingMode")
    expect(body).toHaveProperty("handoffGates")
    expect(body).toHaveProperty("maxRooms", 3)
  })
})

describe("presets over HTTP", () => {
  test("GET /api/presets seeds the two built-in defaults", async () => {
    const { status, body } = await j<Array<{ name: string }>>(
      "GET",
      "/api/presets",
    )
    expect(status).toBe(200)
    expect(body.map((p) => p.name)).toEqual(
      expect.arrayContaining(["local-default", "cloud-sprint"]),
    )
  })

  test("PUT /api/presets/:name writes a composed preset and reports it back", async () => {
    const res = await j<{
      preset: { name: string; personas: Array<{ id: string }> }
    }>("PUT", "/api/presets/http-team", {
      personas: [{ name: "Http Agent", tools: ["read"] }],
    })
    expect(res.status).toBe(200)
    expect(res.body.preset.name).toBe("http-team")
    expect(res.body.preset.personas[0].id).toBe("http-agent")
    const list = await j<Array<{ name: string }>>("GET", "/api/presets")
    expect(list.body.map((p) => p.name)).toContain("http-team")
  })

  test("PUT rejects an invalid preset document with 400", async () => {
    expect((await j("PUT", "/api/presets/bad-team", {})).status).toBe(400)
    expect(
      (
        await j("PUT", "/api/presets/bad-team", {
          personas: [{ name: "X", tools: ["rm_rf"] }],
        })
      ).status,
    ).toBe(400)
    // "???" would land in the query string, not the path — use URL-safe chars
    // that the name sanitizer strips to nothing.
    expect(
      (await j("PUT", "/api/presets/!!!", { personas: [{ name: "X" }] }))
        .status,
    ).toBe(400)
  })

  test("POST /api/presets snapshots the live roster; an empty name is 400", async () => {
    const snap = await j<{ name: string }>("POST", "/api/presets", {
      name: "http-snap",
    })
    expect(snap.status).toBe(201)
    expect(snap.body.name).toBe("http-snap")
    expect((await j("POST", "/api/presets", { name: "" })).status).toBe(400)
  })

  test("loading a missing preset is 404; pushing without a source preset is 409", async () => {
    expect((await j("POST", "/api/presets/nope/load")).status).toBe(404)
    const push = await j<{ error: string }>(
      "POST",
      "/api/presets/http-team/push",
    )
    expect(push.status).toBe(409)
    expect(push.body.error).toContain("nothing to push")
  })

  test("DELETE removes a preset; deleting it again is 404", async () => {
    expect((await api("DELETE", "/api/presets/http-team")).status).toBe(204)
    const again = await j<{ error: string }>("DELETE", "/api/presets/http-team")
    expect(again.status).toBe(404)
  })
})

describe("media serving (path-traversal regression, review 2026-08-24 #1)", () => {
  test("a file inside mediaDir is served", async () => {
    mkdirSync(join(wsDir, "media"), { recursive: true })
    writeFileSync(
      join(wsDir, "media", "visible.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )
    const res = await api("GET", "/api/media/visible.png")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("PNG")
  })

  test("a real file OUTSIDE mediaDir is not served via ../ — 404, not the bytes", async () => {
    // The file exists on disk: only the assertInside guard stops this.
    writeFileSync(join(wsDir, "hidden.png"), "TOP-SECRET")
    const res = await api("GET", "/api/media/..%2Fhidden.png")
    expect(res.status).toBe(404)
  })

  test("a deeper traversal ending in an allowed extension is 404 too", async () => {
    const res = await api("GET", "/api/media/..%2F..%2F..%2Ftmp%2Fnope.png")
    expect(res.status).toBe(404)
  })

  test("a disallowed extension is rejected before any disk access", async () => {
    writeFileSync(join(wsDir, "media", "notes.txt"), "hello")
    const res = await api("GET", "/api/media/notes.txt")
    expect(res.status).toBe(400)
  })
})

describe("participants over HTTP", () => {
  test("unknown participant is 404 on GET and PATCH", async () => {
    expect((await j("GET", "/api/participants/ghost")).status).toBe(404)
    expect(
      (await j("PATCH", "/api/participants/ghost", { name: "X" })).status,
    ).toBe(404)
  })

  test("create → duplicate is 409 → invalid body is 400", async () => {
    const created = await j<{ id: string }>("POST", "/api/participants", {
      name: "Http Tester",
      systemPrompt: "A test agent.",
      tools: ["read"],
    })
    expect(created.status).toBe(201)
    expect(created.body.id).toBe("http-tester")
    const dup = await j<{ error: string }>("POST", "/api/participants", {
      name: "Http Tester",
      systemPrompt: "Duplicate.",
    })
    expect(dup.status).toBe(409)
    expect((await j("POST", "/api/participants", { name: "" })).status).toBe(
      400,
    )
  })

  test("PATCH validates thinkingLevel, model (cloud disabled) and compaction size", async () => {
    expect(
      (
        await j("PATCH", "/api/participants/http-tester", {
          thinkingLevel: "ultra",
        })
      ).status,
    ).toBe(400)
    const model = await j<{ error: string }>(
      "PATCH",
      "/api/participants/http-tester",
      {
        model: "anthropic/claude-x",
      },
    )
    expect(model.status).toBe(400)
    expect(model.body.error).toContain("cloud is disabled")
    expect(
      (
        await j("PATCH", "/api/participants/http-tester", {
          compactionInstructions: "x".repeat(501),
        })
      ).status,
    ).toBe(400)
  })

  test("PATCH applies a valid thinkingLevel fast path and a persona edit", async () => {
    const fast = await j<{ id: string; thinkingLevel?: string }>(
      "PATCH",
      "/api/participants/http-tester",
      {
        thinkingLevel: "low",
      },
    )
    expect(fast.status).toBe(200)
    expect(fast.body.thinkingLevel).toBe("low")
    const heavy = await j<{ name: string; color: string }>(
      "PATCH",
      "/api/participants/http-tester",
      {
        name: "Http Tester II",
        color: "#123456",
      },
    )
    expect(heavy.status).toBe(200)
    expect(heavy.body.name).toBe("Http Tester II")
  })

  test("reorder validates its body and applies a valid order", async () => {
    expect(
      (await j("POST", "/api/participants/reorder", { order: "nope" })).status,
    ).toBe(400)
    const before = (
      await j<Array<{ id: string }>>("GET", "/api/participants")
    ).body.map((p) => p.id)
    const reversed = await j<Array<{ id: string }>>(
      "POST",
      "/api/participants/reorder",
      {
        order: [...before].reverse(),
      },
    )
    expect(reversed.status).toBe(200)
    expect(reversed.body.map((p) => p.id)).toEqual([...before].reverse())
  })

  test("from-template rejects an unknown template", async () => {
    expect(
      (
        await j("POST", "/api/participants/from-template", {
          templateId: "ghost",
        })
      ).status,
    ).toBe(400)
  })

  test("delete → 204, second delete → 404", async () => {
    expect((await api("DELETE", "/api/participants/http-tester")).status).toBe(
      204,
    )
    expect((await j("DELETE", "/api/participants/http-tester")).status).toBe(
      404,
    )
  })
})

describe("settings validation", () => {
  test("PATCH rejects invalid routingMode, maxChainHops and booleans with 400", async () => {
    expect(
      (await j("PATCH", "/api/settings", { routingMode: "wild" })).status,
    ).toBe(400)
    expect(
      (await j("PATCH", "/api/settings", { maxChainHops: 0 })).status,
    ).toBe(400)
    expect(
      (await j("PATCH", "/api/settings", { chaining: "yes" })).status,
    ).toBe(400)
    expect(
      (await j("PATCH", "/api/settings", { compactionReserveTokens: 100 }))
        .status,
    ).toBe(400)
    expect(
      (await j("PATCH", "/api/settings", { defaultThinkingLevel: "ultra" }))
        .status,
    ).toBe(400)
    expect(
      (await j("PATCH", "/api/settings", { handoffGates: "nope" })).status,
    ).toBe(400)
  })

  test("PATCH rejects an unknown defaultAgent with 404, applies a valid routingMode", async () => {
    expect(
      (await j("PATCH", "/api/settings", { defaultAgent: "ghost" })).status,
    ).toBe(404)
    const patched = await j<{ routingMode: string }>("PATCH", "/api/settings", {
      routingMode: "semi",
    })
    expect(patched.status).toBe(200)
    expect(patched.body.routingMode).toBe("semi")
  })
})

describe("routing decisions, steer, abort, message validation", () => {
  test("POST /api/route validates the action, accepts a valid decision", async () => {
    expect((await j("POST", "/api/route", {})).status).toBe(400)
    expect((await j("POST", "/api/route", { action: "drop" })).status).toBe(202)
  })

  test("POST /api/messages requires text", async () => {
    expect((await j("POST", "/api/messages", {})).status).toBe(400)
  })

  test("steer validates fields, maps unknown target to 404 and idle agent to 409", async () => {
    expect((await j("POST", "/api/messages/steer", {})).status).toBe(400)
    expect(
      (await j("POST", "/api/messages/steer", { target: "ghost", text: "hi" }))
        .status,
    ).toBe(404)
    const roster = (await j<Array<{ id: string }>>("GET", "/api/participants"))
      .body
    const idle = await j<{ error: string }>("POST", "/api/messages/steer", {
      target: roster[0].id,
      text: "poke",
    })
    expect(idle.status).toBe(409)
    expect(idle.body.error).toContain("not running")
  })

  test("POST /api/abort on an idle room reports nothing aborted", async () => {
    const { status, body } = await j<{ aborted: boolean }>("POST", "/api/abort")
    expect(status).toBe(200)
    expect(body.aborted).toBe(false)
  })
})

describe("shell over HTTP", () => {
  test("POST /api/shell runs the command in the workspace and posts the record", async () => {
    const { status, body } = await j<{ text: string }>("POST", "/api/shell", {
      command: "echo hello-http",
    })
    expect(status).toBe(200)
    expect(body.text).toContain("$ echo hello-http")
    expect(body.text).toContain("hello-http")
  })

  test("POST /api/shell without a command is 400", async () => {
    expect((await j("POST", "/api/shell", {})).status).toBe(400)
  })

  test("POST /api/shell/record posts a client-run command without executing", async () => {
    const { status, body } = await j<{ text: string }>(
      "POST",
      "/api/shell/record",
      {
        command: "echo client-side",
        output: "client-side",
        exitCode: 0,
      },
    )
    expect(status).toBe(200)
    expect(body.text).toContain("$ echo client-side")
  })

  test("room-scoped shell is rate limited: 30 per window, then 429", async () => {
    // The default-route limiter and the room-scoped limiter are separate
    // instances, so burning this one leaves /api/shell functional. 40 attempts
    // in one window: exactly the first 30 pass.
    const statuses: number[] = []
    for (let i = 0; i < 40; i++) {
      const res = await api("POST", "/api/rooms/default/shell", {
        command: "true",
      })
      statuses.push(res.status)
      await res.arrayBuffer() // drain so the socket can be reused
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(200))
    expect(statuses.slice(30)).toEqual(Array(10).fill(429))
  }, 60_000)
})

describe("conversations over HTTP", () => {
  let convId = ""

  test("POST creates, GET lists, PATCH renames", async () => {
    const created = await j<{ id: string; title: string }>(
      "POST",
      "/api/conversations",
      {
        title: "HTTP Convo",
      },
    )
    expect(created.status).toBe(201)
    convId = created.body.id
    const list = await j<{ currentId: string; list: Array<{ id: string }> }>(
      "GET",
      "/api/conversations",
    )
    expect(list.body.list.map((c) => c.id)).toContain(convId)
    expect(
      (await j("PATCH", `/api/conversations/${convId}`, { title: "" })).status,
    ).toBe(400)
    expect(
      (await j("PATCH", `/api/conversations/ghost`, { title: "x" })).status,
    ).toBe(404)
    expect(
      (await j("PATCH", `/api/conversations/${convId}`, { title: "Renamed" }))
        .status,
    ).toBe(200)
  })

  test("load works; a deleted conversation loads as 404; delete is idempotent", async () => {
    expect((await j("POST", `/api/conversations/${convId}/load`)).status).toBe(
      200,
    )
    expect((await api("DELETE", `/api/conversations/${convId}`)).status).toBe(
      204,
    )
    expect((await j("POST", `/api/conversations/${convId}/load`)).status).toBe(
      404,
    )
    // store.remove swallows ENOENT — a second delete is a 204 no-op, not an error.
    expect((await j("DELETE", `/api/conversations/${convId}`)).status).toBe(204)
  })
})

describe("rooms over HTTP", () => {
  let soloRoomId = ""

  test("GET /api/rooms lists the default room; unknown room is 404", async () => {
    const { status, body } = await j<Array<{ roomId: string }>>(
      "GET",
      "/api/rooms",
    )
    expect(status).toBe(200)
    expect(body.map((r) => r.roomId)).toContain("default")
    expect((await j("GET", "/api/rooms/ghost")).status).toBe(404)
  })

  test("POST spawns a solo room and reports its details", async () => {
    const res = await j<{ roomId: string; name: string; goalStatus: string }>(
      "POST",
      "/api/rooms",
      {
        name: "Solo A",
        solo: true,
      },
    )
    expect(res.status).toBe(201)
    expect(res.body.roomId).toMatch(/^solo-/)
    expect(res.body.name).toBe("Solo A")
    soloRoomId = res.body.roomId
    const details = await j<{ name: string; participantCount: number }>(
      "GET",
      `/api/rooms/${soloRoomId}`,
    )
    expect(details.status).toBe(200)
    expect(details.body.name).toBe("Solo A")
  })

  test("provision validation: duplicate id 409, solo+preset 400, bad scope 400", async () => {
    const dup = await j<{ error: string }>("POST", "/api/rooms", {
      roomId: soloRoomId,
      name: "Dup",
    })
    expect(dup.status).toBe(409)
    expect(
      (
        await j("POST", "/api/rooms", {
          name: "X",
          solo: true,
          preset: "local-default",
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await j("POST", "/api/rooms", {
          name: "X",
          workspaceDir: "/nonexistent-scope-xyz",
        })
      ).status,
    ).toBe(400)
  })

  test("a preset-named room spawns with the preset roster", async () => {
    const res = await j<{ roomId: string; participantCount: number }>(
      "POST",
      "/api/rooms",
      {
        name: "Preset Room",
        preset: "local-default",
      },
    )
    expect(res.status).toBe(201)
    expect(res.body.participantCount).toBeGreaterThan(0)
    expect((await api("DELETE", `/api/rooms/${res.body.roomId}`)).status).toBe(
      204,
    )
  })

  test("the global room cap rejects the next spawn with 429", async () => {
    // default + Solo A live (2 of 3) — the preset room was destroyed above.
    const res = await j<{ roomId: string }>("POST", "/api/rooms", {
      name: "Cap Room",
      solo: true,
    })
    expect(res.status).toBe(201)
    const over = await j<{ error: string }>("POST", "/api/rooms", {
      name: "Over Cap",
      solo: true,
    })
    expect(over.status).toBe(429)
    expect(over.body.error).toContain("room limit")
    expect((await api("DELETE", `/api/rooms/${res.body.roomId}`)).status).toBe(
      204,
    )
  })

  test("PATCH renames a room", async () => {
    const res = await j<{ roomId: string; name: string }>(
      "PATCH",
      `/api/rooms/${soloRoomId}`,
      {
        name: "Solo A Renamed",
      },
    )
    expect(res.status).toBe(200)
    expect(res.body.name).toBe("Solo A Renamed")
  })

  test("fork copies a live room into a new one", async () => {
    const res = await j<{ roomId: string; name: string }>(
      "POST",
      `/api/rooms/${soloRoomId}/fork`,
      {},
    )
    expect(res.status).toBe(201)
    expect(res.body.name).toContain("fork")
    expect((await api("DELETE", `/api/rooms/${res.body.roomId}`)).status).toBe(
      204,
    )
    expect((await j("POST", "/api/rooms/ghost/fork", {})).status).toBe(404)
  })

  test("delete protects the default room; unknown room is 404", async () => {
    expect((await j("DELETE", "/api/rooms/default")).status).toBe(400)
    expect((await j("DELETE", "/api/rooms/ghost")).status).toBe(404)
  })

  test("a destroyed room stays resumable and can be resumed over HTTP", async () => {
    expect((await api("DELETE", `/api/rooms/${soloRoomId}`)).status).toBe(204)
    const resumable = await j<Array<{ roomId: string }>>(
      "GET",
      "/api/rooms/resumable",
    )
    expect(resumable.body.map((r) => r.roomId)).toContain(soloRoomId)
    const resumed = await j<{ roomId: string }>(
      "POST",
      `/api/rooms/${soloRoomId}/resume`,
    )
    expect(resumed.status).toBe(200)
    // A live room cannot be resumed again.
    expect((await j("POST", `/api/rooms/${soloRoomId}/resume`)).status).toBe(
      409,
    )
    expect((await api("DELETE", `/api/rooms/${soloRoomId}`)).status).toBe(204)
  })
})

describe("room-scoped router mirrors the legacy routes", () => {
  test("scoped participants match the legacy route; unknown room is 404", async () => {
    const legacy = await j<Array<{ id: string }>>("GET", "/api/participants")
    const scoped = await j<Array<{ id: string }>>(
      "GET",
      "/api/rooms/default/participants",
    )
    expect(scoped.status).toBe(200)
    expect(scoped.body.map((p) => p.id)).toEqual(legacy.body.map((p) => p.id))
    expect((await j("GET", "/api/rooms/ghost/participants")).status).toBe(404)
    expect((await j("GET", "/api/rooms/ghost/settings")).status).toBe(404)
  })

  test("scoped settings PATCH validates like the legacy route", async () => {
    expect(
      (await j("PATCH", "/api/rooms/default/settings", { routingMode: "wild" }))
        .status,
    ).toBe(400)
    const res = await j<{ routingMode: string }>(
      "PATCH",
      "/api/rooms/default/settings",
      {
        routingMode: "auto",
      },
    )
    expect(res.status).toBe(200)
    expect(res.body.routingMode).toBe("auto")
  })

  test("scoped messages and conversations work on the named room", async () => {
    expect((await j("POST", "/api/rooms/default/messages", {})).status).toBe(
      400,
    )
    const conv = await j<{ id: string }>(
      "POST",
      "/api/rooms/default/conversations",
      {
        title: "Scoped Convo",
      },
    )
    expect(conv.status).toBe(201)
    expect(
      (await api("DELETE", `/api/rooms/default/conversations/${conv.body.id}`))
        .status,
    ).toBe(204)
  })
})

describe("SSE streams", () => {
  test("per-room /events delivers the roster and transcript frames on connect", async () => {
    const res = await fetch(`${base}/api/rooms/default/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const sse = sseReader(res)
    const roster = await sse.next()
    expect(roster.event).toBe("roster")
    expect(JSON.parse(roster.data).length).toBeGreaterThan(0)
    const transcript = await sse.next()
    expect(transcript.event).toBe("transcript")
    expect(Array.isArray(JSON.parse(transcript.data))).toBe(true)
    await sse.cancel()
  })

  test("global /events streams room lifecycle events (rename)", async () => {
    const res = await fetch(`${base}/api/events`)
    expect(res.status).toBe(200)
    const sse = sseReader(res)
    expect((await sse.next()).event).toBe("roster") // initial write on connect
    const rename = await api("PATCH", "/api/rooms/default", {
      name: "Main (HTTP)",
    })
    expect(rename.status).toBe(200)
    const event = await sse.next()
    expect(event.event).toBe("room")
    const data = JSON.parse(event.data) as {
      type: string
      roomId: string
      name: string
    }
    expect(data.type).toBe("renamed")
    expect(data.roomId).toBe("default")
    expect(data.name).toBe("Main (HTTP)")
    await sse.cancel()
  })
})

describe("provider credentials (negative paths only — no real auth.json writes)", () => {
  test("setting a key for an unknown provider is 404; a missing key is 400", async () => {
    expect((await j("POST", "/api/providers/ghost", { key: "x" })).status).toBe(
      404,
    )
    expect((await j("POST", "/api/providers/anthropic", {})).status).toBe(400)
  })

  test("the local provider cannot be removed", async () => {
    const res = await j<{ error: string }>("DELETE", "/api/providers/local")
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("local")
  })

  test("OAuth endpoints on a non-OAuth provider are 404", async () => {
    expect((await j("POST", "/api/providers/ghost/login")).status).toBe(404)
    expect(
      (await j("POST", "/api/providers/ghost/login/input", { value: "x" }))
        .status,
    ).toBe(404)
    expect((await j("DELETE", "/api/providers/ghost/login")).status).toBe(404)
  })
})

describe("transcript rollback over HTTP", () => {
  test("an out-of-range keep is 400; keep=0 truncates", async () => {
    expect(
      (await j("POST", "/api/transcript/rollback", { keep: 999_999 })).status,
    ).toBe(400)
    const res = await j<{ ok: boolean; removed: number }>(
      "POST",
      "/api/transcript/rollback",
      { keep: 0 },
    )
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.removed).toBeGreaterThanOrEqual(1) // shell/steer records landed above
  })
})
