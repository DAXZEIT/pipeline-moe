import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import { ConversationStore } from "../store.js"
import type { Conversation } from "../types.js"

let dir: string
let store: ConversationStore

const makeConv = (id: string): Conversation => ({
  id,
  title: "test",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  chaining: false,
  defaultAgent: null,
  personas: [],
  transcript: [],
})

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pipeline-moe-test-"))
  store = new ConversationStore(dir)
  await store.init()
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("write and read a conversation", async () => {
  const conv = makeConv("abc123")
  await store.write(conv)
  const got = await store.read("abc123")
  expect(got).not.toBeNull()
  expect(got!.id).toBe("abc123")
})

test("read non-existent returns null", async () => {
  const got = await store.read("no-such-id")
  expect(got).toBeNull()
})

test("list returns metadata for written conversations", async () => {
  const conv = makeConv("list-test")
  await store.write(conv)
  const list = await store.list()
  expect(list.some((m) => m.id === "list-test")).toBe(true)
})

test("remove deletes a conversation", async () => {
  const conv = makeConv("rm-test")
  await store.write(conv)
  expect(await store.read("rm-test")).not.toBeNull()
  await store.remove("rm-test")
  expect(await store.read("rm-test")).toBeNull()
})

// ── Concurrent-write race (live bug 2026-07-11) ────────────────────────
// A fixed tmp path made two overlapping writes of the same id collide: the
// losing rename threw ENOENT (crashing the server as an unhandled rejection)
// or dropped the snapshot. write() is now serialized + unique-tmp'd.

test("concurrent writes of the same id do not throw (ENOENT race)", async () => {
  const writes = Array.from({ length: 25 }, (_, i) => {
    const c = makeConv("race")
    c.title = `v${i}`
    return store.write(c)
  })
  // Before the fix, some of these reject with ENOENT on rename.
  await expect(Promise.all(writes)).resolves.toBeDefined()
  const got = await store.read("race")
  expect(got).not.toBeNull()
  // Last-invoked write wins (serialized in call order).
  expect(got!.title).toBe("v24")
})

test("a failed write does not wedge later writes", async () => {
  // A traversal id rejects inside file(); the chain must survive it.
  await expect(store.write(makeConv("../../evil"))).rejects.toThrow()
  const conv = makeConv("after-failure")
  await store.write(conv)
  expect(await store.read("after-failure")).not.toBeNull()
})

// ── Path traversal guards ──────────────────────────────────────────────
// Note: read() and remove() wrap in try/catch and swallow errors (return null/undefined).
// write() throws before the file operation because assertInside runs in file() first.

test("write with traversal id throws Permission denied", async () => {
  const conv = makeConv("../../../etc/passwd")
  await expect(store.write(conv)).rejects.toThrow("Permission denied")
})

test("write with traversal in middle of id throws", async () => {
  const conv = makeConv("foo/../../etc/passwd")
  await expect(store.write(conv)).rejects.toThrow("Permission denied")
})

test("write with adjacent sibling traversal throws", async () => {
  const conv = makeConv("../sibling")
  await expect(store.write(conv)).rejects.toThrow("Permission denied")
})

test("read with traversal id returns null (error swallowed by try/catch)", async () => {
  // read() wraps in try/catch and returns null on any error — including assertInside throws.
  // This is a known limitation: the guard prevents the write, but read just returns null.
  const got = await store.read("../../../etc/passwd")
  expect(got).toBeNull()
})

// ── Room isolation: two stores share no conversations ──────────────────
test("two rooms with separate dirs are fully isolated", async () => {
  const room1Dir = join(dir, "room1")
  const room2Dir = join(dir, "room2")
  const store1 = new ConversationStore(room1Dir)
  const store2 = new ConversationStore(room2Dir)
  await store1.init()
  await store2.init()

  // Write a conversation to room1 only
  const conv = makeConv("room-iso-conv")
  await store1.write(conv)

  // Room2 should not see it
  const fromRoom2 = await store2.read("room-iso-conv")
  expect(fromRoom2).toBeNull()

  // Room2 list should be empty
  const list2 = await store2.list()
  expect(list2.find((m) => m.id === "room-iso-conv")).toBeUndefined()

  // Room1 should still have it
  const fromRoom1 = await store1.read("room-iso-conv")
  expect(fromRoom1).not.toBeNull()
  expect(fromRoom1!.id).toBe("room-iso-conv")
})
