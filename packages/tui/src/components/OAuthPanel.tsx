import { Box, Text, useInput } from "ink"
import { useState } from "react"
import type { OAuthProgress } from "@pipeline-moe/client-core"

/**
 * OSC 8 terminal hyperlink (same encoding pi uses): supporting terminals
 * (Ghostty, kitty, WezTerm, iTerm2…) make the text clickable — which survives
 * line-wrapping, unlike selecting a wrapped URL by hand. Terminals without
 * support ignore the escapes and show the plain text.
 */
const link = (text: string, url: string) => `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`

const clickHint = process.platform === "darwin" ? "⌘+click to open ↗" : "Ctrl+click to open ↗"

/**
 * Persistent OAuth flow panel. Unlike the 5s notice, this stays on screen until
 * the flow reaches success/error (or the user dismisses), so a device-code URL +
 * code remains visible long enough to authenticate in a browser.
 *
 * For auth-URL flows (Anthropic, Codex) the panel shows the URL itself and an
 * input line: if the browser runs on another machine than the server, the
 * localhost callback never fires, and pasting the final redirect URL here
 * completes the flow (POST /login/input via onSubmitInput).
 */
export function OAuthPanel({
  progress,
  onDismiss,
  onSubmitInput,
  isActive,
}: {
  progress: OAuthProgress
  onDismiss: () => void
  onSubmitInput: (value: string) => void
  isActive: boolean
}) {
  const done = progress.status === "success" || progress.status === "error"
  const wantsInput = progress.status === "auth_url" || progress.status === "prompt"
  const [value, setValue] = useState("")

  useInput(
    (input, key) => {
      if (key.escape) return onDismiss()
      if (key.return) {
        if (done) return onDismiss()
        const v = value.trim()
        if (v && wantsInput) {
          onSubmitInput(v)
          setValue("")
        }
        return
      }
      if (!wantsInput) return
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return
      if (input) setValue((v) => (v + input).replace(/[\r\n\t]/g, ""))
    },
    { isActive },
  )

  const border = progress.status === "error" ? "red" : progress.status === "success" ? "green" : "blue"

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1}>
      <Text bold color={border}>
        OAuth · {progress.provider || "provider"}
      </Text>

      {progress.status === "device_code" ? (
        <>
          <Text>
            Visit{" "}
            <Text color="cyan" underline>
              {progress.verificationUri ? link(progress.verificationUri, progress.verificationUri) : ""}
            </Text>
          </Text>
          {progress.verificationUri ? (
            <Text dimColor>{link(clickHint, progress.verificationUri)}</Text>
          ) : null}
          <Text>
            Enter code <Text bold color="yellow">{progress.userCode}</Text>
          </Text>
        </>
      ) : null}
      {wantsInput ? (
        <>
          {progress.instructions || progress.message ? (
            <Text>{progress.status === "prompt" ? progress.message : progress.instructions}</Text>
          ) : null}
          {progress.url ? (
            <>
              <Text color="cyan" underline wrap="wrap">
                {link(progress.url, progress.url)}
              </Text>
              <Text dimColor>{link(clickHint, progress.url)}</Text>
            </>
          ) : null}
          <Box>
            <Text color="yellow">› </Text>
            {value ? (
              <Text>{value.length > 60 ? "…" + value.slice(-59) : value}</Text>
            ) : (
              <Text dimColor>{progress.placeholder ?? "paste the redirect URL here if needed"}</Text>
            )}
          </Box>
        </>
      ) : null}
      {progress.status === "progress" ? (
        <Text dimColor>{progress.message ?? "Waiting for authorization…"}</Text>
      ) : null}
      {progress.status === "success" ? <Text color="green">✓ {progress.message || "Authenticated."}</Text> : null}
      {progress.status === "error" ? <Text color="red">✗ {progress.message || "Login failed."}</Text> : null}

      <Text dimColor>
        {done ? "esc / ⏎ dismiss" : wantsInput ? "finish in your browser · ⏎ submit pasted URL · esc cancel" : "finish in your browser · esc cancel"}
      </Text>
    </Box>
  )
}
