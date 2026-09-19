import {
  goalDispatchRetryPrompt,
  goalEvalPrompt,
  goalVerdictRetryPrompt,
} from "../personas.js"
import { RoomSettings } from "./room-settings.js"

export abstract class RoomGoals extends RoomSettings {
  /** Resolve the running goal: set status, broadcast, fire the parent callback.
   *  Single funnel for every terminal transition so onGoalResolved can't be
   *  missed by a new resolution site. */
  protected resolveGoal(
    status: "completed" | "failed" | "cancelled",
    reason?: string,
  ): void {
    this.goalStatus = status
    // Close the goal_verdict live gate — verdicts outside a goal run are
    // correctable errors at the tool, not silent state.
    this.registry.setGoalEvalActive?.(false)
    this.emit("room", {
      type: `goal-${status}`,
      goalText: this.goalText,
      ...(reason ? { reason } : {}),
    })
    this.onGoalResolved?.(status)
  }

  /** Agent id that evaluates the goal in "eval" mode. */
  protected goalEvaluator = "planner"

  /** Max eval iterations before the goal auto-fails (eval mode only). */
  protected maxGoalIterations = 10
  /** Eval iterations consumed so far in the current goal run. */
  protected goalIteration = 0

  /** True when the eval loop returned because a drain paused on a question —
   *  tells runGoalEval's finally NOT to restore the fallback agent, since the
   *  loop resumes (via endTurn) once the answer arrives. */
  protected goalEvalPausedOnQuestion = false

  /** Agents that already received the one-shot no-handoff menu (see
   *  proposeChain) in the current goal-eval iteration. Guarantees at most one
   *  menu re-prompt per agent per iteration — cleared at each iteration start
   *  and by submitGoal — so a model that never chooses is bounded by the goal
   *  iteration budget, not looped forever. */
  protected noHandoffMenuUsed = new Set<string>()

  getGoalText(): string | null {
    return this.goalText
  }
  getGoalStatus(): "idle" | "running" | "completed" | "failed" | "cancelled" {
    return this.goalStatus
  }

  /** Start a goal-driven pipeline run. Sets goalText/status and fires the first turn.
   *  In "eval" mode the evaluator agent verifies the goal after each drain and
   *  drives an iterative dispatch loop until it declares GOAL_MET or the iteration
   *  budget is exhausted. */
  submitGoal(
    text: string,
    opts?: {
      mode?: "auto" | "eval"
      evaluator?: string
      maxIterations?: number
    },
  ): void {
    this.goalText = text
    this.goalStatus = "running"
    this.goalMode = opts?.mode ?? "auto"
    this.goalEvaluator = opts?.evaluator?.trim() || "planner"
    // Keep the registry's evaluator hint current (participants built from now
    // on grant goal_verdict to this seat) and open the tool's live gate for
    // eval-mode runs.
    this.registry.setGoalEvaluator?.(this.goalEvaluator)
    this.registry.setGoalEvalActive?.((opts?.mode ?? "auto") === "eval")
    this.maxGoalIterations = Math.max(
      1,
      Math.min(50, Math.round(opts?.maxIterations ?? 10)),
    )
    this.goalIteration = 0
    this.goalCancelled = false
    this.noHandoffMenuUsed.clear()
    // A new goal is a fresh workflow: drop any plan adopted by prior work so
    // this goal only routes by a plan its own agents actually touch.
    this.activePlanId = null
    // In eval mode the eval loop is the sole router: the evaluator is invoked
    // deliberately after every natural drain. Leaving generic fallback routing
    // active would re-invoke the evaluator (when it is also the fallback agent)
    // with a misleading "routing fallback" context — doubling invocations and
    // draining the iteration budget. Suppress fallback for the whole goal run
    // (initial drain + eval loop); runGoalEval's finally restores it.
    if (this.goalMode === "eval") {
      this.goalEvalSavedFallback = this.fallbackAgentId
      this.fallbackAgentId = null
      this.goalEvalSavedPlanAwareRouting = this.planAwareRoutingEnabled
      this.planAwareRoutingEnabled = false
    }
    this.submit(text)
  }

  getGoalMode(): "auto" | "eval" {
    return this.goalMode
  }

