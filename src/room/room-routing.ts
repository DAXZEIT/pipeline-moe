import { resolve } from "node:path"
import { config } from "../config.js"
import type { Participant } from "../participant.js"
import { findPlanById, nextStepOwner } from "../plan-routing.js"
import {
  runSupervisorDecision,
  type SupervisorOutcome,
} from "../route-supervisor.js"
import { hatSwitchSuffix } from "../seats.js"
import type { RouteDecision } from "../types.js"
import type { PendingRoute, RouteProposal } from "./room-core.js"
import { RoomGoals } from "./room-goals.js"

export abstract class RoomRouting extends RoomGoals {
  /** Injectable seam for tests: the stateless supervisor decision runner.
   *  Production always uses runSupervisorDecision; tests stub it to script
   *  verdicts without a live model. */
  protected supervisorRunner: typeof runSupervisorDecision =
    runSupervisorDecision

  /** Decide who runs next from `fromId`'s turn and append them onto `target`.
   *  Honors the chain-hop budget; when no handoff was registered and a fallback
   *  agent is configured, routes there with a nudge to pick the next agent.
   *  Shared by the main drain loop and the ask-user resume path so routing is
   *  identical in both — the resume path previously pushed @mentions onto a
   *  queue it then discarded, silently dropping a handoff made right after
   *  answering a question. */
  protected async proposeChain(
    fromId: string,
    target: Participant[],
    opts?: { prepend?: boolean },
  ): Promise<Participant[]> {
    const mentioned = this.resolveHandoff(fromId)
    if (mentioned.length > 0) {
      // De-dupe against the pending queue: if e.g. scout AND builder both hand
      // off to @planner in the same pass, enqueue the planner once instead of
      // running it back-to-back (the loop kept returning to it 2-3× in a row).
      const next = mentioned.filter((p) => !target.includes(p))
      // Supervised observability (design decision 2026-07-11): a handoff to an
      // agent ALREADY in the queue coalesces — typically because the user
      // @-mention-dispatched it, or a supervisor accept enqueued it earlier in
      // this same drain. Either way it does NOT go through the supervisor (user
      // directive outranks the supervisor, same authority order as plan-owner
      // routing). The ≡ label stays cause-neutral — `target.includes(p)` can't
      // tell the two apart, and over-attributing to "user dispatch" would be
      // wrong for the accept-coalesce case (auditor F-low, #11). But it must
      // not be SILENT: three live runs were spent because a coalesced hop was
      // indistinguishable from a bypass. Emit a system-authored ≡ line so every
      // supervised hop shows either a supervisor glyph or a coalescence note.
      if (this.routingMode === "supervised") {
        for (const p of mentioned) {
          if (target.includes(p)) {
            this.post(
              "system",
              "Routing",
              `≡ @${fromId} → @${p.persona.id}${this.seatSuffix(fromId, p.persona.id)} — already queued — handoff coalesced (not supervised)`,
            )
          }
        }
      }
      if (next.length === 0) return []
      if (this.routingMode !== "auto") {
        // semi/manual: hand these back for human approval. Don't enqueue or spend
        // hop budget yet — that happens when the human approves.
        return next
      }
      if (this.chainBudget < this.maxChainHops) {
        this.chainBudget += next.length
        // prepend: a fresh mention outranks work frozen before a pause — the
        // ask_user resume path uses this so recent intent runs first.
        if (opts?.prepend) target.unshift(...next)
        else target.push(...next)
        this.emit("turn", {
          phase: "chain",
          from: fromId,
          targets: next.map((t) => t.persona.id),
        })
      } else {
        this.notice(
          `Chain budget exhausted (${this.maxChainHops} hops) — stopping.`,
          "info",
        )
      }
      return []
    }
    // No handoff registered. In a running goal-eval room, give the agent ONE
    // closed-menu re-prompt before letting its turn die: small models often
    // forget the handoff call, and a menu of the agent's real options (same
    // pick-from-a-list principle as the handoff enum itself) is recoverable,
    // where a silent turn end just burns a goal iteration. One-shot per agent
    // per eval iteration (noHandoffMenuUsed); auto mode only — re-running the
    // same agent is not a routable proposal for a human to approve. The
    // evaluator is exempt: its goal_eval prompt already structures its ending
    // (GOAL_MET or dispatch), and runGoalEval handles it.
    if (
      this.routingMode === "auto" &&
      this.goalMode === "eval" &&
      this.goalText !== null &&
      this.goalStatus === "running" &&
      fromId !== this.goalEvaluator &&
      !this.noHandoffMenuUsed.has(fromId) &&
      this.chainBudget < this.maxChainHops
    ) {
      const from = this.registry.get(fromId)
      if (from?.active && !target.includes(from)) {
        this.noHandoffMenuUsed.add(fromId)
        this.chainBudget += 1
        this.notice(`No handoff detected — one-shot menu to @${fromId}`, "info")
        await from.sendCustomMessage(
          {
            customType: "no_handoff_menu",
            content: this.buildNoHandoffMenu(fromId),
            display: false,
          },
          { deliverAs: "nextTurn" },
        )
        if (opts?.prepend) target.unshift(from)
        else target.push(from)
        this.emit("turn", { phase: "chain", from: fromId, targets: [fromId] })
        return []
      }
    }
    if (this.chainBudget < this.maxChainHops) {
      let routedTo: Participant | null = null
      let viaPlan = false

      // Plan-aware routing: consult the plan THIS room has adopted before
      // falling back to the generic fallback agent. If the next incomplete step
      // has an [agent] owner prefix and that agent is available, route there
      // instead. Scoped to activePlanId — a room that hasn't worked a plan
      // routes by none, so no stale plan in the shared graveyard can hijack a
      // turn (the planner↔tester incident, 2026-07-09).
      if (this.planAwareRoutingEnabled && this.activePlanId) {
        const plan = await findPlanById(this.plansDir(), this.activePlanId)
        const ownerId = nextStepOwner(plan)
        if (ownerId && ownerId !== fromId) {
          const owner = this.registry.get(ownerId)
          if (owner?.active && !target.includes(owner)) {
            routedTo = owner
            viaPlan = true
          }
        }
      }

      if (
        !routedTo &&
        this.fallbackAgentId &&
        fromId !== this.fallbackAgentId
      ) {
        const fb = this.registry.get(this.fallbackAgentId)
        if (fb?.active && !target.includes(fb)) {
          routedTo = fb
        }
      }

      if (routedTo) {
        this.chainBudget += 1
        // The notice must describe the DISPATCH ORDER, not just the append:
        // when a wave is still queued (e.g. a user message targeted several
        // agents), the routed agent runs after them — a bare "routing to @x"
        // reads as "x is next" and made the next wave turn look like it came
        // out of nowhere (observed live 2026-07-11, session mrff3qwe: notice
        // named @planner, the queued @tester ran next).
        const ahead = target.map((t) => t.persona.id)
        const queuedNote =
          ahead.length > 0 ? ` (queued after @${ahead.join(", @")})` : ""
        target.push(routedTo)
        this.emit("turn", {
          phase: "chain",
          from: fromId,
          targets: [routedTo.persona.id],
        })
        if (viaPlan) {
          this.notice(
            `Plan step routing — no handoff detected, next step owned by @${routedTo.persona.id}${queuedNote}`,
            "info",
          )
          // Inject routing context so the owner knows why it's being called.
          await routedTo.sendCustomMessage(
            {
              customType: "plan_step_routing",
              content: `(Plan-aware routing: @${fromId} finished without a handoff. The active plan's next incomplete step is assigned to you — check the plan and continue it.)`,
              display: false,
            },
            { deliverAs: "nextTurn" },
          )
        } else {
          this.notice(
            `No handoff detected — routing to @${routedTo.persona.id}${queuedNote}`,
            "info",
          )
          // Inject routing context so the fallback agent knows why it's being called.
          await routedTo.sendCustomMessage(
            {
              customType: "routing_fallback",
              content: `(Routing fallback: @${fromId} finished without handing off. Based on the conversation state, decide who should go next — call handoff(to: "...") with their id. If the work is complete, just say so — don't call handoff.)`,
              display: false,
            },
            { deliverAs: "nextTurn" },
          )
        }
      }
    }
    return []
  }

