/* ---------- The entry rules, in one testable place ----------

   These used to live inline in the autotrade route, where nothing could test
   them without a running server, a broker and live quotes — and changes to
   one rule kept breaking another. Every number here is a rule the user has
   agreed to; tests/rules.contract.test.js pins each one, so changing one
   means changing that test on purpose, with the user's say-so.

   Pure functions only: no network, no store, no clock unless one is passed. */
import { OPTION_HARD_PCT } from "../sizingLib.js";
import { HARD_LOSS_PCT } from "./exitRules.js";
import { optionStopPct } from "../swingLib.js";

export const RISK_PER_TRADE_PCT = 1;            // of the account, lost at the stop
export const MIN_CONVICTION = 2;
export const MIN_REWARD_RISK = 1.5;
export const MAX_SYMBOL_EXPOSURE_PCT = 20;      // of the account, one underlying
export const MAX_TOTAL_EXPOSURE_PCT = 100;      // no borrowing
export const MAX_ENTRIES_PER_SYMBOL_DAY = 4;
export const REENTRY_COOLDOWN_MIN = 45;
export const LAST_FLAT_BY_CLOSE_ENTRY_MIN = 15 * 60; // ET; same-day contracts not opened after 15:00
export const MAX_SPREAD_PCT_OF_PREMIUM = 6;
export const MAX_SPREAD_SHARE_OF_LOSS = 0.4;
export const SAME_DAY = new Set(["intraday", "contrarian", "fade_scan"]);

/* ---------- Learning mode (2026-10-14) ----------
   The owner, 2026-10-14: "remove all the blockers that will block you from
   learning ... I need you to always buy->sell->learn ... always try and
   always learn from every single contract or trade."
   The day before, 41 candidates produced 0 trades: every idea that triggered
   was refused by one rule or another, and a refused trade teaches nothing.
   So in learning mode (on unless LEARNING_MODE=false) the SOFT rules below
   no longer refuse. Each one that would have refused is written on the trade
   as learningOverrides, and the edge report splits results by it, so every
   rule is now judged by what it would have saved or cost on real fills.
   The HARD rules still refuse, because they protect the account or the
   meaning of the trade rather than express an opinion about it:
     paper only; regular session only; the daily loss halt; the 1% max-loss
     exit and the option stop; the 15% position, 20% per-symbol and total
     capital caps; an idea's own trigger must have fired; price already
     through the invalidation or at the target (setupVoid); an exact repeat of an open
     position; no usable stop to size from; a same-day contract opened after
     15:30 (it is sold at 15:45); and at most 8 entries per symbol per day,
     a runaway guard so a broken loop cannot buy the same name every minute. */
export const learningMode = (env = process.env) => env.LEARNING_MODE !== "false";

/* A setup is VOID, in or out of learning mode, when the live price is already
   through its invalidation or already at its target: there is no trade left.
   The target half was added 2026-10-14 within minutes of learning mode going
   live. A SPY put whose target was behind the price was bought, sold by the
   target exit a minute later for -$13, and bought again (-$15), a loop that
   only the reward:risk refusal had been hiding. Returns a reason, or null.
   dir: +1 for CALL/BUY, -1 for PUT/SELL. */
/* An idea from an earlier session is not a trade today, in or out of
   learning mode. Learning mode had made staleness a recorded override, and on
   2026-10-14 the 10-13 fades of NVDA, INTC, AVGO and ORCL were placed all
   day at the previous afternoon's stock price, target and option price. The
   ET calendar date decides. */
export const etDate = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
export const fromEarlierSession = (createdAt, now = Date.now()) => Boolean(createdAt) && etDate(createdAt) < etDate(now);

/* An idea that carried a position to its TARGET (or the +50% profit take) is
   finished; buying it again is buying a move that has already happened. Six
   SPY round trips on 2026-10-14 did exactly that around its $768 target. An
   idea closed at a stop may still be retried in learning mode. */
export const PLAYED_OUT_EXITS = new Set(["target", "take_profit"]);

/* Entries that count toward the per-stock daily cap: an order that never
   filled tested nothing. INTC had 7 entries on 2026-10-14, every one a
   stale-priced order withdrawn unfilled. */
export const countsAsEntry = (row) => !["unfilled", "orphaned"].includes(row?.exitReasonTag);

