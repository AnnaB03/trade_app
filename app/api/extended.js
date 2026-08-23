/* Extended-hours (pre/post-market) prices via Tradier timesales with
   session_filter=all — FMP's aftermarket endpoints need a higher plan, but the
   production Tradier token already includes extended-session trades.
   Shared by /api/overnight and the closed-market suggestions prompt. */
import { tradier, asArray } from "./tradier";

const pad = (n) => String(n).padStart(2, "0");
// Tradier timesales wants "YYYY-MM-DD HH:MM" in US/Eastern
const easternStamp = (msAgo) => {
  const d = new Date(new Date(Date.now() - msAgo).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// One symbol: last extended-session trade vs the regular-session close.
// Returns nulls (never throws) when the symbol has no extended trading (e.g. SPX).
async function extOne(sym) {
  try {
    const qd = await tradier(`/markets/quotes?symbols=${encodeURIComponent(sym)}`);
    const q = asArray(qd?.quotes?.quote)[0] || {};
    const ref = q.close ?? q.prevclose ?? q.last ?? null;
    let ext = null, asOf = null;
    try {
      const start = encodeURIComponent(easternStamp(18 * 3600 * 1000));
      const ts = await tradier(`/markets/timesales?symbol=${encodeURIComponent(sym)}&interval=15min&start=${start}&session_filter=all`);
      const bars = asArray(ts?.series?.data);
      const lastBar = bars[bars.length - 1];
      if (lastBar) { ext = lastBar.close ?? lastBar.price ?? null; asOf = lastBar.time ?? null; }
    } catch {}
    const extChangePct = ext != null && ref > 0 ? ((ext - ref) / ref) * 100 : null;
    return { symbol: sym, ref, ext, asOf, extChangePct };
  } catch {
    return { symbol: sym, ref: null, ext: null, asOf: null, extChangePct: null };
  }
}

export async function extendedQuotes(syms) {
  return Promise.all(syms.slice(0, 10).map(extOne));
}