  /** The plans directory THIS room's plan-aware routing consults. Rooms on
   *  the default workspace keep the global config.plansDir (honors the
   *  PIPELINE_PLANS_DIR override and the hermetic test sentinel); a room with
   *  its own workspaceDir gets `<workspace>/.pi/plans` instead. Without this
   *  scoping, every secondary room read the MAIN workspace's active plan and
   *  routed by it — observed live: a sandbox room ping-ponged planner↔tester
   *  ~11 turns because the main repo's active plan had a [tester] step. */
  protected plansDir(): string {
    return this.workspaceDir === config.workspaceDir
      ? config.plansDir
      : resolve(this.workspaceDir, ".pi", "plans")
  }

  /** The one-shot closed menu injected when a goal-eval agent ends its turn
   *  without a handoff. Generated from live state so it never offers a dead
   *  option: real roster ids for handoff, ask_orchestrator only in sub-rooms
   *  (parent link present), ask_user otherwise. Closed list on purpose — a
   *  small model picks reliably from a menu where it fails an open
   *  instruction. */
  protected buildNoHandoffMenu(fromId: string): string {
    const targets = this.registry.activeIds().filter((id) => id !== fromId)
    const lines = [
      "(No handoff detected — your turn ended without passing the work on, and the goal is still running. Pick EXACTLY ONE:",
    ]
    if (targets.length > 0) {
      lines.push(
        ` • call handoff(to: "<id>") — pass the turn. Valid ids: ${targets.join(", ")}`,
      )
    }
    lines.push(
      this.registry.hasParentLink
        ? ` • call ask_orchestrator({ question: "..." }) — you are blocked on something outside this room`
        : ` • call ask_user({ question: "..." }) — you are blocked on something only the user can provide`,
    )
    lines.push(
      " • reply DONE — you believe the goal is complete; the evaluator will verify",
    )
    lines.push("Do nothing else: no other tools, no long explanation.)")
    return lines.join("\n")
  }

