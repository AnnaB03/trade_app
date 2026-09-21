/* ---------- Trade journal: open -> close, with the plan and the outcome ----------
   Called from the order routes right after a REAL (never a preview) Tradier
   fill. Two entry points: journalOpen when a new position is placed,
   journalClose when an existing one is closed out. */
import { listIdeas, updateIdea, appendJournalEntry, updateJournalEntry } from "./store";
import { gradeAt } from "./gradeLib";

// Realized dollar P&L from actual entry/exit limit prices — the ground truth
// for "what happened," independent of the underlying-price grading below.
// Options are quoted per share and settle in 100-share contracts; shares
// settle 1:1. Entry/exit prices are the LIMIT prices submitted, not a
// polled fill price — this app doesn't reconcile actual fills yet (the
// sandbox order may still be pending), so this is "P&L if filled at your
// limit," labeled as such in the UI.
export function realizedPnl(entry, exitFillPrice) {
  const mult = entry.vehicle === "OPTION" ? 100 : 1;
  const qty = Number(entry.entryQuantity) || 0;
  const entryPx = Number(entry.entryLimitPrice);
  const exitPx = Number(exitFillPrice);
  if (!(qty > 0) || !Number.isFinite(entryPx) || !Number.isFinite(exitPx)) return { pnl: null, pnlPct: null };
  const longMult = entry.side === "sell_short" ? -1 : 1; // the OPTION vehicle is always long in this build
  const pnl = (exitPx - entryPx) * qty * mult * longMult;
  const cost = Math.abs(entryPx * qty * mult);
  return { pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : null };
}

export function daysHeld(entry, closedAt = new Date()) {
  const opened = new Date(entry.entryAt || entry.createdAt);
  return Math.max(0, (closedAt.getTime() - opened.getTime()) / 86400000);
}

// R-multiple + directional correctness vs the ORIGINAL underlying plan
// (invalidation/target) — reuses the exact math the idea ledger grades
// itself with, so a real close and a time-based grade check mean the same
// thing. Only meaningful when this trade came from an idea (has an
// invalidation level) and a current underlying price is supplied.
export function planGrade(entry, underlyingPriceAtClose) {
  if (!(Number(entry.invalidation) > 0) || underlyingPriceAtClose == null) return null;
  return gradeAt(
    { action: entry.ideaAction, entryPrice: entry.entryPriceAtIdea, invalidation: entry.invalidation, target: entry.target },
    underlyingPriceAtClose
  );
}

// Create the open-side journal entry. `idea` context (thesis, entryTrigger,
// invalidation, target, conviction, catalyst, regime, the spot price the
// idea was generated against) is pulled automatically when ideaId is given;
// a manual (non-idea) open supplies its own short `thesis` instead.
export function journalOpen({ ideaId, thesis, vehicle, symbol, occ, strike, optionType, expiration, side, quantity, limitPrice, order }) {
  const idea = ideaId ? listIdeas().find((i) => i.id === ideaId) : null;
  return appendJournalEntry({
    ideaId: idea?.id ?? null,
    source: idea ? "idea" : "manual",
    symbol, vehicle,
    occ: occ ?? null, strike: strike ?? null, expiration: expiration ?? idea?.expiration ?? null, optionType: optionType ?? null,
    side: side ?? "buy",
    entryOrderId: order?.id ?? null,
    entryOrderStatus: order?.status ?? null,
    entryQuantity: quantity,
    entryLimitPrice: limitPrice,
    entryAt: new Date().toISOString(),
    thesis: idea ? (idea.why_pro || idea.why_plain || null) : (thesis ?? null),
    entryTrigger: idea?.entryTrigger ?? null,
    invalidation: idea?.invalidation ?? null,
    target: idea?.target ?? null,
    conviction: idea?.conviction ?? null,
    catalyst: idea?.catalyst ?? null,
    regimeTrend: idea?.regimeTrend ?? null,
    entryPriceAtIdea: idea?.entryPrice ?? null,
    ideaAction: idea?.action ?? null,
  });
}

// Close out a journal entry: records the exit, computes realized P&L, and —
// when the position traces back to an idea — also writes a "final" grade
// onto that idea immediately (a real close is better evidence than the
// time-based +1h/+1d/expiry checkpoints in gradeLib.js, so it takes priority
// without waiting for one of those to come due).
export function journalClose(entryRow, { exitOrderId, exitOrderStatus, exitQuantity, exitFillPrice, exitReason, exitReasonTag, underlyingPriceAtClose }) {
  const { pnl, pnlPct } = realizedPnl(entryRow, exitFillPrice);
  const grade = planGrade(entryRow, underlyingPriceAtClose);
  const updated = updateJournalEntry(entryRow.id, {
    status: "closed",
    exitOrderId, exitOrderStatus, exitQuantity, exitFillPrice,
    exitAt: new Date().toISOString(),
    exitReason, exitReasonTag: exitReasonTag ?? null,
    pnl, pnlPct,
    daysHeld: daysHeld(entryRow),
    rMultiple: grade?.r ?? null,
    followedPlan: grade?.correct ?? null,
  });
  if (entryRow.ideaId && grade) {
    const idea = listIdeas().find((i) => i.id === entryRow.ideaId);
    if (idea) updateIdea(idea.id, { grades: { ...idea.grades, final: grade } });
  }
  return updated;
}
