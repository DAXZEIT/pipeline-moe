# @pipeline-moe/tui

**`pmoe`** — the flagship terminal client for
[pipeline-moe](https://github.com/DAXZEIT/pipeline-moe), a multi-agent chat
room over N stateful [`pi`](https://github.com/earendil-works/pi) sessions and
a shared workspace. Think frontier, run local.

Built on [Ink](https://github.com/vadimdemedes/ink) and
[`@pipeline-moe/client-core`](https://www.npmjs.com/package/@pipeline-moe/client-core).

## Install

```bash
npm i -g @pipeline-moe/tui
```

## Run

Point it at a running pipeline-moe server (`npx pipeline-moe serve`):

```bash
pmoe                                        # defaults to http://localhost:5300
pmoe --server http://localhost:5300 --room default
```

## Features

- **Multi-room** — `/rooms` to switch, `/newroom` to create; closed rooms stay
  resumable.
- **Slash-command palette** — Claude-Code-style `/` menu (fuzzy match, Tab
  completes): `/route`, `/chain`, `/steer`, `/abort`, `/compact`, `/lineup`,
  `/agent`, `/preset`, `/providers`, and more.
- **Live markdown** — streaming agent output is styled as it arrives
  (headings, code fences with highlighting, tables, lists), not just at
  finalize.
- **Line-accurate scrollback** — PgUp/PgDn through the full transcript with a
  position footer; the live stream keeps flowing when pinned to the bottom.
- **Lineup management** — reorder, pause, parallelize, kick, or add agents
  mid-session.
- **Provider OAuth** — `/providers` lists configured providers and drives
  device-code login flows in-terminal.

The client is deliberately thin: it renders state and sends commands; all
orchestration lives in the server.

## License

MIT — see the [repository](https://github.com/DAXZEIT/pipeline-moe).
