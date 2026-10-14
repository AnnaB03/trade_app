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
export function sizeOptionEntry({ accountSize, leg, entryPrice, invalidation, action, strategy, profile = null, atMid }) {
  const budget = (accountSize * RISK_PER_TRADE_PCT) / 100;
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
      return { ok: false, stopPct, riskPer, reason: `One contract would lose about $${riskPer.toFixed(0)} at the stop — over the $${(budget * 1.5).toFixed(0)} most a same-day trade may risk (${RISK_PER_TRADE_PCT}% of the account, with half again of leeway).` };
    }
    contracts = 1;
  }
  const perContract = premium * 100;
  if (perContract > 0) contracts = Math.max(1, Math.min(contracts, Math.floor((accountSize * OPTION_HARD_PCT) / perContract) || 1));

  if (premium > 0 && (spread / premium) * 100 > MAX_SPREAD_PCT_OF_PREMIUM) {
    return { ok: false, stopPct, riskPer, contracts, reason: `Spread is ${((spread / premium) * 100).toFixed(1)}% of the premium ($${leg?.bid}/$${leg?.ask}) — over ${MAX_SPREAD_PCT_OF_PREMIUM}%, so the position would open most of the way to its ${stopPct}% stop.` };
  }
  const spreadCost = spread * 100 * contracts;
  if (spreadCost > budget * MAX_SPREAD_SHARE_OF_LOSS) {
    return { ok: false, stopPct, riskPer, contracts, reason: `Spread too wide: buying at $${leg?.ask} against a $${leg?.bid} bid costs $${spreadCost.toFixed(0)} on arrival — over ${(MAX_SPREAD_SHARE_OF_LOSS * 100).toFixed(0)}% of the $${budget.toFixed(0)} a trade may lose.` };
  }
  return { ok: true, contracts, riskPer, stopPct, riskAtStop: Math.round(riskPer * contracts), budget };
}

// Same-day contracts are not opened after 15:00 ET.
export function lateEntryRefused({ flatByClose, etMinutes }) {
  return Boolean(flatByClose) && Number(etMinutes) >= LAST_FLAT_BY_CLOSE_ENTRY_MIN;
}

/* Which playbooks record what they would buy and place nothing.
   fade_scan: always (unproven population). contrarian (the fade): unless
   FADE_LIVE=true — it went 0 for 2 live. intraday: unless INTRADAY_LIVE=true
   — switched off 2026-10-08 after the wrong-side-entry losses. */
export function isWatchOnly(strategy, env = process.env) {
  if (strategy === "fade_scan") return true;
  if (strategy === "contrarian") return env.FADE_LIVE !== "true";
  if (strategy === "intraday") return env.INTRADAY_LIVE !== "true";
  return false;
}

// New positions are opened only in the regular session.
export const entriesAllowed = (clockState) => clockState === "open";
