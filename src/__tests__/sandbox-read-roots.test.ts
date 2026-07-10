import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { buildConfinedTools } from "../sandbox-tools.js"

// Persona skill roots live outside the workspace; the READ tool must be able
// to open them (that's how an agent loads a SKILL.md body on demand) while
// write/edit stay strictly workspace-confined.

const ws = mkdtempSync(join(tmpdir(), "pmoe-ws-"))
const skillRoot = mkdtempSync(join(tmpdir(), "pmoe-skill-"))
mkdirSync(join(skillRoot, "orchestrator"), { recursive: true })
writeFileSync(join(skillRoot, "orchestrator", "SKILL.md"), "# Orchestrator playbook\n")
writeFileSync(join(ws, "inside.txt"), "workspace file\n")

afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(skillRoot, { recursive: true, force: true })
})

const toolByName = (tools: ReturnType<typeof buildConfinedTools>, name: string) => {
  const t = tools.find((t) => t.name === name)
  if (!t) throw new Error(`tool ${name} not built`)
  return t
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => ("text" in c ? c.text : "")).join("\n")

describe("buildConfinedTools — extra read roots", () => {
  const extra = join(skillRoot, "orchestrator")
  const tools = buildConfinedTools(ws, ["read", "write"], [extra])

  it("read opens files under an extra root", async () => {
    const r = await (toolByName(tools, "read").execute as CallableFunction)("t1", { path: join(extra, "SKILL.md") })
    expect(textOf(r)).toContain("Orchestrator playbook")
  })

  it("read still works inside the workspace and still denies elsewhere", async () => {
    const ok = await (toolByName(tools, "read").execute as CallableFunction)("t2", { path: join(ws, "inside.txt") })
    expect(textOf(ok)).toContain("workspace file")
    const denied = await (toolByName(tools, "read").execute as CallableFunction)("t3", { path: join(skillRoot, "..", "somewhere-else.txt") }).then(
      (r: { isError?: boolean; content: Array<{ text?: string }> }) => r,
      (err: Error) => ({ isError: true, content: [{ text: err.message }] }),
    )
    expect(JSON.stringify(denied)).toMatch(/outside the allowed directory|denied|ENOENT|error/i)
  })

  it("write never gains the extra root", async () => {
    const r = await (toolByName(tools, "write").execute as CallableFunction)("t4", {
      path: join(extra, "evil.txt"),
      content: "nope",
    }).then(
      (x: unknown) => x,
      (err: Error) => ({ isError: true, content: [{ type: "text", text: err.message }] }),
    )
    expect(JSON.stringify(r)).toMatch(/outside the allowed directory/i)
  })
})
