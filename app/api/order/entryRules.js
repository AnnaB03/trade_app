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

/* 1 -> 2: 2026-10-14, the owner, choosing "2%, and a 10% daily halt": the 20% option
   stop had halved the contracts bought for the same $250, and this keeps the
   contract counts while the stop gives the price room. */
export const RISK_PER_TRADE_PCT = 2;            // of the account, lost at the stop ($500 at $25K)
export const MIN_CONVICTION = 2;
export const MIN_REWARD_RISK = 1.5;
export const MAX_SYMBOL_EXPOSURE_PCT = 20;      // of the account, one underlying
export const MAX_TOTAL_EXPOSURE_PCT = 100;      // no borrowing
export const MAX_ENTRIES_PER_SYMBOL_DAY = 4;
export const REENTRY_COOLDOWN_MIN = 45;
/* No new option trade from 14:00 ET (owner, 2026-10-22). Since 10-07, same-day
   trades bought from 14:00 lost in both halves of the record (19 trades -$334,
   then 13 trades -$2,397): under two hours before the 15:45 sale is too little
   for them to work. Was 15:00 (15:30 in learning mode). */
export const LAST_FLAT_BY_CLOSE_ENTRY_MIN = 14 * 60; // ET
export const MAX_SPREAD_PCT_OF_PREMIUM = 6;
export const MAX_SPREAD_SHARE_OF_LOSS = 0.4;
/* Hard, in learning mode too (2026-10-15): a contract whose spread is over
   HARD_MAX_SPREAD_PCT of its price, or would cost over HARD_MAX_SPREAD_SHARE
   of the loss limit on arrival, starts most of the way to its stop and can
   only teach the spread. MU 10/21 $885c (15.8%, $480 of a $500 limit) and
   QCOM 10/23 $175p (13.9%) came in this way; the two spread-override trades
   that closed lost $838. */
export const HARD_MAX_SPREAD_PCT = 12;
export const HARD_MAX_SPREAD_SHARE = 0.5;
/* No option under $1 (owner, 2026-10-23), in learning mode too. Every one
   bought since 10-07 lost: AAL x5, 0 winners, -$2,490. At 20-40 cents one
   cent is 3-5% of the price, so a 20% stop is a few ticks and fills past
   itself (AAL 10/23 $12p: -30% against a 20% stop). */
export const MIN_OPTION_PREMIUM = 1;
export const SAME_DAY = new Set(["intraday", "contrarian", "fade_scan", "news"]); // "news": the analyst's ideas, 2026-10-14

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
     position; no usable stop to size from; a same-day contract opened from
     14:00 (it is sold at 15:45); and at most 8 entries per symbol per day,
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

/* ---------- Two rules from the 2026-10-14 day replay ----------
   Replaying the day under the new rules, three GOOGL fades in 13 minutes and
   GOOGL calls bought minutes after GOOGL puts made seven losers by 10:28
   (-$2,445), within $55 of the daily halt. With 3% worse fills the day was
   halted there and every later winner was missed (-$2,874). With both rules
   below: +$6,454 at replay fills, +$3,065 at 3% worse. The owner: "sure, lets
   do that and test". A trade either rule blocks is written to the shadow book
   (blockedBy), so each rule is scored on what it stopped.
   rows: today's journal rows for the symbol that count as entries. */
export const FADES_PER_SYMBOL_DAY = 1;
export const FLIP_WAIT_MIN = 30;
export const isFade = (strategy) => strategy === "contrarian" || strategy === "fade_scan";
const rowDir = (r) => (r.optionType === "call" || (!r.optionType && r.side === "buy") ? 1 : r.optionType === "put" || (!r.optionType && r.side === "sell") ? -1 : 0);
export function fadeLimitReached({ strategy, rows }) {
  if (!isFade(strategy)) return null;
  const n = (rows || []).filter((r) => isFade(r.strategy)).length;
  return n >= FADES_PER_SYMBOL_DAY ? `Already faded this stock today (${n}); one fade per stock per day.` : null;
}
export function flipTooSoon({ action, rows, now = Date.now(), waitMin = FLIP_WAIT_MIN }) {
  const dir = action === "CALL" || action === "BUY" ? 1 : -1;
  const opposite = (rows || []).filter((r) => rowDir(r) === -dir && r.entryAt && now - Date.parse(r.entryAt) < waitMin * 60000)
    .sort((a, b) => Date.parse(b.entryAt) - Date.parse(a.entryAt))[0];
  if (!opposite) return null;
  const mins = Math.round((now - Date.parse(opposite.entryAt)) / 60000);
  return `Bought the other side of this stock ${mins} min ago (${opposite.optionType ?? opposite.side}); no flipping sides within ${waitMin} minutes.`;
}