  /** Broadcast the current routing proposal so the UI can render the approval card. */
  protected emitRoutingProposed(): void {
    if (!this.pendingRoute) return
    this.emit("routing", {
      type: "proposed",
      proposals: this.pendingRoute.proposals.map((p) => ({
        from: p.fromId,
        target: p.target.persona.id,
        targetName: p.target.persona.name,
      })),
    })
  }

  /** Apply the human's decision on a pending routing proposal (semi/manual).
   *  Serialized onto the room's turn chain so it can't race a running turn. */
  resolveRoute(decision: RouteDecision): void {
    this.chain = this.chain
      .then(() => this.processRouteDecision(decision))
      .catch((err) => {
        this.notice(
          `Room error: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      })
  }

  protected async processRouteDecision(decision: RouteDecision): Promise<void> {
    const pr = this.pendingRoute
    if (!pr) return // nothing pending (already resolved, or raced an abort)
    this.pendingRoute = null
    this.aborted = false

    let toRun: Participant[] = []
    if (decision.action === "approve") {
      toRun = pr.proposals.map((p) => p.target)
    } else if (decision.action === "redirect") {
      // De-dupe ids (F1, audit 2026-07-10): a model-produced targetIds can
      // repeat an id far more readily than a human click — without the Set,
      // the same Participant is enqueued twice (double turn, double budget),
      // and a parallel cloud agent would even run its ONE session concurrently
      // in the same wave. Covers the human redirect path too.
      toRun = [...new Set(decision.targetIds ?? [])]
        .map((id) => this.registry.get(id))
        .filter((p): p is Participant => !!p && p.active)
    }
    // "drop" → toRun stays empty: continue with whatever work was already held.

    const fresh = toRun.filter((p) => !pr.heldQueue.includes(p))
    if (fresh.length > 0) {
      this.chainBudget += fresh.length
      pr.heldQueue.push(...fresh)
      this.emit("turn", {
        phase: "chain",
        from: null,
        targets: fresh.map((t) => t.persona.id),
      })
    }
    this.emit("routing", {
      type: "resolved",
      action: decision.action,
      targets: fresh.map((t) => t.persona.id),
    })

    this.queue = pr.heldQueue
    const paused = await this.drainQueue()
    if (paused) {
      await this.emitWorkspace()
      await this.saveCurrent()
      return
    }
    this.queue = []
    await this.endTurn()
    await this.saveCurrent()
  }

  // ── Supervised routing (phase 1 — docs/supervised-routing.md) ──────────

  /** Supervised mode: process a freshly formed proposal set (wave tail or
   *  ask_user resume). Applies the anti-ping-pong cap, auto-accepts the
   *  supervisor's own proposals, degrades to auto when no supervisor is
   *  available, and otherwise opens a pendingRoute and starts the stateless
   *  decision. Shared by both call sites on purpose — duplicated drain-branch
   *  logic is a known divergence-bug class in this file.
   *  Mutates `held` in place on the synchronous paths. Returns true when the
   *  room paused on a pendingRoute (caller stops draining); false when the
   *  set resolved synchronously and the caller should continue with `held`. */
  protected superviseProposals(
    proposals: RouteProposal[],
    held: Participant[],
    opts?: { prepend?: boolean },
  ): boolean {
    const enqueue = (targets: Participant[], from: string | null) => {
      const fresh = targets.filter((t) => !held.includes(t))
      if (fresh.length === 0) return
      if (this.chainBudget >= this.maxChainHops) {
        this.notice(
          `Chain budget exhausted (${this.maxChainHops} hops) — stopping.`,
          "info",
        )
        return
      }
      this.chainBudget += fresh.length
      if (opts?.prepend) held.unshift(...fresh)
      else held.push(...fresh)
      this.emit("turn", {
        phase: "chain",
        from,
        targets: fresh.map((t) => t.persona.id),
      })
    }

    // Anti-ping-pong cap: a pair the supervisor refused this turn never
    // re-enters review — it escapes to the fallback agent, or drops. The
    // escape is deliberately NOT supervised: it is the loop's exit hatch,
    // reviewing it would re-open the loop.
    const fresh: RouteProposal[] = []
    for (const p of proposals) {
      if (!this.refusedRoutes.has(`${p.fromId}→${p.target.persona.id}`)) {
        fresh.push(p)
        continue
      }
      const fb =
        this.fallbackAgentId && this.fallbackAgentId !== p.fromId
          ? this.registry.get(this.fallbackAgentId)
          : undefined
      if (fb?.active) {
        this.notice(
          `⛔ @${p.fromId} re-proposed @${p.target.persona.id} after a refusal — falling to fallback @${fb.persona.id}`,
          "info",
        )
        enqueue([fb], null)
      } else {
        this.notice(
          `⛔ @${p.fromId} re-proposed @${p.target.persona.id} after a refusal — dropped`,
          "info",
        )
      }
    }
    if (fresh.length === 0) return false

    // Hat-switch carve-out (fused seats, décision 2026-07-12): a proposal
    // whose from and target share a seat is a SELF-switch — one brain putting
    // on another of its hats, zero tokens transferred. The supervisor gates
    // dispatch between brains; judging whether a brain may change its own hat
    // is complexity with no object (same authority family as user-dispatch
    // coalescence and supervisor auto-accept). Never silent: each carved hop
    // posts its ≡ trace, and "hat switch" stays the grep anchor.
    const seatOf = (id: string) => this.registry.seatOf?.(id) ?? id
    const intraSeat = fresh.filter(
      (p) =>
        p.fromId !== p.target.persona.id &&
        seatOf(p.fromId) === seatOf(p.target.persona.id),
    )
    if (intraSeat.length > 0) {
      for (const p of intraSeat) {
        this.post(
          "system",
          "Routing",
          `≡ @${p.fromId} → @${p.target.persona.id} — same seat — hat switch auto-accepted (not supervised)`,
        )
      }
      enqueue(
        intraSeat.map((p) => p.target),
        null,
      )
    }
    const inter = fresh.filter((p) => !intraSeat.includes(p))
    if (inter.length === 0) return false

    // No one supervises the supervisor: a set proposed entirely by the
    // supervisor auto-accepts — visible via the chain event, no runner.
    // (Mixed sets cannot be split without complicating resolveRoute; the
    // supervisor judging a set containing its own proposal is acceptable.)
    const supId = this.supervisorAgentId
    if (supId && inter.every((p) => p.fromId === supId)) {
      enqueue(
        inter.map((p) => p.target),
        supId,
      )
      return false
    }

    // Dead-supervisor invariant: no active supervisor → degrade the hop to
    // auto. Degradation = dispatch as proposed, never a stall or a drop.
    // This is the SECOND silent-degradation site (the first is the runner's
    // no-decision path in applySupervisorOutcome). Same observability rule:
    // a degraded hop must leave a transcript trace, else it's invisible and
    // indistinguishable from a bypass (auditor F1). No supervisor exists to
    // author it here, so the trace is system-authored.
    const supervisor = supId ? this.registry.get(supId) : undefined
    if (!supervisor?.active) {
      this.notice(
        "supervised routing: no active supervisor — hop degraded to auto",
        "info",
      )
      const setLabel = inter
        .map(
          (p) =>
            `@${p.fromId} → @${p.target.persona.id}${this.seatSuffix(p.fromId, p.target.persona.id)}`,
        )
        .join(", ")
      this.post(
        "system",
        "Routing",
        `⚠ ${setLabel} — no active supervisor — dispatched as proposed`,
      )
      enqueue(
        inter.map((p) => p.target),
        null,
      )
      return false
    }

    this.pendingRoute = { proposals: inter, heldQueue: [...held] }
    this.emitRoutingProposed()
    this.startSupervisorDecision(supervisor)
    return true
  }

  /** Fire-and-forget: run the stateless supervisor decision for the current
   *  pendingRoute, then apply the verdict through the serialized turn chain.
   *  The inertness guard (pendingRoute identity) lives INSIDE the chained
   *  section: if the user aborted, or a human raced the supervisor via the
   *  approval card, the outcome is a no-op. */
  protected startSupervisorDecision(supervisor: Participant): void {
    const pr = this.pendingRoute
    if (!pr) return
    void (async () => {
      let outcome: SupervisorOutcome
      try {
        const proposers = new Set(pr.proposals.map((p) => p.fromId))
        outcome = await this.supervisorRunner({
          workspaceDir: this.workspaceDir,
          resolved: this.registry.resolvedModel,
          allowCloud: this.allowCloud,
          personaModel: supervisor.persona.model,
          // Transfer targets: anyone active except the proposers themselves —
          // "transfer back to sender" without a reason is what refuse is for.
          validTargetIds: this.registry
            .activeIds()
            .filter((id) => !proposers.has(id)),
          prompt: await this.buildSupervisorPrompt(pr, supervisor.persona.id),
          registerAbort: (abort) => {
            this.supervisorAbort = abort
          },
        })
      } catch (err) {
        // The real runner never throws, but the seam is injectable and the
        // prompt build touches the plan dir. Same rule: non-decision = degrade.
        outcome = {
          decision: null,
          degraded: err instanceof Error ? err.message : String(err),
        }
      } finally {
        this.supervisorAbort = null
      }
      this.chain = this.chain
        .then(async () => {
          if (this.pendingRoute !== pr) return // aborted / superseded / human raced us — inert
          await this.applySupervisorOutcome(pr, outcome, supervisor)
        })
        .catch((err) => {
          this.notice(
            `Room error: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          )
        })
    })()
  }

  /** Fused seats: the cause-neutral trace suffix for an intra-seat hop —
   *  " — hat switch (<seat> seat, context carried)" when from and to share a
   *  seat, empty otherwise. No new glyph on purpose: the glyph encodes the
   *  decision's authority, which a hat switch does not change (décision actée
   *  2026-07-12); the suffix states the topological fact and is the grep
   *  anchor for the re-derivation metric. */
  protected seatSuffix(fromId: string, toId: string): string {
    return hatSwitchSuffix(
      fromId,
      toId,
      (id) => this.registry.seatOf?.(id) ?? id,
    )
  }

  /** Apply a supervisor outcome to the pending set. accept/transfer reuse
   *  processRouteDecision verbatim (approve/redirect); refuse is the new
   *  return-to-sender branch; a non-decision degrades to approve — dispatch,
   *  never stall. Every decision leaves a transcript trace authored by the
   *  supervisor (observability-before-behavior invariant). */
  protected async applySupervisorOutcome(
    pr: PendingRoute,
    outcome: SupervisorOutcome,
    supervisor: Participant,
  ): Promise<void> {
    const supId = supervisor.persona.id
    const setLabel = pr.proposals
      .map(
        (p) =>
          `@${p.fromId} → @${p.target.persona.id}${this.seatSuffix(p.fromId, p.target.persona.id)}`,
      )
      .join(", ")
    const d = outcome.decision
    if (!d) {
      const cause = outcome.degraded ?? "no decision"
      this.notice(
        `supervised routing degraded to auto (${cause}) — dispatching as proposed`,
        "info",
      )
      // Observability-before-behavior invariant: a degraded hop must be as
      // visible in the transcript as accept/refuse/transfer. Without this,
      // a silent degradation (timeout, cold supervisor that never called
      // route_decision) is indistinguishable from the supervisor being
      // bypassed entirely — the exact ambiguity live-verify hit on the first
      // hop of a chain. This is the runner's no-decision path; the sibling
      // site (dead supervisor, superviseProposals) posts its own ⚠ trace.
      // Together they close both silent-degradation branches. This ⚠ is
      // authored by the supervisor (a decision was attempted); the sibling's
      // is system-authored (no supervisor to sign).
      this.post(
        supId,
        supervisor.persona.name,
        `⚠ ${setLabel} — supervisor unavailable (${cause}) — dispatched as proposed`,
      )
      await this.processRouteDecision({ action: "approve" })
      return
    }
    if (d.verdict === "accept") {
      this.post(supId, supervisor.persona.name, `✓ ${setLabel} — ${d.reason}`)
      await this.processRouteDecision({ action: "approve" })
    } else if (d.verdict === "transfer") {
      const to = (d.targetIds ?? []).map((t) => `@${t}`).join(" ")
      this.post(
        supId,
        supervisor.persona.name,
        `↪ ${setLabel} redirected → ${to} — ${d.reason}`,
      )
      await this.processRouteDecision({
        action: "redirect",
        targetIds: d.targetIds,
      })
    } else {
      this.post(
        supId,
        supervisor.persona.name,
        `✗ ${setLabel} refused — ${d.reason}`,
      )
      await this.processRouteRefusal(d.reason, supId)
    }
  }

  /** Refuse = return-to-sender: each proposer re-runs with the refusal reason
   *  injected (same channel as the no-handoff menu), bounded by the cap armed
   *  here. This is a new control path — refuse ≠ drop: drop continues the
   *  held work only, refuse re-runs the proposer first. */
  protected async processRouteRefusal(
    reason: string,
    supervisorId: string,
  ): Promise<void> {
    const pr = this.pendingRoute
    if (!pr) return
    this.pendingRoute = null
    this.aborted = false

    // Arm the cap BEFORE the re-run: an identical re-proposition this turn
    // escapes to the fallback instead of another review round.
    for (const p of pr.proposals) {
      this.refusedRoutes.add(`${p.fromId}→${p.target.persona.id}`)
    }

    const rerun: Participant[] = []
    for (const fromId of [...new Set(pr.proposals.map((p) => p.fromId))]) {
      const proposer = this.registry.get(fromId)
      if (!proposer?.active) continue
      const refusedTargets = pr.proposals
        .filter((p) => p.fromId === fromId)
        .map((p) => `@${p.target.persona.id}`)
        .join(", ")
      await proposer.sendCustomMessage(
        {
          customType: "route_refusal",
          content:
            `Your handoff to ${refusedTargets} was refused by the supervisor @${supervisorId}: ${reason}\n` +
            "Reconsider: continue the work yourself, hand off to a different agent, or end your turn " +
            "without a handoff. Re-proposing the same target will fall to the fallback agent instead of another review.",
          display: false,
        },
        { deliverAs: "nextTurn" },
      )
      if (!pr.heldQueue.includes(proposer)) rerun.push(proposer)
    }
    if (rerun.length > 0) {
      // Same budget discipline as every other enqueue path (F2, audit): a
      // budget-exhausted room does NOT re-run the proposer — the refusal
      // reason is already delivered (nextTurn message above), it will reach
      // the agent whenever it legitimately runs next.
      if (this.chainBudget >= this.maxChainHops) {
        this.notice(
          `Chain budget exhausted (${this.maxChainHops} hops) — refusal delivered, proposer not re-run.`,
          "info",
        )
        rerun.length = 0
      } else {
        this.chainBudget += rerun.length
        this.emit("turn", {
          phase: "chain",
          from: null,
          targets: rerun.map((t) => t.persona.id),
        })
      }
    }
    this.emit("routing", { type: "resolved", action: "refuse", targets: [] })

    // Return-to-sender runs BEFORE the held work — the proposer's follow-up
    // is the live intent; the frozen queue resumes after.
    this.queue = [...rerun, ...pr.heldQueue]
    const paused = await this.drainQueue()
    if (paused) {
      await this.emitWorkspace()
      await this.saveCurrent()
      return
    }
    this.queue = []
    await this.endTurn()
    await this.saveCurrent()
  }

  /** Micro-context for the stateless decision: the proposal set, each
   *  proposer's last message, plan/board state, and the live roster. Bounded
   *  by design — that boundedness is the whole point of the stateless
   *  variant (a live-session decision would grow the most expensive context
   *  in the room on every hop). */
  protected async buildSupervisorPrompt(
    pr: PendingRoute,
    supervisorId: string,
  ): Promise<string> {
    const lines: string[] = []
    lines.push(
      "Routing decision needed. Proposed handoff(s) — one decision covers the whole set:",
    )
    for (const p of pr.proposals) {
      lines.push(
        `- @${p.fromId} → @${p.target.persona.id} (${p.target.persona.name})`,
      )
    }

    for (const fromId of [...new Set(pr.proposals.map((p) => p.fromId))]) {
      for (let i = this.transcript.length - 1; i >= 0; i--) {
        const entry = this.transcript[i]
        if (entry.author !== fromId) continue
        const text =
          entry.text.length > 1500
            ? `${entry.text.slice(0, 1500)}… (truncated)`
            : entry.text
        lines.push("", `Last message from @${fromId}:`, text)
        break
      }
    }

    const tasks = this.taskBoard.list()
    if (tasks.length > 0) {
      lines.push("", "Task board:")
      for (const t of tasks.slice(0, 25)) {
        const mark =
          t.status === "completed"
            ? "✔"
            : t.status === "in_progress"
              ? "▶"
              : " "
        lines.push(
          `#${t.id} [${mark}] ${t.subject}${t.owner ? ` (@${t.owner})` : ""}`,
        )
      }
    }

    if (this.activePlanId) {
      const plan = await findPlanById(this.plansDir(), this.activePlanId)
      const next = plan?.steps.find((s) => !s.done)
      if (plan && next) {
        lines.push(
          "",
          `Active plan "${plan.title}" — next incomplete step: ${next.text}`,
        )
      }
    }

    // Per-seat model annotations — a capability-aware verdict ("don't
    // transfer an architecture question to a local seat") needs to know the
    // brains, not just the ids (docs/roster-awareness.md §3).
    const seatTag = (id: string): string => {
      const persona = this.registry.get(id)?.persona
      const ref = persona?.model ?? this.getDefaultModel()
      if (!ref) return id
      const local = ref.startsWith("local/")
      const short = (ref.split("/").pop() ?? ref).replace(/\.gguf$/i, "")
      return `${id} [${short}, ${local ? "local" : "cloud"}]`
    }
    const roster = this.registry
      .activeIds()
      .map((id) =>
        id === supervisorId ? `${id} (you — the supervisor)` : seatTag(id),
      )
    lines.push("", `Active agents: ${roster.join(", ")}`)
    lines.push(
      "",
      "Decide with route_decision: accept, refuse (your reason returns to the proposer), or transfer (targetIds).",
    )
    return lines.join("\n")
  }
}