  /** Matches the GOAL_MET completion token in any reasonable form. Kept as
   *  the fallback verdict channel for evaluator seats without the
   *  goal_verdict tool (goal submitted later with a different evaluator,
   *  sessions built before the tool existed). */
  protected static readonly GOAL_MET_RE = /\bGOAL[\s_-]?MET\b/i
  /** Matches the explicit GOAL_NOT_MET token — recognized so a tool-less
   *  evaluator that answers the format-repair retry with the NOT-MET token
   *  reads as a real verdict (continue iterating), not as format drift. */
  protected static readonly GOAL_NOT_MET_RE = /\bGOAL[\s_-]?NOT[\s_-]?MET\b/i

  /** Goal-eval loop (eval mode). After the pipeline drains naturally, route to
   *  the evaluator agent with a structured prompt. The evaluator verifies the
   *  goal independently (using its tools), then either:
   *    - declares GOAL_MET  → goal completes, loop exits; or
   *    - calls handoff(to)  → that agent runs (via drainQueue chaining), then
   *      the loop re-evaluates.
   *  Bounded by maxGoalIterations to guarantee termination. Called from within
   *  endTurn(); it drives drainQueue() directly and never re-enters endTurn(),
   *  so there is no recursion. */
  protected async runGoalEval(): Promise<void> {
    const evaluator = this.registry.get(this.goalEvaluator)
    if (!evaluator || !evaluator.active) {
      // No evaluator available — fall back to auto-completion rather than hang
      // the goal in "running" forever.
      this.notice(
        `Goal eval: evaluator @${this.goalEvaluator} not available — completing goal without verification.`,
        "info",
      )
      this.resolveGoal("completed")
      this.fallbackAgentId = this.goalEvalSavedFallback
      this.planAwareRoutingEnabled = this.goalEvalSavedPlanAwareRouting ?? true
      this.runningAgentId = null
      return
    }

    // Fallback routing is already suppressed (set null in submitGoal for the
    // whole eval-mode run). The finally restores the original fallback agent and
    // re-nulls runningAgentId per endTurn's documented contract.
    try {
      while (this.goalIteration < this.maxGoalIterations) {
        // Cancellation (abortCurrent / stop_room / Stop button) wins over
        // everything: end the goal as "cancelled" without another pass. Checked
        // here (between iterations) and again after the drain below.
        if (this.goalCancelled) {
          this.resolveGoal("cancelled")
          this.notice(
            `Goal cancelled on iteration ${this.goalIteration}.`,
            "info",
          )
          return
        }
        this.goalIteration++
        // Each iteration's dispatches get a fresh one-shot no-handoff menu.
        this.noHandoffMenuUsed.clear()
        // Drop any verdict left over from a previous pass — each pass's
        // verdict must come from its own evaluation.
        this.registry.clearVerdict?.()

        // Inject the structured eval context (invisible in the transcript).
        await evaluator.sendCustomMessage(
          {
            customType: "goal_eval",
            content: goalEvalPrompt(
              this.goalText!,
              this.goalIteration,
              this.maxGoalIterations,
            ),
            display: false,
          },
          { deliverAs: "nextTurn" },
        )
        this.emit("room", {
          type: "goal-eval",
          goalText: this.goalText,
          iteration: this.goalIteration,
          maxIterations: this.maxGoalIterations,
        })

        // Run the evaluator and any agents it dispatches via handoff chaining.
        this.queue = [evaluator]
        this.aborted = false
        this.chainBudget = 0
        this.runningAgentId = evaluator.persona.id
        this.emit("turn", {
          phase: "chain",
          from: null,
          targets: [evaluator.persona.id],
        })
        const paused = await this.drainQueue()

        // ask_user/ask_orchestrator pause inside an eval pass: the goal stays
        // "running" and we return with fallback suppression INTACT — the answer
        // resumes through process() → endTurn() → runGoalEval(), which picks
        // the loop back up. (Before this guard the loop clobbered the pause
        // and orphaned the held queue.)
        if (paused) {
          this.goalEvalPausedOnQuestion = true
          return
        }

        // Cancelled mid-drain — stop now, before reinterpreting the drain as a
        // completion or abort failure.
        if (this.goalCancelled) {
          this.resolveGoal("cancelled")
          this.notice(
            `Goal cancelled on iteration ${this.goalIteration}.`,
            "info",
          )
          return
        }

        // What did the evaluator decide? Tool verdict first, token fallback
        // second (see evalOutcome).
        let outcome = this.evalOutcome(evaluator.persona.id)

        // Repair retry (the "QCM"): the chain died on the evaluator leaving
        // the pass unusable, in one of two ways —
        //   · no readable verdict (format drift — 9B chaos-v2, 2026-07-12:
        //     five "**MET**" replies over a solved goal), or
        //   · a NOT-MET verdict with no dispatch (9B chaos-v3, same day:
        //     six perfect "line 4 missing" diagnoses, zero handoffs).
        // Re-ask ONCE per iteration with a closed menu for exactly the
        // missing action, NOT counted as an iteration — iterations measure
        // convergence toward the goal, not protocol conformity. Bounded: if
        // the re-ask produces nothing either, the iteration burns normally
        // and maxGoalIterations still terminates the loop.
        const evaluatorStalled =
          this.transcript[this.transcript.length - 1]?.author ===
          evaluator.persona.id
        const dispatchCandidates = this.registry
          .activeIds()
          .filter((id) => id !== evaluator.persona.id)
        if (
          evaluatorStalled &&
          (outcome === "none" ||
            (outcome === "not-met" && dispatchCandidates.length > 0))
        ) {
          await evaluator.sendCustomMessage(
            {
              customType: "goal_eval",
              content:
                outcome === "none"
                  ? goalVerdictRetryPrompt()
                  : goalDispatchRetryPrompt(dispatchCandidates),
              display: false,
            },
            { deliverAs: "nextTurn" },
          )
          this.queue = [evaluator]
          this.aborted = false
          this.chainBudget = 0
          this.runningAgentId = evaluator.persona.id
          this.emit("turn", {
            phase: "chain",
            from: null,
            targets: [evaluator.persona.id],
          })
          const pausedRetry = await this.drainQueue()
          if (pausedRetry) {
            this.goalEvalPausedOnQuestion = true
            return
          }
          if (this.goalCancelled) {
            this.resolveGoal("cancelled")
            this.notice(
              `Goal cancelled on iteration ${this.goalIteration}.`,
              "info",
            )
            return
          }
          outcome = this.evalOutcome(evaluator.persona.id)
        }

        if (outcome === "met") {
          this.resolveGoal("completed")
          return
        }

        // Turn aborted during this eval pass — give up.
        if (this.aborted) {
          this.resolveGoal("failed", "aborted")
          this.notice(
            `Goal eval aborted on iteration ${this.goalIteration}.`,
            "error",
          )
          return
        }
      }

      // Iteration budget exhausted without GOAL_MET.
      this.resolveGoal("failed", "max-iterations")
      this.notice(
        `Goal eval exhausted after ${this.maxGoalIterations} iterations without GOAL_MET.`,
        "error",
      )
    } finally {
      if (this.goalEvalPausedOnQuestion) {
        // Paused mid-eval: keep the fallback suppressed — the resumed loop
        // (re-entered via endTurn) still needs it off.
        this.goalEvalPausedOnQuestion = false
      } else {
        this.fallbackAgentId = this.goalEvalSavedFallback
        this.planAwareRoutingEnabled =
          this.goalEvalSavedPlanAwareRouting ?? true
        this.runningAgentId = null
      }
    }
  }

  /** The evaluator's decision for the eval pass that just drained.
   *  Channels, in precedence order:
   *   1. goal_verdict tool registration (consumed here) — the structured
   *      channel; immune to the label-echo drift that sank the token path.
   *   2. GOAL_NOT_MET / GOAL_MET tokens in the evaluator's most recent
   *      transcript message — fallback for tool-less evaluator seats.
   *      NOT_MET is tested first: GOAL_MET_RE cannot match "GOAL_NOT_MET"
   *      (single-separator), but the order makes the intent explicit.
   *  "none" → the pass produced no readable verdict (format drift or the
   *  evaluator dispatched without declaring — callers decide what that means). */
  protected evalOutcome(evaluatorId: string): "met" | "not-met" | "none" {
    const verdict = this.registry.takeVerdict?.()
    if (verdict && verdict.from === evaluatorId)
      return verdict.met ? "met" : "not-met"
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const e = this.transcript[i]
      if (e.author !== evaluatorId) continue
      if (RoomGoals.GOAL_NOT_MET_RE.test(e.text)) return "not-met"
      return RoomGoals.GOAL_MET_RE.test(e.text) ? "met" : "none"
    }
    return "none"
  }
}
