/* A short-dated option contract for a same-day idea that names no contract:
   the latest expiry inside [dteMin, dteMax] that has a contract with delta in
   0.35-0.75, a spread under 10% of the mid and one contract under the 15%
   position cap, nearest the target delta. Used by the fade playbook and the
   news playbook (newsIdeasLib.js). Null when nothing fits. Moved here from
   the autotrade route on 2026-10-14 so both can share it. */
import { tradier, asArray } from "./tradier.js";
import { OPTION_HARD_PCT } from "./sizingLib.js";

/* With `price` (bug fix, 2026-11-06 QA): the delta filter read the chain's
   greeks, which early in the session are the previous close's, so after a gap
   it chose 6-10% out-of-the-money contracts recorded at "0.6 delta" (11/05
   fades: NVDA $197.50 call at $186.40, MU $785 at $710.90). Given the stock
   price it takes the strike nearest the money within NEAR_MAX_AWAY_PCT,
   like nearAtmContract, and ignores the greeks. */
export async function shortDatedContract(symbol, type, { accountSize, dteMin = 1, dteMax = 4, targetDelta = 0.6, price = null } = {}) {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dte = (e) => Math.round((Date.parse(e + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
    const ex = await tradier(`/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true`, { timeoutMs: 8000 });
    // Later first: the same move costs less decay a few days out.
    const exps = asArray(ex?.expirations?.date).filter((e) => dte(e) >= dteMin && dte(e) <= dteMax).sort().reverse();
    for (const exp of exps) {
      const cd = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(exp)}&greeks=true`, { timeoutMs: 9000 });
      if (Number(price) > 0) {
        const c = pickNearAtm(cd?.options?.option, { type, price: Number(price), maxCost: accountSize * OPTION_HARD_PCT });
        if (c) return { expiration: exp, dte: dte(exp), strike: Number(c.o.strike),
          leg: { occ: c.o.symbol, strike: Number(c.o.strike), bid: c.bid, ask: c.ask, mid: c.mid, delta: c.o.greeks?.delta != null ? Number(c.o.greeks.delta) : null } };
        continue;
      }
      const fits = asArray(cd?.options?.option)
        .filter((o) => o.option_type === type)
        .map((o) => {
          const bid = Number(o.bid), ask = Number(o.ask), mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
          return { o, bid, ask, mid, delta: Math.abs(Number(o.greeks?.delta) || 0) };
        })
        .filter((c) => c.mid > 0 && c.delta >= 0.35 && c.delta <= 0.75 && ((c.ask - c.bid) / c.mid) * 100 <= 10 && c.mid * 100 <= accountSize * OPTION_HARD_PCT)
        .sort((a, b) => Math.abs(a.delta - targetDelta) - Math.abs(b.delta - targetDelta));
      if (fits.length) {
        const c = fits[0];
        return { expiration: exp, dte: dte(exp), strike: Number(c.o.strike),
          leg: { occ: c.o.symbol, strike: Number(c.o.strike), bid: c.bid, ask: c.ask, mid: c.mid, delta: c.o.greeks?.delta != null ? Number(c.o.greeks.delta) : null } };
      }
    }
  } catch {}
  return null;
}

/* ---------- Near-term at the money (owner, 2026-11-04) ----------
   Every option idea buys the nearest expiry 1-5 days out, at the strike
   closest to the stock price, instead of the model's own contract. Every
   option is sold by 15:45, so a longer expiry only adds a wider spread, and
   the spread was most of the loss ($10,118 of $17,041 since 10/07,
   scripts/backtest/spread_cost.py). Replayed on 118 real trades at the same
   minute and sizing (scripts/backtest/contract_choice.py), it beat our own
   contract in both halves for both playbooks: swing +$824 vs +$574, then
   +$558 vs +$139; intraday +$416 vs -$89, then +$115 vs -$12; better on 9 of
   14 days. Its median spread was 1.4%, against 2.3% for ours. The owner:
   "lets test and build it if it would make sense". NEAR_ATM_CONTRACTS=false
   restores the old choice. */
export const NEAR_DTE_MIN = 1, NEAR_DTE_MAX = 5, NEAR_MAX_SPREAD_PCT = 10, NEAR_MIN_MID = 1;
// At the money means near it: on a cheap stock whose at-the-money options are under $1 (AAL at $13.63),
// the nearest that fits was a $12.50 call with a 0.96 delta. Beyond NEAR_MAX_AWAY_PCT it falls back.
export const NEAR_MAX_AWAY_PCT = 3;
export const nearAtmEnabled = () => process.env.NEAR_ATM_CONTRACTS !== "false";
// Pure. options: a Tradier chain for one expiry. The listed strike nearest the price that fits.
export function pickNearAtm(options, { type, price, maxCost }) {
  if (!(price > 0)) return null;
  const fits = asArray(options)
    .filter((o) => o.option_type === type)
    .map((o) => { const bid = Number(o.bid), ask = Number(o.ask); return { o, bid, ask, mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : 0 }; })
    .filter((c) => Math.abs(Number(c.o.strike) - price) / price * 100 <= NEAR_MAX_AWAY_PCT)
    .filter((c) => c.mid >= NEAR_MIN_MID && ((c.ask - c.bid) / c.mid) * 100 <= NEAR_MAX_SPREAD_PCT && (!(maxCost > 0) || c.ask * 100 <= maxCost))
    .sort((a, b) => Math.abs(Number(a.o.strike) - price) - Math.abs(Number(b.o.strike) - price));
  return fits[0] || null;
}
export async function nearAtmContract(symbol, type, { price, accountSize }) {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dte = (e) => Math.round((Date.parse(e + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
    const ex = await tradier(`/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true`, { timeoutMs: 8000 });
    // Nearest first: the replay bought the first expiry 1+ days out.
    const exps = asArray(ex?.expirations?.date).filter((e) => dte(e) >= NEAR_DTE_MIN && dte(e) <= NEAR_DTE_MAX).sort();
    for (const exp of exps) {
      const cd = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(exp)}&greeks=true`, { timeoutMs: 9000 });
      const c = pickNearAtm(cd?.options?.option, { type, price, maxCost: accountSize * OPTION_HARD_PCT });
      if (c) return { expiration: exp, dte: dte(exp), strike: Number(c.o.strike),
        leg: { occ: c.o.symbol, strike: Number(c.o.strike), bid: c.bid, ask: c.ask, mid: c.mid, delta: c.o.greeks?.delta != null ? Number(c.o.greeks.delta) : null } };
    }
  } catch {}
  return null;
}