/* No re-buying a stock on the same side within REBUY_WAIT_MIN of any sale of
   it (manual, stop, trail, target, +50%). 2026-10-15, the owner, choosing
   "after every sale": eleven same-side re-buys within 30 minutes of a sale
   had lost $444 (5 winners). The worst was QQQ, re-bought a minute after the
   owner's own +$475 sale and stopped out for -$322. Like the other two rules,
   what it blocks goes to the shadow book. rows: journal rows for the symbol
   (any day) with a filled entry and an exitAt. */
export const REBUY_WAIT_MIN = 30;
/* Exempt (2026-10-15, the owner): a stop or max-loss sale while the stock
   is still on the right side of the idea's stop level. The option's price
   sold it, not the thesis: MU was sold at -$536 with the stock $19 from its
   level, and the blocked re-buy would have made about +$1,000. livePrice: the
   stock now. */
// "stop_hit" (a resting broker stop) added 2026-10-22: a QQQ call stopped on
// the 10-20 opening gap was not exempt, and its blocked re-buy made +$752.
export const OPTION_PRICE_EXITS = new Set(["premium_stop", "max_loss", "stop", "stop_hit"]);
/* exemptionUsed (2026-10-16): the exemption is good once per idea per day.
   AVGO used it twice on 10-15: stop, re-bought one second later, stop again,
   re-bought again (+$73, then -$377). */
export function rebuyTooSoon({ action, rows, now = Date.now(), waitMin = REBUY_WAIT_MIN, livePrice = null, exemptionUsed = false }) {
  return rebuyCheck({ action, rows, now, waitMin, livePrice, exemptionUsed }).reason;
}
// { reason, exempted }: exempted is true when only the exemption let it through.
export function rebuyCheck({ action, rows, now = Date.now(), waitMin = REBUY_WAIT_MIN, livePrice = null, exemptionUsed = false }) {
  const dir = action === "CALL" || action === "BUY" ? 1 : -1;
  const thesisIntact = (r) => !exemptionUsed && OPTION_PRICE_EXITS.has(r.exitReasonTag) && Number(livePrice) > 0 && Number(r.invalidation) > 0
    && (dir > 0 ? Number(livePrice) > Number(r.invalidation) : Number(livePrice) < Number(r.invalidation));
  const inWindow = (r) => r.exitAt && r.entryFillPrice != null && rowDir(r) === dir && now - Date.parse(r.exitAt) >= 0 && now - Date.parse(r.exitAt) < waitMin * 60000;
  const blocking = (rows || []).filter((r) => inWindow(r) && !thesisIntact(r));
  const exempted = !blocking.length && (rows || []).some((r) => inWindow(r) && thesisIntact(r));
  const last = blocking
    .sort((a, b) => Date.parse(b.exitAt) - Date.parse(a.exitAt))[0];
  if (!last) return { reason: null, exempted };
  const mins = Math.round((now - Date.parse(last.exitAt)) / 60000);
  return { reason: `Sold this stock on the same side ${mins} min ago (${last.exitReasonTag ?? "exit"}); no re-buying for ${waitMin} minutes after a sale.`, exempted: false };
}

/* At most MAX_TRADES_PER_IDEA_DAY trades of one idea per day (2026-10-16, the
   owner: "implement both"). The AVGO 10-15 same-day put idea, written at
   10:44 with a 45-minute shelf life, was traded 5 times (+$118, -$377, +$73,
   -$377, -$377 = -$941); by 12:30 AVGO had found a floor and the setup was
   over. Since the restart the cap would have blocked 9 trades from 3 ideas
   (-$728, 4 small winners worth +$139, 4% of all winning dollars). A fresh
   idea from a later refresh is a new idea and may trade.
   rows: today's journal rows that count as entries. */