export function setupVoid({ dir, entry, target, invalidation }) {
  const e = Number(entry), t = Number(target), v = Number(invalidation);
  if (e > 0 && v > 0 && (dir > 0 ? e <= v : e >= v)) return `Live price $${e} is already ${dir > 0 ? "at or below" : "at or above"} the $${v} invalidation — the setup is void, not cheap.`;
  if (e > 0 && t > 0 && (dir > 0 ? e >= t : e <= t)) return `Live price $${e} is already ${dir > 0 ? "at or above" : "at or below"} the $${t} target — the move this trade was for has happened; it would be sold at once.`;
  return null;
}
export const SOFT_RULES = Object.freeze([
  "conviction", "edge_throttle", "selection", "stale", "extreme", "reward_risk", "consumed",
  "daily_cap", "cooldown", "tape", "late_entry", "over_budget", "spread", "watch_only", "pdt",
]);
export const LEARNING_LAST_ENTRY_MIN = 15 * 60 + 30;   // ET; hard, same-day contracts
export const LEARNING_MAX_ENTRIES_PER_SYMBOL_DAY = 8;  // hard runaway guard

/* ---------- The entry-confirmation test (2026-10-14) ----------
   Of 19 losing option trades since 10-07, 17 never showed more than +3% on
   the option: the entry fired the minute a level broke, at the end of a
   small move, paid the ask, and the stock pulled back. The owner: "lets
   test that". So triggered ideas are split in two, by idea id:
     "immediate": buy when the live price is through the trigger (as before);
     "confirm":   also wait for the last CONFIRM_BARS COMPLETED one-minute
                  bars to close beyond the trigger.
   Every journal row carries its entryStyle, and /api/edge splits by it.
   ENTRY_CONFIRM=all puts every idea in "confirm", =off every idea in
   "immediate"; the default is the split. */
export const CONFIRM_BARS = 2;
/* Pass a stable key for the setup, not the row id: a refresh every 30
   minutes writes a new row for the same setup, and a per-row split flipped a
   setup between the arms. The route keys it by symbol, action and ET date. */
