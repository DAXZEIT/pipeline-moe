---
name: live-verify
description: Drive the real app to verify a runtime claim — isolated server instance, tmux-driven TUI, capture-pane receipts. Use BEFORE approving or reporting on ANY claim about runtime behavior (a screen renders, an endpoint responds, routing works, a flag changes behavior). Green tests and clean typecheck do NOT count as seeing the feature work. If a claim is about what the software DOES when it runs, run it.
---

# Live verification playbook

"1093 tests green" proves the tests pass. It does not prove the TUI shows
the new header, the endpoint rejects bad input, or the handoff line renders.
Those are runtime claims, and runtime claims are verified by RUNNING the
software and OBSERVING the surface — then quoting what you saw. Your report
should contain receipts (captured output), not adjectives ("works fine").

You drive terminals programmatically: `tmux send-keys` and `capture-pane`
are your hands and eyes. The human cheat sheet (prefix keybindings) is
irrelevant to you — you never press Ctrl+b.

## Rule zero: never touch the production instance

The operator's live server (default port 5300) and tmux sessions are OFF
LIMITS. Verification happens on a scratch instance you boot yourself, in a
scratch workspace, and cleanup kills ONLY the PIDs you started.

- NEVER `pkill -f server` / `pkill tmux` — pattern kills hit the operator's
  processes (a pkill nearly took down the live server on 2026-07-10).
- Record the PID when you start something; `kill <pid>` exactly that.
- After cleanup, verify the live instance still responds if it was running:
  `curl -s -m 2 localhost:5300/api/settings >/dev/null && echo live-ok`

## Pattern A — isolated backend instance

For claims about the server: endpoints, settings, routing, persistence.

```bash
SCRATCH=$(mktemp -d /tmp/verify-XXXX)
mkdir -p $SCRATCH/sessions
PORT=5399 WORKSPACE_DIR=$SCRATCH SESSIONS_DIR=$SCRATCH/sessions \
  PIPELINE_EPHEMERAL_AGENTS=1 \
  nohup npx tsx src/server.ts > $SCRATCH/server.log 2>&1 &
SRV_PID=$!
sleep 6 && tail -3 $SCRATCH/server.log   # confirm it booted
```

Then exercise the claim end-to-end and read the REAL artifacts:

- API round-trip: `curl -s localhost:5399/api/...` — assert on the JSON,
  including the ERROR paths (a 400 with the right message is part of the
  claim).
- Persistence: read the conversation JSON under `$SCRATCH/sessions/` —
  the field must be on disk, not just in the response.
- Behavior over time: drive a message through, then inspect the transcript
  in the session file.

Cleanup: `kill $SRV_PID`, then confirm `curl -m 2 localhost:5399` fails.

## Pattern B — tmux-driven TUI

For claims about terminal rendering: headers, footers, transcript lines.

```bash
# Launch the app DIRECTLY as the pane command — never by typing the launch
# command into an interactive shell first (fancy prompts like p10k swallow
# or mangle programmatic input).
tmux new-session -d -s verify -x 200 -y 50 \
  "cd /path/to/repo && SERVER_URL=http://localhost:5399 npx tsx packages/tui/src/cli.tsx"
sleep 4
tmux capture-pane -t verify -p        # your eyes — read the actual screen
```

Sending input to an Ink/React TUI — THE gotcha that costs an hour:

```bash
# WRONG — Ink misses key.return when text and Enter arrive in one call:
tmux send-keys -t verify "hello room" Enter
# RIGHT — two separate calls:
tmux send-keys -t verify "hello room"
tmux send-keys -t verify Enter
```

Then `sleep` for the render and `capture-pane -p` again. The captured text
IS your evidence: paste the relevant lines verbatim into your report.

Cleanup: `tmux kill-session -t verify` (your session only — never
`tmux kill-server`).

## Pattern C — full loop (backend + TUI together)

Claim touches both (e.g. "the TUI shows X when the server does Y"):
boot Pattern A, point Pattern B's TUI at it (`SERVER_URL`/`PORT` env),
drive the interaction from the TUI, verify BOTH surfaces — the screen
(capture-pane) and the artifact (session JSON / API response).

## What a verification report looks like

Bad: "Verified, the handoff line shows up correctly."
Good:

> Booted scratch instance :5399 (log: clean start). tmux 200x50, sent
> "@planner ping" (two-call send-keys). capture-pane after the turn:
>     ↪ handoff → @tester
> Session JSON entry 3 carries `"handoffTo": "tester"`. Killed PID 70112,
> :5399 down, :5300 untouched.

Every sentence is checkable. That is the standard.

## Role notes

- **Tester**: this is your core loop. An audit finding or builder claim
  about runtime behavior is not "verified" until you ran the surface.
- **Auditor**: if you have bash, run the surface yourself before closing a
  finding. If you are read-only in this room, write the EXACT scenario
  (commands, expected capture) and hand off to the tester — prescribing a
  reproducible check is your fallback, trusting prose is not.
- Deep tmux reference (windows, panes, copy-mode): the `tmux` skill in the
  global pi skills — rarely needed for verification work.
