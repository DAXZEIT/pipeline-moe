/** Strip terminal escape sequences, CR rewrites (progress bars) and `script`
 *  chatter from a PTY capture so the shared transcript gets clean plain text.
 *
 *  Framework-free and shared by both clients — a `!` command's capture becomes
 *  room context, and what the agents read must not depend on which client ran it. */
export function cleanPtyCapture(raw: string): string {
  const noEsc = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC — titles, hyperlinks
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "") // CSI — colors, cursor moves
    .replace(/\x1b[@-_=>]/g, "") // bare ESC sequences
  return noEsc
    .split("\n")
    .map((l) => l.split("\r").filter(Boolean).pop() ?? "")
    .map((l) => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""))
    .filter((l) => !/^Script (?:started|done) on /.test(l))
    .join("\n")
}

/** Did the user interrupt the command, rather than the command failing?
 *
 *  Signals map to their 128+n codes, and the pty's "^C" echo catches commands
 *  that trap SIGINT and then exit non-zero themselves (ping to an unreachable
 *  host, say) — the exit code alone cannot distinguish that from a real error. */
export function exitCodeOf(
  res: { status: number | null; signal: string | null },
  output: string,
): number {
  if (res.signal === "SIGINT" || /\^C/.test(output)) return 130
  return res.status ?? (res.signal === "SIGTERM" ? 143 : res.signal ? 1 : 0)
}
