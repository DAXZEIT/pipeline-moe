// Reasoning budget — checkpoint, not guillotine (ROADMAP backlog #9).
//
// The local 27B falls into an overthink attractor on open-ended briefs
// (measured: 130K chars of reasoning for a 5.7K reply; a 44K/33-char mute
// turn — discussion 57, 2026-07-11). A system prompt can't break a loop
// mid-generation: the instruction is 100K tokens away and only shapes the
// ENTRY into reasoning. The harness can: it streams every thinking delta,
// so it counts them against a per-turn budget and, on breach, aborts the
// generation and injects a checkpoint the model must answer. What breaks a
// loop is NEW information entering the context — the checkpoint is that
// information. The model keeps the choice (continue / answer / ask): frame
// the reasoning, never constrain it — a cloud deep-reasoner spends
// legitimately, which is why cloud seats run without a budget by default.
//
// Guards: continues are bounded (a looping model would answer "continue"
// forever), and every checkpoint leaves a transcript trace — zero silent
// burn, the same invariant as zero silent hop.

export interface ReasoningCheckpoint {
  /** The message injected as the next prompt after the breach-abort. */
  message: string
  /** System-authored transcript trace (🧠 …) — posted when the checkpoint fires. */
  trace: string
  /** True when this is the last grant — the message offers answer/ask only. */
  final: boolean
}

const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))

/** Positive framing throughout — a "stop overthinking" would keep the
 *  forbidden concept lit in the model's workspace for the rest of the turn
 *  (ironic-process rebound); these messages only name the next action. */
function checkpointMessage(k: number, max: number, budgetChars: number): string {
  return [
    `[reasoning checkpoint ${k}/${max}] You have used this turn's reasoning budget (${fmtK(budgetChars)} characters). Pick ONE now:`,
    `(a) continue — first state in ONE line what remains to resolve, then proceed (this grants one more budget);`,
    `(b) answer now with what you have;`,
    `(c) ask ONE precise question (mention @planner or @auditor, or call ask_user).`,
    `A conclusion you have already verified stays verified — spend new reasoning on new ground only.`,
  ].join("\n")
}

function finalMessage(): string {
  return [
    `[final reasoning checkpoint] This turn's reasoning budget is spent.`,
    `Answer now with what you have, or ask ONE precise question (@planner, @auditor, or ask_user).`,
    `Your next output concludes the turn.`,
  ].join("\n")
}

/** Trace for the hard end: the model reasoned past even the final grant. */
export function exhaustedTrace(personaId: string): string {
  return `⚠ @${personaId} — reasoning budget exhausted after the final checkpoint — turn ended`
}

/** Per-turn budget state machine. Grants: the initial budget, `maxContinues`
 *  continue-grants (each announced by a checkpoint), then one final grant to
 *  produce the answer. A breach past the final grant returns null from
 *  nextCheckpoint() — the caller ends the turn (visibly). */
export class ReasoningBudget {
  /** Set when the current grant is spent; cleared when the next one opens. */
  breached = false
  private used = 0
  private issued = 0

  constructor(
    private readonly budgetChars: number,
    private readonly maxContinues: number,
  ) {}

  /** Count streamed reasoning chars. Returns true exactly once per grant —
   *  the moment it crosses the budget — so the caller aborts exactly once. */
  consume(chars: number): boolean {
    if (this.breached) return false
    this.used += chars
    if (this.used < this.budgetChars) return false
    this.breached = true
    return true
  }

  /** After a breach-abort: the checkpoint to inject for the next round, or
   *  null when even the final grant is spent (hard end). Re-arms the counter. */
  nextCheckpoint(personaId: string): ReasoningCheckpoint | null {
    if (this.issued > this.maxContinues) return null
    this.issued++
    this.used = 0
    this.breached = false
    if (this.issued <= this.maxContinues) {
      return {
        message: checkpointMessage(this.issued, this.maxContinues, this.budgetChars),
        trace: `🧠 @${personaId} — reasoning checkpoint ${this.issued}/${this.maxContinues} — budget spent (${fmtK(this.budgetChars)} chars); offered continue / answer / ask`,
        final: false,
      }
    }
    return {
      message: finalMessage(),
      trace: `🧠 @${personaId} — final reasoning checkpoint — answer or ask`,
      final: true,
    }
  }
}

/** Budget for a seat, or null when checkpoints don't apply: budget disabled
 *  (0 chars), or a cloud model — deep reasoners spend legitimately, and the
 *  attractor this exists for lives on the local seat. A null/unknown ref is
 *  treated as local: this stack's default resolution prefers the local
 *  provider, and the conservative reading is the one with the safety net. */
export function reasoningBudgetFor(
  modelRef: string | null,
  budgetChars: number,
  maxContinues: number,
): ReasoningBudget | null {
  if (budgetChars <= 0) return null
  if (modelRef && !modelRef.startsWith("local/")) return null
  return new ReasoningBudget(budgetChars, maxContinues)
}