export function entryArm(ideaId, env = process.env) {
  const mode = env.ENTRY_CONFIRM || "ab";
  if (mode === "off") return "immediate";
  if (mode === "all") return "confirm";
  let h = 0;
  for (const c of String(ideaId ?? "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2 === 0 ? "confirm" : "immediate";
}
/* bars: one-minute bars [{ time: "YYYY-MM-DDTHH:MM:SS", close }], oldest
   first. nowMinute: "YYYY-MM-DDTHH:MM" in the same clock; the bar for that
   minute is still forming and does not count. */
export function confirmedBreak({ bars, trigger, direction, nowMinute, n = CONFIRM_BARS }) {
  const done = (bars || []).filter((b) => b && Number.isFinite(Number(b.close)) && (!nowMinute || String(b.time).slice(0, 16) < nowMinute));
  if (done.length < n) return false;
  const t = Number(trigger);
  return done.slice(-n).every((b) => (direction === "above" ? Number(b.close) > t : Number(b.close) < t));
}

/* The limit price for a buy: the ASK. Decided 2026-10-14 after a day at the
   mid: the one order that filled (GOOGL fade, -$238) filled only as the trade
   turned, and the puts that were right never filled. ENTRY_AT_MID=true goes
   back to the mid; nothing else does. */
export function payPrice(leg, { atMid = process.env.ENTRY_AT_MID === "true" } = {}) {
  const bid = Number(leg?.bid), ask = Number(leg?.ask);
  if (atMid && bid > 0 && ask > 0) return Math.round(((bid + ask) / 2) * 100) / 100;
  return ask > 0 ? ask : (Number(leg?.mid) || null);
}

/* How many contracts, and whether to take the trade at all.
   Risk per contract is the loss at whichever stop fires FIRST: the idea's own
   invalidation (delta x distance) or the option's own stop (its stock's
   swing profile, else the flat HARD_LOSS_PCT), plus the spread paid to get
   out. Contracts = the 1% budget / that risk, never more than the 15%
   position cap, at least one — except a same-day trade is refused when one
   contract would risk more than 1.5x the budget. Then the spread checks. */
export function sizeOptionEntry({ accountSize, leg, entryPrice, invalidation, action, strategy, profile = null, atMid, riskMult = 1, learning = false }) {
  // learning: the over-budget and spread refusals become overrides on a trade
  // that is taken anyway (one contract when one is over budget).
  const overrides = [];
  // riskMult: the edge throttle (edgeLib) — 1, 0.5 or 0.25 of the 1% budget.
  const budget = (accountSize * RISK_PER_TRADE_PCT * Math.max(0, Math.min(1, Number(riskMult) || 1))) / 100;
  const delta = Math.abs(Number(leg?.delta)) || 0.6;
  const spread = Math.max(0, (Number(leg?.ask) || 0) - (Number(leg?.bid) || 0));
  const premium = Number(payPrice(leg, { atMid })) || 0;
  const stopDist = Math.abs(Number(entryPrice) - Number(invalidation));
  const ideaStopRisk = Number.isFinite(stopDist) && stopDist > 0 ? (delta * stopDist + spread) * 100 : Infinity;
  const optionType = action === "PUT" ? "put" : "call";
  const stopPct = optionStopPct({ optionType, profile, price: entryPrice, delta, premium }) ?? HARD_LOSS_PCT.OPTION;
  const optionStopRisk = premium > 0 && stopPct ? (premium * (stopPct / 100) + spread) * 100 : Infinity;
  const riskPer = Math.min(ideaStopRisk, optionStopRisk);
  if (!(riskPer > 0) || !Number.isFinite(riskPer)) return { ok: false, reason: "Cannot size this trade: no usable stop distance.", stopPct };

  let contracts = Math.floor(budget / riskPer);
  if (contracts < 1) {
    if (SAME_DAY.has(strategy) && riskPer > budget * 1.5) {
      if (learning) overrides.push({ rule: "over_budget", reason: `One contract risks about $${riskPer.toFixed(0)} at the stop, over the $${(budget * 1.5).toFixed(0)} same-day limit; taken at one contract, the max-loss exit still caps it.` });
      else return { ok: false, stopPct, riskPer, reason: `One contract would lose about $${riskPer.toFixed(0)} at the stop — over the $${(budget * 1.5).toFixed(0)} most a same-day trade may risk (${RISK_PER_TRADE_PCT}% of the account, with half again of leeway).` };
    }
    contracts = 1;
  }
  const perContract = premium * 100;
  if (perContract > 0) contracts = Math.max(1, Math.min(contracts, Math.floor((accountSize * OPTION_HARD_PCT) / perContract) || 1));

  if (premium > 0 && (spread / premium) * 100 > MAX_SPREAD_PCT_OF_PREMIUM) {
    if (learning) overrides.push({ rule: "spread", reason: `Spread is ${((spread / premium) * 100).toFixed(1)}% of the premium ($${leg?.bid}/$${leg?.ask}), over ${MAX_SPREAD_PCT_OF_PREMIUM}%.` });
    else return { ok: false, stopPct, riskPer, contracts, reason: `Spread is ${((spread / premium) * 100).toFixed(1)}% of the premium ($${leg?.bid}/$${leg?.ask}) — over ${MAX_SPREAD_PCT_OF_PREMIUM}%, so the position would open most of the way to its ${stopPct}% stop.` };
  }
  const spreadCost = spread * 100 * contracts;
  if (spreadCost > budget * MAX_SPREAD_SHARE_OF_LOSS) {
    if (learning) overrides.push({ rule: "spread", reason: `Spread costs $${spreadCost.toFixed(0)} on arrival, over ${(MAX_SPREAD_SHARE_OF_LOSS * 100).toFixed(0)}% of the $${budget.toFixed(0)} a trade may lose.` });
    else return { ok: false, stopPct, riskPer, contracts, reason: `Spread too wide: buying at $${leg?.ask} against a $${leg?.bid} bid costs $${spreadCost.toFixed(0)} on arrival — over ${(MAX_SPREAD_SHARE_OF_LOSS * 100).toFixed(0)}% of the $${budget.toFixed(0)} a trade may lose.` };
  }
  return { ok: true, contracts, riskPer, stopPct, riskAtStop: Math.round(riskPer * contracts), budget, overrides };
}

// Same-day contracts are not opened after 15:00 ET.
// In learning mode the hard line is 15:30; 15:00-15:30 is a recorded override.
export function lateEntryRefused({ flatByClose, etMinutes, learning = false }) {
  return Boolean(flatByClose) && Number(etMinutes) >= (learning ? LEARNING_LAST_ENTRY_MIN : LAST_FLAT_BY_CLOSE_ENTRY_MIN);
}

/* Which playbooks record what they would buy and place nothing.
   fade_scan: always (unproven population). contrarian (the fade): unless
   FADE_LIVE=true — it went 0 for 2 live.
   intraday (same-day ideas): LIVE since 2026-10-14 ~12:00 ET, the owner's
   call ("lets have those live and learn"). It was watch-only from 2026-10-08,
   after the wrong-side-entry losses, and recorded 5 for 5 (about +$319,
   estimated from traded prices) once that bug was fixed. INTRADAY_LIVE=false
   puts it back to recording only. */
/* In learning mode nothing is watch-only: every playbook trades, so the fade
   and the scan are judged on real fills rather than estimates. */
export function isWatchOnly(strategy, env = process.env) {
  if (learningMode(env)) return false;
  if (strategy === "fade_scan") return true;
  if (strategy === "contrarian") return env.FADE_LIVE !== "true";
  if (strategy === "intraday") return env.INTRADAY_LIVE === "false";
  return false;
}

// New positions are opened only in the regular session.
export const entriesAllowed = (clockState) => clockState === "open";