/* ---------- Switching to a liquid contract (2026-10-15) ----------
   An idea names one contract. When its spread is wide, the same bet usually
   exists in a liquid one: MU's Oct 21 $885 call was 15.8% wide (71 open),
   while the Oct 23 $880 (3.7%) and the Oct 30 $900 (3.4%) traded thousands.
   The owner: "ok lets try that". Same stock and type, a delta within
   SWITCH_DELTA_BAND, an expiry no shorter than the idea needs and at most
   SWITCH_MAX_EXTRA_DAYS longer, a price inside the position cap, and the
   tightest spread wins. A switch never refuses anything: with nothing
   better, the idea's own contract goes on to the usual checks. */
export const SWITCH_SPREAD_PCT = 6;      // look for a better contract above this
export const SWITCH_DELTA_BAND = 0.08;
export const SWITCH_MAX_EXTRA_DAYS = 7;
export const spreadPct = (bid, ask) => { const b = Number(bid), a = Number(ask); return a > 0 && b > 0 ? ((a - b) / ((a + b) / 2)) * 100 : null; };

/* Pure. candidates: [{ occ, strike, expiration, dte, bid, ask, delta }].
   Returns the best one, or null when none is tighter than the current. */
export function pickLiquid(candidates, { targetDelta, currentSpreadPct, minDte, maxDte, maxCost }) {
  const d0 = Math.abs(Number(targetDelta)) || 0.5;
  const ok = (candidates || [])
    .map((c) => ({ ...c, spreadPct: spreadPct(c.bid, c.ask), absDelta: Math.abs(Number(c.delta)) || 0 }))
    .filter((c) => c.spreadPct != null && c.spreadPct < currentSpreadPct && c.spreadPct <= SWITCH_SPREAD_PCT
      && Math.abs(c.absDelta - d0) <= SWITCH_DELTA_BAND && c.dte >= minDte && c.dte <= maxDte
      && (!(maxCost > 0) || ((c.bid + c.ask) / 2) * 100 <= maxCost));
  ok.sort((a, b) => a.spreadPct - b.spreadPct || Math.abs(a.absDelta - d0) - Math.abs(b.absDelta - d0) || a.dte - b.dte);
  return ok[0] || null;
}

/* The I/O around pickLiquid: reads up to 4 expirations in the window.
   ideaExpiration: the idea's expiry; minDte: never shorter than this. */
export async function liquidAlternative(symbol, type, { targetDelta, currentSpreadPct, ideaExpiration, minDte = 1, accountSize }) {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dte = (e) => Math.round((Date.parse(e + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
    const ideaDte = ideaExpiration ? dte(ideaExpiration) : minDte;
    const lo = Math.max(minDte, ideaDte - 3), hi = Math.max(lo, ideaDte) + SWITCH_MAX_EXTRA_DAYS;
    const ex = await tradier(`/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true`, { timeoutMs: 8000 });
    const exps = asArray(ex?.expirations?.date).filter((e) => dte(e) >= lo && dte(e) <= hi)
      .sort((a, b) => Math.abs(dte(a) - ideaDte) - Math.abs(dte(b) - ideaDte)).slice(0, 4);
    const cands = [];
    for (const exp of exps) {
      const cd = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(exp)}&greeks=true`, { timeoutMs: 9000 });
      for (const o of asArray(cd?.options?.option)) {
        if (o.option_type !== type || !(Number(o.bid) > 0) || !(Number(o.ask) > 0)) continue;
        cands.push({ occ: o.symbol, strike: Number(o.strike), expiration: exp, dte: dte(exp), bid: Number(o.bid), ask: Number(o.ask), delta: o.greeks?.delta != null ? Number(o.greeks.delta) : null });
      }
    }
    return pickLiquid(cands, { targetDelta, currentSpreadPct, minDte: lo, maxDte: hi, maxCost: accountSize * OPTION_HARD_PCT });
  } catch { return null; }
}
