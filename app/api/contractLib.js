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
