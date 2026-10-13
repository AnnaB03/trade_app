/* ---------- Portfolio-level risk: the daily loss limit and the kill switch ----------
   Every other gate in autotrade is per trade (loss at the stop, position
   cap, symbol cap, total exposure). Nothing stopped the book after a bad
   morning, and nothing let a person stop it short of killing the server.

   Two halts, both of which stop NEW ENTRIES only. Exits keep running — a
   halted book still manages what it holds; it just does not add to it.
   - daily_loss: realized P&L today (closed rows, net of fees, non-legacy)
     is at or past DAILY_LOSS_LIMIT_PCT of the account. Set automatically by
     the entry path, keyed to the New York date, so it clears itself at the
     next session. Default 5%: five max-loss (1%) trades in one session.
   - manual: set and cleared by hand through /api/halt. Never expires.
   State lives in the store's kv table, so every route and every process
   sees the same answer, and a restart does not forget a halt. */
import { listJournal, kvGet, kvSet, kvDelete } from "./store.js";
import { readBaseline, isLegacy } from "./ledgerLib.js";

export const HALT_KEY = "trading_halt";
export const DAILY_LOSS_LIMIT_PCT = Number(process.env.DAILY_LOSS_LIMIT_PCT) > 0 ? Number(process.env.DAILY_LOSS_LIMIT_PCT) : 5;

export const dateET = (d = new Date()) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// Realized P&L booked today (ET), from closed journal rows that carry a
// number. Unrealized P&L is deliberately not here: it needs quotes, and a
// halt that flickers with the mark is a halt nobody trusts.
export function realizedPnlToday(rows, { today = dateET(), baseline = readBaseline() } = {}) {
  return rows
    .filter((r) => r.status === "closed" && typeof r.pnl === "number" && !isLegacy(r, baseline) && r.exitAt && dateET(r.exitAt) === today)
    .reduce((s, r) => s + r.pnl, 0);
}

export const dailyLossLimitUsd = (accountSize) => (Number(accountSize) > 0 ? Number(accountSize) : 0) * DAILY_LOSS_LIMIT_PCT / 100;

/* The decision, with no I/O, so it can be tested on stated figures.
   stored: what the kv table holds (or null). Returns { halted, kind, reason,
   expired } — expired means a stored daily halt from an earlier session
   that the caller should clear. */
export function evaluateHalt({ stored, lossToday, limitUsd, today = dateET() }) {
  if (stored?.halted && stored.kind === "manual") return { halted: true, kind: "manual", reason: stored.reason || "halted by hand", since: stored.since };
  let expired = false;
  if (stored?.halted && stored.kind === "daily_loss") {
    if (stored.day === today) return { halted: true, kind: "daily_loss", reason: stored.reason, since: stored.since };
    // An earlier session's halt has lapsed, but today's own loss still has
    // to be judged before this answers "not halted".
    expired = true;
  }
  if (limitUsd > 0 && lossToday <= -limitUsd) {
    return {
      halted: true, kind: "daily_loss", fresh: true, ...(expired ? { expired } : {}),
      reason: `Down $${Math.abs(lossToday).toFixed(0)} realized today — at the $${limitUsd.toFixed(0)} daily loss limit (${DAILY_LOSS_LIMIT_PCT}% of the account). No new entries until the next session.`,
    };
  }
  return expired ? { halted: false, expired } : { halted: false };
}

export const readHalt = () => kvGet(HALT_KEY);

export function haltTrading(reason, { kind = "manual", day = null } = {}) {
  return kvSet(HALT_KEY, { halted: true, kind, reason: reason || "halted by hand", day, since: new Date().toISOString() });
}

export function resumeTrading() { kvDelete(HALT_KEY); return { halted: false }; }

/* What the entry path asks before placing anything. Reads the journal,
   applies the rule, and records a fresh daily halt so the reason is stated
   once and the UI can show it. */
export function tradingHalt({ accountSize, journal = listJournal(), now = new Date() } = {}) {
  const today = dateET(now);
  const lossToday = realizedPnlToday(journal, { today });
  const limitUsd = dailyLossLimitUsd(accountSize);
  const verdict = evaluateHalt({ stored: readHalt(), lossToday, limitUsd, today });
  if (verdict.expired) resumeTrading();
  // A fresh trip is recorded, and answers with the record's own timestamp so
  // the first caller and every later one report the same "since".
  const recorded = verdict.fresh ? haltTrading(verdict.reason, { kind: "daily_loss", day: today }) : null;
  return { ...verdict, ...(recorded ? { since: recorded.since } : {}), lossToday, limitUsd, limitPct: DAILY_LOSS_LIMIT_PCT, today };
}