export const MAX_TRADES_PER_IDEA_DAY = 2;
export function ideaCapReached({ ideaId, rows, max = MAX_TRADES_PER_IDEA_DAY }) {
  if (!ideaId) return null;
  const n = (rows || []).filter((r) => r.ideaId === ideaId).length;
  return n >= max ? `This idea has already been traded ${n} times today; at most ${max} trades per idea per day.` : null;
}

/* No holding both sides of one stock (2026-10-15, the owner: "ok, lets
   implement that"). While a stock has an open position on one side, the
   other side is not bought, however long ago the first was. Since the
   restart this would have blocked 4 losers (-$1,113: QQQ puts against a fade
   call, the AMZN and NVDA fade puts against calls) and 2 small winners
   (+$110). Paired positions mostly cancel and pay two spreads.
   openRows: today's open journal rows for the symbol. */
export function bothSidesOpen({ action, openRows }) {
  const dir = action === "CALL" || action === "BUY" ? 1 : -1;
  const other = (openRows || []).find((r) => rowDir(r) === -dir);
  return other ? `Already holding the other side of this stock (${other.optionType ?? other.side} ${other.occ ?? ""}, ${other.strategy ?? "manual"}); not holding both sides at once.` : null;
}

/* One position per stock, side and playbook, whatever contract it is in
   (2026-10-15). The duplicate check matched on the expiry, so a contract
   switched to another expiry (contractLib) slipped past it: ORCL held two
   same-day calls, Oct 16 $129 and Oct 23 $131. Different playbooks (a swing
   call and a same-day call) may still both hold a side. */
export const playbookOf = (strategy) => strategy || "ai";
export function samePlaybookPosition({ action, strategy, openRows }) {
  const dir = action === "CALL" || action === "BUY" ? 1 : -1;
  return (openRows || []).find((r) => rowDir(r) === dir && playbookOf(r.strategy) === playbookOf(strategy)) || null;
}

/* TARGET_MARGIN_PCT (2026-10-22): within 0.15% of the target counts as
   reached. The QCOM put on 10-16 was bought a few cents short of its target
   and sold "at target" a minute later for -$71, after the next quote ticked
   through; the same shape as the 10-14 SPY loop. */
export const TARGET_MARGIN_PCT = 0.15;
/* expiresToday: kept as a helper. The expiry-day buying ban built on it was
   undone on 2026-10-22, the same day: replayed, it would have blocked +$2,201
   of winners for one $481 loss (see the autotrade route). */
export const etDay = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
export const expiresToday = (expiration, now = Date.now()) => Boolean(expiration) && String(expiration).slice(0, 10) <= etDay(now);

/* No buying the other side of a stock within FLIP_AFTER_STOP_MIN of a
   stop-out on it (2026-10-22, the owner: "No other side within 30 min of a
   stop-out"). On 10-19 NVDA and INTC calls were stopped out and puts on the
   same stocks were bought two seconds later. Replayed since the restart: it
   blocks 11 trades, 8 losers (-$3,152) and 3 winners (+$852).
   rows: journal rows for the symbol with an exitAt. */
export const FLIP_AFTER_STOP_MIN = 30;
export const STOP_EXITS = new Set(["premium_stop", "stop", "stop_hit", "max_loss"]);
export function flipAfterStop({ action, rows, now = Date.now(), waitMin = FLIP_AFTER_STOP_MIN }) {
  const dir = action === "CALL" || action === "BUY" ? 1 : -1;
  const s = (rows || []).filter((r) => r.exitAt && STOP_EXITS.has(r.exitReasonTag) && rowDir(r) === -dir && now - Date.parse(r.exitAt) >= 0 && now - Date.parse(r.exitAt) < waitMin * 60000)
    .sort((a, b) => Date.parse(b.exitAt) - Date.parse(a.exitAt))[0];
  if (!s) return null;
  const mins = Math.round((now - Date.parse(s.exitAt)) / 60000);
  return `The other side of this stock was stopped out ${mins} min ago (${s.optionType ?? s.side}, ${s.exitReasonTag}); no flipping sides for ${waitMin} minutes after a stop-out.`;
}

