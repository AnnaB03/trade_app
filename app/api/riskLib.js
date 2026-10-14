/* ---------- The daily plan: portfolio-level stops ----------
   Every other gate in autotrade is per trade (loss at the stop, position
   cap, symbol cap, total exposure). These are the rules a trader sets for
   the DAY, before the open, so the decision is never made mid-session with
   money on the line. Written in R: one R is the most one trade may lose,
   1% of the account (MAX_LOSS_PCT in exitRules.js), $100 on $10K.

   - daily_loss:   realized loss today at DAILY_LOSS_LIMIT_PCT (5% = five
                   max-loss trades). Done for the day.
   - loss_streak:  MAX_LOSS_STREAK closed losers in a row today (3). The
                   read is off; stop before the fourth.
   - profit_lock:  realized gain today at DAILY_PROFIT_LOCK_PCT (2%, twice
                   the 1% goal). Take the day. The book's own record is
                   winners that round-trip — INTC +$670 to -$1,690, MRVL
                   +$587 to +$25, ROG +$587 to -$657 — and a good day given
                   back is the most common way a profitable week becomes a
                   flat one.
   - day_giveback: once the day's realized peak has reached the 1% goal
                   (DAILY_GOAL_PCT), giving back DAY_GIVEBACK_PCT of that
                   peak (50%) stops new entries. A trail on the day, like
                   the trail on a position.
   - manual:       the kill switch, /api/halt. Never expires.

   Every rule stops NEW ENTRIES only. Exits keep running — a halted book
   still manages what it holds; it just does not add to it. The automatic
   kinds are keyed to the New York date and clear themselves at the next
   session; set a rule's percentage to 0 to turn it off. State lives in the
   store's kv table, so every route and every process sees the same answer
   and a restart does not forget a halt. */
import { listJournal, kvGet, kvSet, kvDelete } from "./store.js";
import { readBaseline, isLegacy } from "./ledgerLib.js";
import { notifyHalt } from "./notifyLib.js";

export const HALT_KEY = "trading_halt";
const pct = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 && process.env[name] !== undefined && process.env[name] !== "" ? n : dflt; };
/* 5 -> 10 ($2,500 at $25K, five full losers at 2%): 2026-10-14, the owner, choosing "2%, and a 10% daily halt": the 20% option
   stop had halved the contracts bought for the same $250, and this keeps the
   contract counts while the stop gives the price room. */
export const DAILY_LOSS_LIMIT_PCT = pct("DAILY_LOSS_LIMIT_PCT", 10);
export const DAILY_GOAL_PCT = pct("DAILY_GOAL_PCT", 1);
export const DAILY_PROFIT_LOCK_PCT = pct("DAILY_PROFIT_LOCK_PCT", 2);
export const DAY_GIVEBACK_PCT = pct("DAY_GIVEBACK_PCT", 50);
export const MAX_LOSS_STREAK = pct("MAX_LOSS_STREAK", 3);

export const dateET = (d = new Date()) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export function planLimits(accountSize) {
  const a = Number(accountSize) > 0 ? Number(accountSize) : 0;
  return {
    account: a,
    lossLimitUsd: (a * DAILY_LOSS_LIMIT_PCT) / 100,
    goalUsd: (a * DAILY_GOAL_PCT) / 100,
    profitLockUsd: (a * DAILY_PROFIT_LOCK_PCT) / 100,
    givebackPct: DAY_GIVEBACK_PCT,
    maxStreak: MAX_LOSS_STREAK,
    lossLimitPct: DAILY_LOSS_LIMIT_PCT, goalPct: DAILY_GOAL_PCT, profitLockPct: DAILY_PROFIT_LOCK_PCT,
  };
}

/* Today's closed trades, in the order they closed: realized P&L, the running
   peak of it, and the losing streak at the end. Unrealized P&L is
   deliberately not here: it needs quotes, and a halt that flickers with the
   mark is a halt nobody trusts. Only rows with a booked number count —
   orphaned rows and goal-excluded rows are not trades. */
export function dayStats(rows, { today = dateET(), baseline = readBaseline() } = {}) {
  const closes = rows
    .filter((r) => r.status === "closed" && typeof r.pnl === "number" && !r.excludeFromGoal && r.exitReasonTag !== "orphaned" && !isLegacy(r, baseline) && r.exitAt && dateET(r.exitAt) === today)
    .sort((a, b) => new Date(a.exitAt) - new Date(b.exitAt));
  let realized = 0, peak = 0, streak = 0, wins = 0, losses = 0;
  for (const r of closes) {
    realized += r.pnl;
    if (realized > peak) peak = realized;
    if (r.pnl < 0) { streak++; losses++; } else { streak = 0; if (r.pnl > 0) wins++; }
  }
  return { realized, peak, streak, closes: closes.length, wins, losses };
}

