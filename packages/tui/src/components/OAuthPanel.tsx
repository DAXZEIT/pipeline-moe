import { Box, Text, useInput } from "ink"
import type { OAuthProgress } from "@pipeline-moe/client-core"

/**
 * Persistent OAuth flow panel. Unlike the 5s notice, this stays on screen until
 * the flow reaches success/error (or the user dismisses), so a device-code URL +
 * code remains visible long enough to authenticate in a browser.
 */
export function OAuthPanel({
  progress,
  onDismiss,
  isActive,
}: {
  progress: OAuthProgress
  onDismiss: () => void
  isActive: boolean
}) {
  const done = progress.status === "success" || progress.status === "error"

  useInput(
    (_input, key) => {
      if (key.escape || (done && key.return)) onDismiss()
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
            Visit <Text color="cyan" underline>{progress.verificationUri}</Text>
          </Text>
          <Text>
            Enter code <Text bold color="yellow">{progress.userCode}</Text>
          </Text>
        </>
      ) : null}
      {progress.status === "auth_url" ? (
        <Text>{progress.instructions ?? `Visit ${progress.url ?? "the printed URL"}`}</Text>
      ) : null}
      {progress.status === "progress" ? (
        <Text dimColor>{progress.message ?? "Waiting for authorization…"}</Text>
      ) : null}
      {progress.status === "success" ? <Text color="green">✓ {progress.message || "Authenticated."}</Text> : null}
      {progress.status === "error" ? <Text color="red">✗ {progress.message || "Login failed."}</Text> : null}

      <Text dimColor>{done ? "esc / ⏎ dismiss" : "finish in your browser · esc to hide"}</Text>
    </Box>
  )
}
