/** Strip terminal escape sequences, CR rewrites (progress bars) and `script`
 *  chatter from a PTY capture so the shared transcript gets clean plain text.
 *
 *  Framework-free and shared by both clients — a `!` command's capture becomes
 *  room context, and what the agents read must not depend on which client ran it. */
export function cleanPtyCapture(raw: string): string {
  const noEsc = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: séquences OSC (\x1b…\x07) — exactement ce qu'on strip d'une capture PTY
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC — titles, hyperlinks
    // biome-ignore lint/suspicious/noControlCharactersInRegex: séquences CSI (\x1b[) — exactement ce qu'on strip d'une capture PTY
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "") // CSI — colors, cursor moves
    // biome-ignore lint/suspicious/noControlCharactersInRegex: séquences ESC nues (\x1b) — exactement ce qu'on strip d'une capture PTY
    .replace(/\x1b[@-_=>]/g, "") // bare ESC sequences
  return noEsc
    .split("\n")
    .map((l) => l.split("\r").filter(Boolean).pop() ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: plage de contrôles \x00-\x1f restants — exactement ce qu'on élimine d'une capture PTY
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