// Kept for callers that only want the number.
export const realizedPnlToday = (rows, opts) => dayStats(rows, opts).realized;
export const dailyLossLimitUsd = (accountSize) => planLimits(accountSize).lossLimitUsd;

const AUTO_KINDS = new Set(["daily_loss", "loss_streak", "profit_lock", "day_giveback"]);
export const isAutoHalt = (kind) => AUTO_KINDS.has(kind);

/* The decision, with no I/O, so it can be tested on stated figures.
   stored: what the kv table holds (or null). day: dayStats(). limits:
   planLimits(). Returns { halted, kind, reason, fresh?, expired? } — fresh
   means the caller should record it; expired means a stored halt from an
   earlier session that the caller should clear. Checked in the order a
   trader would: a loss rule before a profit rule. */
export function evaluateHalt({ stored, day, limits, today = dateET() }) {
  if (stored?.halted && stored.kind === "manual") return { halted: true, kind: "manual", reason: stored.reason || "halted by hand", since: stored.since };
  let expired = false;
  if (stored?.halted && isAutoHalt(stored.kind)) {
    if (stored.day === today) return { halted: true, kind: stored.kind, reason: stored.reason, since: stored.since };
    // An earlier session's halt has lapsed, but today's own figures still
    // have to be judged before this answers "not halted".
    expired = true;
  }
  const L = limits, D = day;
  const fresh = (kind, reason) => ({ halted: true, kind, reason, fresh: true, ...(expired ? { expired } : {}) });
  const usd = (v) => `$${Math.abs(v).toFixed(0)}`;
  if (L.lossLimitUsd > 0 && D.realized <= -L.lossLimitUsd) {
    return fresh("daily_loss", `Down ${usd(D.realized)} realized today — at the ${usd(L.lossLimitUsd)} daily loss limit (${L.lossLimitPct}% of the account). Done for the day; new entries resume at the next session.`);
  }
  if (L.maxStreak > 0 && D.streak >= L.maxStreak) {
    return fresh("loss_streak", `${D.streak} losing trades in a row today (${usd(D.realized)} on the day). The read is off — no new entries until the next session.`);
  }
  if (L.profitLockUsd > 0 && D.realized >= L.profitLockUsd) {
    return fresh("profit_lock", `Up ${usd(D.realized)} realized today — past the ${usd(L.profitLockUsd)} profit lock (${L.profitLockPct}% of the account, ${(L.profitLockPct / (L.goalPct || 1)).toFixed(0)}x the daily goal). Taking the day; new entries resume at the next session.`);
  }
  if (L.goalUsd > 0 && L.givebackPct > 0 && D.peak >= L.goalUsd && D.realized <= D.peak * (1 - L.givebackPct / 100)) {
    return fresh("day_giveback", `The day peaked at ${usd(D.peak)} realized (past the ${usd(L.goalUsd)} goal) and has given back to ${D.realized < 0 ? "-" : ""}${usd(D.realized)} — more than ${L.givebackPct}% of it. Keeping what is left; new entries resume at the next session.`);
  }
  return expired ? { halted: false, expired } : { halted: false };
}

export const readHalt = () => kvGet(HALT_KEY);

export function haltTrading(reason, { kind = "manual", day = null } = {}) {
  return kvSet(HALT_KEY, { halted: true, kind, reason: reason || "halted by hand", day, since: new Date().toISOString() });
}

export function resumeTrading() { kvDelete(HALT_KEY); return { halted: false }; }

/* What the entry path asks before placing anything. Reads the journal,
   applies the rules, records a fresh halt (once, with a push notification)
   so the reason is stated and the UI can show it, and clears a lapsed one. */
export function tradingHalt({ accountSize, journal = listJournal(), now = new Date() } = {}) {
  const today = dateET(now);
  const day = dayStats(journal, { today });
  const limits = planLimits(accountSize);
  const verdict = evaluateHalt({ stored: readHalt(), day, limits, today });
  if (verdict.expired) resumeTrading();
  let recorded = null;
  if (verdict.fresh) {
    recorded = haltTrading(verdict.reason, { kind: verdict.kind, day: today });
    notifyHalt({ kind: verdict.kind, reason: verdict.reason }).catch(() => {});
  }
  return {
    ...verdict, ...(recorded ? { since: recorded.since } : {}),
    day, limits, today,
    // Older field names, still read by the UI and the tests.
    lossToday: day.realized, limitUsd: limits.lossLimitUsd, limitPct: limits.lossLimitPct,
  };
}
