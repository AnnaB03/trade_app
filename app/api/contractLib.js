/* A short-dated option contract for a same-day idea that names no contract:
   the latest expiry inside [dteMin, dteMax] that has a contract with delta in
   0.35-0.75, a spread under 10% of the mid and one contract under the 15%
   position cap, nearest the target delta. Used by the fade playbook and the
   news playbook (newsIdeasLib.js). Null when nothing fits. Moved here from
   the autotrade route on 2026-10-14 so both can share it. */
import { tradier, asArray } from "./tradier.js";
import { OPTION_HARD_PCT } from "./sizingLib.js";

export async function shortDatedContract(symbol, type, { accountSize, dteMin = 1, dteMax = 4, targetDelta = 0.6 } = {}) {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dte = (e) => Math.round((Date.parse(e + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
    const ex = await tradier(`/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true`, { timeoutMs: 8000 });
    // Later first: the same move costs less decay a few days out.
    const exps = asArray(ex?.expirations?.date).filter((e) => dte(e) >= dteMin && dte(e) <= dteMax).sort().reverse();
    for (const exp of exps) {
      const cd = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(exp)}&greeks=true`, { timeoutMs: 9000 });
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
