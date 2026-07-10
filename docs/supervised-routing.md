# Supervised routing — the planner as approver, not as hop

> Idea: Dax, 2026-07-10. Sketch: Claude Fable 5 (Claude Code).
> Reviewed against the code by the in-room planner (Fable 5), 2026-07-10 —
> this version integrates that review. Status: design converged, phase 1
> scoped; one human decision pending (refuse semantics, see bottom).

## The idea in one line

Semi mode built the approval machinery (pendingRoute, resolveRoute with
approve/redirect/drop). That machinery is a *seat*, not a human-only
feature — put the orchestrator in it: every handoff proposal is submitted to
a supervisor agent, who can **accept**, **refuse**, or **transfer**. The
planner stops being a mandatory hop in the chain and becomes its supervisor.

Verified against the source (review, 2026-07-10): `pendingRoute` exists
(room.ts:148), the drain already pauses on wave proposals in semi mode
(room.ts:2092), `resolveRoute` already accepts approve/redirect/drop
(room.ts:1956+), gates already live at the tool layer (registry). The
central claim — reuse the machinery, change the approver — holds 1:1:
accept/refuse/transfer ↔ approve/drop/redirect.

## Scope decision: additive, no rename

The original sketch bundled a mode rename (`semi` → `manual`). Review
verdict, adopted: **decouple it**. The rename touches saved conversations,
presets, HTTP validation in two places, tests, and the back-compat
`chaining: false → "manual"` setter — maximum risk for cosmetic value.

- **Phase 1 (this design):** add `routingMode: "supervised"`. Purely
  additive — zero migration, existing modes untouched.
- **Phase 2 (optional follow-up, after phase 1 ships):** rename `semi` →
  `manual` with a load-time compat shim — or never.

## Why this matters

Today "the planner controls the chain" is implemented by putting the planner
*in* the chain: fallback agent, plan-owner routing, hub-and-spoke returns.
Every pass through the planner is a full frontier turn. A route decision is
a bounded micro-decision: proposal + plan/board state → verdict. Supervision
at every hop, cheaper than control by detour — and the "planner must always
be last" pattern dissolves.

Side effect: partially subsumes the plan-lint backlog item (owner↔fallback
oscillation) — a supervisor refuses a ping-pong hop with a reason instead of
a lint warning after the fact.

## Layering with review gates (no conflict)

- **Gates = law.** Hard invariants at the *tool* layer (registry, at
  `handoff` execution): what may even be proposed. Correctable error,
  same turn.
- **Supervision = judgment.** Soft choice at the *dispatch* layer (room, on
  the pendingRoute path): among the legal proposals, is this the right next
  seat?

Distinct code layers today already; no overlap. A gated-out handoff never
reaches the supervisor.

## Mechanics (phase 1)

1. Agent's `handoff(to)` registers (gates already checked at the tool).
2. In `supervised` mode, instead of broadcasting the approval request to
   clients, the room runs a supervisor decision on the pendingRoute path.
   New room setting: `supervisorAgent` (default `"planner"`).
3. The supervisor answers through a schema-constrained tool:
   `route_decision({verdict: "accept" | "refuse" | "transfer", targetIds?, reason})`.
   **The decision applies to the proposal SET** — `pendingRoute.proposals`
   is an array (parallel waves propose several handoffs); `resolveRoute`
   already applies one decision to the set. `targetIds`, not a singular `to`.
4. Decision executes: accept → dispatch; transfer → dispatch to `targetIds`;
   refuse → return-to-sender with the reason (pending human confirmation,
   see below), bounded by the anti-ping-pong cap.

**Decision context: stateless by default.** A live-session decision grows
the most expensive context in the room on every hop — recreating the problem
this design solves, disguised. Phase 1 runs the decision stateless: the
proposed hop + a summary of the proposing turn + plan/board state, injected.
The live-session variant is phase 2, only if stateless decision quality is
*measured* insufficient.

## Invariants

- **A dead supervisor never deadlocks the room.** Supervisor inactive,
  errored, or kicked → degrade to `auto` for that hop + notice. Detection is
  simple: the supervisor turn flows through the existing error pipeline
  (`stopReason`). Rule: **any non-decision outcome — error, interruption, a
  turn that never calls `route_decision`, timeout — counts as degradation
  for that hop.** Same disarm principle as gates.
- **No one supervises the supervisor.** The supervisor's own handoffs
  auto-accept (no infinite regress) — but stay visible.
- **Plan-owner routing is NOT supervised.** When an agent ends without a
  handoff and plan-aware routing pushes the next step's owner, that is the
  system executing a decision the supervisor already made (the plan it
  wrote). Supervising it would be the self-regress the previous invariant
  forbids. Supervision governs *new proposals* only.
