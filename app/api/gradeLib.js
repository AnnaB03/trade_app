/* ---------- Grading a past idea against what actually happened ----------
   Point-in-time grading (samples the current price at a checkpoint) rather
   than fully path-dependent — simpler, still gives a real correctness +
   R-multiple signal without needing intraday bar history for every idea. */

const DIRECTION = { CALL: 1, BUY: 1, PUT: -1, SELL: -1 };

export function directionOf(idea) {
  return DIRECTION[idea.action] ?? 0;
}

// entryPrice: underlying spot when the idea was made (idea.entryPrice).
// currentPrice: underlying spot now.
// invalidation/target: underlying price levels (may be null if the model gave none).
export function gradeAt(idea, currentPrice) {
  const dir = directionOf(idea);
  const entry = Number(idea.entryPrice);
  const px = Number(currentPrice);
  if (!dir || !(entry > 0) || !(px > 0)) return null;
  const movePct = ((px - entry) / entry) * 100;
  const correct = movePct * dir > 0;
  // R-multiple needs a real risk distance in the denominator. A stop set a
  // few cents from entry (seen in practice — the model anchoring an
  // invalidation right at the prior close) makes riskPct near-zero, and
  // dividing any ordinary move by that produces an absurd R (600+), which
  // then silently dominates every average it touches — including the
  // calibration text fed back into the next prompt. Below ~0.3% of entry,
  // the stop is noise-level for a normal name anyway, so R is left
  // uncomputed (null) rather than reporting a number nobody should trust.
  const MIN_RISK_PCT = 0.3;
  let r = null;
  const inv = Number(idea.invalidation);
  if (inv > 0) {
    const riskPct = Math.abs((entry - inv) / entry) * 100;
    if (riskPct >= MIN_RISK_PCT) r = (movePct * dir) / riskPct;
  }
  let hitTarget = null;
  const tgt = Number(idea.target);
  if (tgt > 0) {
    hitTarget = dir > 0 ? px >= tgt : px <= tgt;
  }
  let hitInvalidation = null;
  if (inv > 0) {
    hitInvalidation = dir > 0 ? px <= inv : px >= inv;
  }
  return { at: new Date().toISOString(), price: px, movePct, correct, r, hitTarget, hitInvalidation };
}

// Checkpoints, by age since the idea was created.
export const CHECKPOINTS = [
  { key: "h1", afterMs: 60 * 60 * 1000, label: "+1 hour" },
  { key: "d1", afterMs: 24 * 60 * 60 * 1000, label: "+1 day" },
];

// The "final" checkpoint is expiration-aware: an option idea grades final at
// its expiration date; a shares idea grades final 5 calendar days out (a
// reasonable swing horizon since it carries no expiry of its own).
export function finalDueAt(idea) {
  if (idea.expiration) return new Date(idea.expiration + "T21:00:00Z").getTime(); // ~4pm ET
  return gradeStart(idea) + 5 * 24 * 60 * 60 * 1000;
}

// When an idea's grading clock starts. Normally its creation; a resting-limit
// sweep idea starts when price actually reached its limit (see sweepsLib.js).
export function gradeStart(idea) {
  return new Date(idea.gradeFrom || idea.createdAt).getTime();
}

// Not a trade (yet, or ever): a limit that hasn't filled, or never did.
export function isGradable(idea) {
  return ["CALL", "PUT", "BUY", "SELL"].includes(idea.action) && !idea.pendingFill && !idea.unfilled;
}

export function isFinalDue(idea, now = Date.now()) {
  return isGradable(idea) && !idea.grades?.final && now >= finalDueAt(idea);
}
