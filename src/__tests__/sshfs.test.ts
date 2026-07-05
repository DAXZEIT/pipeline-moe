import { describe, expect, test } from "vitest"
import { isSshTarget, mountpointFor, MOUNT_BASE } from "../sshfs.js"

// These cover the pure, deterministic logic — the part that decides whether a
// workspaceDir string is treated as a remote mount or a local path. The actual
// mount/unmount require the sshfs binary + a real SSH target and are validated
// manually against the VPS (plan step 5).

describe("isSshTarget", () => {
  test("matches user@host:/absolute-path", () => {
    expect(isSshTarget("alice@10.0.0.1:/home/alice")).toBe(true)
    expect(isSshTarget("dax@vps.example.com:/srv/project")).toBe(true)
  })

  test("matches user@host:relative-path", () => {
    expect(isSshTarget("dax@10.0.0.1:projects/foo")).toBe(true)
  })

  test("trims surrounding whitespace before matching", () => {
    expect(isSshTarget("  alice@10.0.0.1:/home/alice  ")).toBe(true)
  })

  test("rejects plain absolute local paths", () => {
    expect(isSshTarget("/home/alice/projects/foo")).toBe(false)
    expect(isSshTarget("/tmp")).toBe(false)
  })

  test("rejects relative local paths", () => {
    expect(isSshTarget("projects/foo")).toBe(false)
    expect(isSshTarget(".")).toBe(false)
  })

  test("rejects a local path that contains @ but no host:colon", () => {
    // A directory literally named with an @ must not be misread as a target.
    expect(isSshTarget("/home/weird@dir")).toBe(false)
  })

  test("rejects user@host with no path after the colon", () => {
    expect(isSshTarget("dax@10.0.0.1:")).toBe(false)
  })

  test("rejects empty / whitespace", () => {
    expect(isSshTarget("")).toBe(false)
    expect(isSshTarget("   ")).toBe(false)
  })
})

describe("mountpointFor", () => {
  test("derives a deterministic mountpoint under MOUNT_BASE", () => {
    expect(mountpointFor("room-abc")).toBe(`${MOUNT_BASE}/room-abc`)
  })

  test("the default room maps under MOUNT_BASE too", () => {
    expect(mountpointFor("default")).toBe(`${MOUNT_BASE}/default`)
  })

  test("mountpoint stays within MOUNT_BASE for sanitised ids", () => {
    // roomId is sanitised upstream to [a-zA-Z0-9_-]; confirm no escape for those.
    expect(mountpointFor("a_b-c123").startsWith(`${MOUNT_BASE}/`)).toBe(true)
  })
})
