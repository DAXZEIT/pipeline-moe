# Fused seats — role hats on shared contexts

> Idea: Dax, 2026-07-11 ("model fusions are becoming common — one model
> could carry builder+tester, another planner/auditor/scribe: separation
> of powers without N contexts ballooning every turn"). Clustering
> correction agreed same day: the auditor fuses with nobody. Sketch:
> Claude Fable 5 (Claude Code). Status: design, not yet built.

## The idea in one line

The persona becomes a **hat** (role prompt + tool allowlist, applied per
turn); the context becomes a **seat** (one pi session shared by a cluster
of hats). Separation of powers stays hard — enforced by the harness, not
by whose context you're in — while the room stops paying N times for the
same ground truth.

## Two fusions in one idea — decouple them

Dax's framing contains two distinct fusions, with opposite risk profiles:

1. **Context fusion** (hats share a seat) — zero training, implementable
   in the current stack, wins are measurable immediately. This is the
   feature.
2. **Weight fusion** (a model specialized per seat) — training cost,
   uncertain quality, and full merges don't even fit the hardware. This
   is at most a phase 2, and as LoRA adapters, not merges (below).

Everything in this sketch works with both seats running the same Qwopus.

## Not OpenRouter Fusion

OpenRouter Fusion (2026) is the opposite axis: fan a prompt out to an
opaque, server-curated ensemble in parallel, then have a synthesis model
merge the **outputs** of one stateless call. No shared conversation, no
persistent working state, token cost multiplied by ensemble size + a
synthesis pass, and you can't see which model said what.

Fused seats fuse **working contexts**, not outputs: one long-lived
engineering session carried by cooperating roles, fully transcript-
observable (every hop traced — the zero-silent-hop invariant), token cost
*reduced* (deduplicated context, better cache reuse). Mixture-of-agents
samples a distribution for one answer; fused seats structure a division
of labor over days of state.

## Design

### 1. Seats are a session-layer change, nothing else

A seat is an indirection on the session key: `persona → seat`, seats own
the pi session directory (`sessionKey: seat` instead of persona id).
Routing semantics are **unchanged** — proposals, supervised decisions,
✓/↪/✗/⚠/≡ traces, chain hops: all of it keeps operating on personas.
Only where a turn's context comes from changes. That orthogonality is
the whole implementation bet: no new state machine, no routing rewrite.

Default clustering (configurable per room/preset):

- **maker seat** — builder + tester. They share the ground truth of the
  working tree: the diff, the test output, the intent. Today each
  re-derives what the other just had in context.
- **orchestrator seat** — planner + scribe. They share the meta state:
  board, ROADMAP, decisions, receipts.
- **auditor: no seat — stateless.** Spawned fresh per gate, near-zero
  context. See "deliberately does not do".

### 2. Hats keep the separation of powers

Per turn, the harness injects the hat: role prompt + the persona's tool
allowlist. The seat holds the union of its hats' tools; the hat restricts
it — a tester turn on the maker seat has no `edit`/`write` no matter what
the model believes it is. Enforcement stays where it already lives
(per-persona allowlists), so hat blur degrades into a refused tool call,
never into unauthorized action.

Durable memory stays **per hat** (`agent_memory/<persona>.md` — identity,
lessons); working context is **per seat**. Identity survives the fusion;
only the redundant re-reading dies.

### 2b. Assignment, not role-play (the framing is part of the feature)

Dax's observation (2026-07-11): "I don't play the helpdesk role, I take
the helpdesk seat." Persona prompts say *you are X* — an invitation to
perform a character, including its theatrical flaws (part of the tester's
130K-char overthink is *performing* thoroughness). Seat prompts say *you
have been assigned seat X; the seat's duties are…* — the actor stays
fully capable, the duties attach to the seat.

Two mechanical reasons this matters beyond taste:

- **The seat is true; the character is false.** Same weights behind every
  persona today; same *session* behind a fused seat tomorrow. Role-play
  framing becomes self-contradictory on a shared context ("I am the
  tester, yet I remember writing this diff") — the model must sustain a
  fiction its own context refutes. Seat framing makes the situation
  coherent: "you wrote this from the maker seat; judge it now from the
  tester hat." Duties attach to the seat, not to pride of authorship.
- **Free institutional vocabulary.** Seats are occupied, vacated,
  reassigned — and one **recuses** oneself: "the audit seat is never
  occupied by whoever sat in the maker seat for this change" states the
  auditor rule in a concept the model deeply knows. Critique also
  depersonalizes: "the maker seat's output has a bug," not "@builder,
  you made a mistake" — less performed social politeness between agents.

Caveat, to be measured not assumed: small models sometimes lean on a
strong persona as a stable behavioral attractor. The framing switch is a
prompt change, A/B-able on the T2 bench like the supervisor's 73→85%.
Hypothesis: seat framing wins exactly where role-play costs — overthink,
out-of-character refusals, shared-context coherence — and loses nothing
elsewhere.

### 3. The intra-seat handoff becomes a hat switch

builder → tester within the maker seat: same session, so the "transfer"
carries zero tokens — the tester opens its eyes in a context where the
diff and the intention are already present. The supervised trace is still
posted (a hat switch is still a routing decision; the authority rules
don't change, only the cost). This attacks the tester-overthink attractor
at the root: discussion 57's tester burned 83 tool calls and 130K
reasoning chars mostly re-establishing state the builder already had.
Less to re-derive, less fuel for the loop — compounding with the
per-turn reasoning budget (backlog #9).

### 4. The hidden win is the prompt cache

With `--parallel 1`, llama-server's prompt cache holds one prefix. Seven
personas alternate seven session prefixes — nearly every turn evicts the
cache and re-prefills up to ~100K tokens on the 3090. Two seats alternate
two prefixes: the cache survives most turns. This is minutes of prefill
per discussion, and it's the argument no one sees looking at the agent
architecture alone.

### 5. Composition with resource-aware supervision

A seat context grows faster than a persona context (it absorbs 2-3 roles'
turns) — but the room total shrinks (no duplication), and the supervisor
(docs/resource-aware-supervision.md) now manages 2-3 gauges instead of 7.
Fewer, bigger, better-instrumented contexts are exactly what a
compaction-ordering supervisor wants to see.

## Phase 2 — weights, only if measured, and only as LoRA

- **Full merges are out on this hardware**: two 27B Q4 GGUFs ≈ 16 GB
  each — they don't co-reside in 24 GB, and swapping GGUFs between turns
  costs tens of seconds plus the KV cache.
- **LoRA per seat is the mechanic that fits**: one base Qwopus + a
  maker-LoRA and an orchestrator-LoRA, hot-swappable per request,
  megabytes of VRAM each.
- **The training data already exists**: `sessions/*.json` transcripts
  are near-ShareGPT, and CLAUDE.md carries a proven tool-calling dataset
  methodology. Cut by role, train per seat.
- **Gate it on evidence**: only if phase 1 shows measured *hat drift*
  (roles blurring on a shared context). Context fusion buys a certain
  win; weight fusion buys uncertain specialization. Don't pay for the
  second until the first proves insufficient.

## What this deliberately does NOT do

- **No auditor fusion — ever.** The audit methodology is "sur pièces,
  pas sur rapport"; discussion 57 re-proved that fresh eyes find what
  the maker's context rationalizes away (F1). For an auditor, shared
  context isn't an economy, it's contamination. Stateless is also the
  cheapest seat in the room.
- **No output synthesis.** We are not sampling N answers and merging
  them; that's the OpenRouter Fusion axis, orthogonal and opaque.
- **Personas don't disappear.** Roster, memory files, traces, tool
  allowlists, the UI — all stay persona-shaped. The seat is invisible
  except as a shared context gauge.
- **No mid-turn hat switching.** A turn wears one hat; switches happen
  at the routing boundary where traces and supervision already live.

## Measurement

- **Prefill/latency**: wall-clock per discussion and cache-hit behavior,
  7-prefix baseline vs 2-seat — the win should be visible without
  instrumentation.
- **Re-derivation tax**: tester tool calls + reasoning chars on the
  maker seat vs the persona baseline (discussion 57 = 83 calls / 130K
  chars is the reference datum).
- **T2 decision quality** (workspace/shakedown): supervised routing
  decisions must not degrade when proposals name hats on seats.
- **Hat drift**: count refused tool calls from the wrong hat + judged
  role-confusion instances; this is the phase-2 gate.

## Test surface

- seat mapping: persona → seat resolution, per-room override, default
  when absent (seat == persona, today's behavior — zero migration);
- hat enforcement: tool allowlist applied per hat on a shared seat
  (tester hat cannot edit on the maker seat);
- session persistence: seat sessions survive restart like persona
  sessions do (same store, different key);
- traces: intra-seat hat switch still posts its routing trace
  (zero-silent-hop invariant holds across the refactor);
- compaction: per-seat compaction leaves both hats functional.

## Why it fits

pipeline-moe becomes literal: a mixture of experts where the seats are
the experts, the hats are the heads, and the routing layer — supervised,
observable, resource-aware — is the gating network. The stack's thesis
holds through the fusion: separation of powers enforced by the harness,
every decision visible in the transcript, and every economy taken where
the hardware actually pays for it.