export function setupVoid({ dir, entry, target, invalidation }) {
  const e = Number(entry), t = Number(target), v = Number(invalidation);
  if (e > 0 && v > 0 && (dir > 0 ? e <= v : e >= v)) return `Live price $${e} is already ${dir > 0 ? "at or below" : "at or above"} the $${v} invalidation — the setup is void, not cheap.`;
  const tm = t * (TARGET_MARGIN_PCT / 100);
  if (e > 0 && t > 0 && (dir > 0 ? e >= t - tm : e <= t + tm)) return `Live price $${e} is already ${dir > 0 ? "at or above" : "at or below"} the $${t} target — the move this trade was for has happened; it would be sold at once.`;
  return null;
}
export const SOFT_RULES = Object.freeze([
  "conviction", "edge_throttle", "selection", "stale", "extreme", "reward_risk", "consumed",
  "daily_cap", "cooldown", "tape", "late_entry", "over_budget", "spread", "watch_only", "pdt",
]);
/* Three or more warnings on one idea is a refusal, in learning mode too
   (owner, 2026-10-27). A single soft rule still records and trades; when
   several separate checks object at once the trade has lost in both halves
   of the record: same-day options bought before 14:00 with 3+ overrides,
   -$1,988 (10 of 20 won) then -$2,081 (3 of 10 won). Refusing them saves
   about $4,070 and gives up about $2,460 of winners (QQQ +$424, SPCX +$353,
   MU +$304). What it refuses goes to the shadow book as stacked_warnings. */
export const MAX_SOFT_WARNINGS = 2;
export function stackedWarnings(overrides = []) {
  const rules = [...new Set((overrides || []).map((o) => (typeof o === "string" ? o : o?.rule)).filter(Boolean))];
  return rules.length > MAX_SOFT_WARNINGS ? rules : null;
}
/* No new buy before 10:00 ET (owner, 2026-10-29), in learning mode too. Swing
   options bought 9:30-9:59 since 10-07 won 1 of 12, -$3,694 (both halves:
   0 of 5, then 1 of 7); 10-28's TSLA call bought at 9:30 was stopped at 9:44
   for -$501. Ideas that gapped through their trigger overnight fire at the
   open, into its widest spreads and swings. */
export const FIRST_ENTRY_MIN = 10 * 60;
export const tooEarlyToEnter = (etMinutes) => Number(etMinutes) < FIRST_ENTRY_MIN;
export const LEARNING_LAST_ENTRY_MIN = LAST_FLAT_BY_CLOSE_ENTRY_MIN; // ET; hard in learning mode too (was 15:30)
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

  if (premium > 0 && premium < MIN_OPTION_PREMIUM) {
    return { ok: false, stopPct, riskPer, contracts, hard: "under_1", reason: `The contract costs $${premium.toFixed(2)}, under the $${MIN_OPTION_PREMIUM} minimum: at this price one cent is ${(1 / premium).toFixed(1)}% and the stop cannot hold (options under $1 since 10-07: 5 trades, 0 winners, -$2,490).` };
  }
  if (premium > 0 && (spread / premium) * 100 > HARD_MAX_SPREAD_PCT) {
    return { ok: false, stopPct, riskPer, contracts, hard: "spread", reason: `Spread is ${((spread / premium) * 100).toFixed(1)}% of the premium ($${leg?.bid}/$${leg?.ask}), over the ${HARD_MAX_SPREAD_PCT}% hard ceiling: the position would open most of the way to its stop.` };
  }
  if (spread * 100 * contracts > budget * HARD_MAX_SPREAD_SHARE) {
    return { ok: false, stopPct, riskPer, contracts, hard: "spread", reason: `Spread costs $${(spread * 100 * contracts).toFixed(0)} on arrival, over half the $${budget.toFixed(0)} a trade may lose (hard ceiling).` };
  }
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

// Same-day contracts are not opened from 14:00 ET, in learning mode too.
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