- **Anti-ping-pong cap.** One refuse per proposal: if the same agent
  re-proposes the same target after a refusal, the proposal falls to
  `fallbackAgent` (or drops) instead of another refuse round. Without this,
  stubborn agent + stubborn supervisor = full-cost loop. (Analog of
  one-handoff-per-turn.)
- **Observability before behavior.** Every decision leaves a transcript
  trace: `✓ @planner → @tester`, `↪ @planner redirected → @auditor (reason)`,
  `✗ @planner refused (reason)`. Invisible supervision would recreate the
  illusion-of-randomness bug — worse, because the routing really would be
  someone's opinion.
- **One decision per proposal.** The first `route_decision` stands; a second
  gets the correctable-error treatment (same rule as double handoff).
- **ask_user interplay:** a supervised decision raised while the room is
  paused on a question joins the heldQueue — it IS part of the held work.

## Phase plan (from the in-room review)

- **Phase 1** (~85% confidence): `supervised` mode + `supervisorAgent`
  setting + `route_decision` tool (set-decision) + the invariants above +
  transcript traces + heldQueue interplay. Decision context: stateless.
  Clients: settings UI + routing-mode cycle learn the new mode (client-core
  types, TUI ⇧⇥ toggle, web settings panel).
- **Phase 2** (after measurement, ~60% confidence it's needed): live-session
  decision variant; optionally the `semi` → `manual` rename with compat shim.

## Decision pending (human)

**Refuse semantics — confirm return-to-sender?** The agent is re-run with
the refusal reason injected (preserves agency; mirrors the gate-error
recovery pattern the models already handle, but post-turn and at full turn
cost), bounded by the anti-ping-pong cap. Alternative: refused proposals
fall straight to `fallbackAgent` (cheaper, less agency). Spec author and
in-room planner both lean return-to-sender *with the cap*; the cap is what
makes it safe.

## Phase 1 — Retro (2026-07-10, plan clos)

Livré : mode `supervised` + `supervisorAgent` + runner stateless + tool
`route_decision` + câblage pendingRoute + clients. 1140/1140 tests
(65 nouveaux : 9 tool, 24 smoke, 27 full, 5 fixes), typecheck ×4, audit
clos (5 findings, 3 fixés, 2 classés).

**Risques anticipés qui ont mordu :**
- `refuse ≠ drop` — flaggé au plan, aurait été un bug silencieux (drop
  continue le travail tenu, refuse relance le proposeur).
- La course abort-pendant-décision — flaggée avant le step 3, câblée par
  le builder (`registerAbort` + garde d'identité sérialisé) ; l'auditor a
  quand même trouvé une fenêtre résiduelle (F3, durcie). Anticiper une
  course ne la ferme pas — elle se ferme ligne par ligne.

**Non anticipé :**
- **F1 (medium)** : `transfer.targetIds` sans dédup — un modèle produit
  des ids dupliqués bien plus volontiers qu'un humain ; le bug latent du
  redirect humain devenait atteignable. Leçon générale : tout argument de
  tool produit par un modèle a besoin de la normalisation que le chemin
  UI humain n'exigeait pas.
- La régression de perf d'import : l'import statique de pi-coding-agent
  dans route-supervisor.ts, tiré par room.ts, doublait le temps d'import
  de la suite (12.6s→30s) et faisait flaker les tests de timing. Fix :
  imports paresseux, mesure commentée dans le fichier.
- **F2** : le re-run de refus contournait le check de chainBudget — un
  oubli, pas un choix.

**Leçon de découpage :** élargir une union type (`RoutingMode`) tire
immédiatement tous les `Record<Union, …>` exhaustifs via le typecheck —
`ROUTING_COLOR` prévu au step 4 (clients) a dû atterrir au step 1 (types).
Les frontières d'un plan doivent suivre les frontières du compilateur,
pas les frontières de la feature.

**Dette de vérification (→ ROADMAP) :** le chemin session-vivante du
runner n'a jamais été exécuté (stub-only) ; l'interplay ask_user+supervised
est câblé mais non testé ; la fenêtre F3 n'est atteignable qu'en live.
Un smoke manuel (room en supervised, un handoff, vérifier la trace ✓/↪/✗)
est le critère avant de considérer la feature vérifiée.

## Why it fits the philosophy

Still no graph: the workers propose their own routing, every turn, by
explicit choice. Still no orchestrator *script*: the supervisor is an agent
exercising judgment inside the same tool discipline as everyone else, and
its power degrades gracefully when it's absent. The chain stops being shaped
by where the planner sits and starts being shaped by what the planner
decides — control at the boundary, not control by detour. Constrained
agency, one level up.
