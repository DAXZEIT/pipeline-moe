import { describe, expect, it } from "vitest"
import { prettyModel } from "../model-name"

describe("prettyModel", () => {
  it("drops the claude family prefix and folds the version", () => {
    expect(prettyModel("anthropic/claude-opus-4-8")).toBe("Opus 4.8")
    expect(prettyModel("anthropic/claude-fable-5")).toBe("Fable 5")
    expect(prettyModel("anthropic/claude-haiku-4-5")).toBe("Haiku 4.5")
  })

  it("drops a vendor word the id repeats from the ref path", () => {
    expect(prettyModel("openrouter/minimax/minimax-m3")).toBe("M3")
    expect(prettyModel("openrouter/deepseek/deepseek-v4-flash")).toBe("V4 Flash")
  })

  it("strips variant tags, .gguf and quant suffixes", () => {
    expect(prettyModel("local/Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf")).toBe("Qwopus3.6 27B V2 MTP")
    expect(prettyModel("openrouter/nvidia/nemotron-3-super-120b-a12b:free")).toBe("Nemotron 3 Super 120b A12b")
  })

  it("never empties: a bare vendor word survives", () => {
    expect(prettyModel("local/qwopus")).toBe("Qwopus")
    expect(prettyModel("anthropic/claude")).toBe("Claude")
  })
})
