/* Shared FMP event fetchers: next earnings per symbol + high-impact US macro
   releases. Used by /api/events (event-risk card) and /api/today (morning
   calendar strip). All results cached in-memory 6h to protect the FMP quota.
   FMP economic-calendar datetimes are UTC (e.g. NFP shows 12:30:00 = 8:30am ET);
   we convert to US/Eastern for both the date and the display time. */
import { fmpGet } from "./fmp";

const TTL = 6 * 3600 * 1000;
const cache = new Map(); // key → { at, data }
const getCached = (k) => {
  const c = cache.get(k);
  return c && Date.now() - c.at < TTL ? c.data : null;
};
const iso = (d) => d.toISOString().slice(0, 10);

export const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const utcToET = (utcStr) => {
  const d = new Date(String(utcStr).replace(" ", "T") + "Z");
  if (isNaN(d)) return { dateET: String(utcStr).slice(0, 10), timeET: null };
  return {
    dateET: d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    timeET: d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }),
  };
};

// Next upcoming earnings for one symbol: [{ label, date, kind: "earnings" }] or []
export async function upcomingEarnings(symbol) {
  const k = `earn:${symbol}`;
  const hit = getCached(k);
  if (hit) return hit;
  const rows = await fmpGet("earnings", { symbol, limit: 8 });
  const today = todayET();
  const future = (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.date && r.date >= today)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const next = future[0];
  const out = next
    ? [{ label: `${symbol} earnings${next.epsEstimated != null ? ` (est. EPS ${next.epsEstimated})` : ""}`, date: next.date, kind: "earnings" }]
    : [];
  cache.set(k, { at: Date.now(), data: out });
  return out;
}

// High-impact US macro releases, next 45 days:
// [{ label, date (ET), timeET, kind: "macro" }]
export async function macroEvents() {
  const hit = getCached("macro");
  if (hit) return hit;
  const from = new Date(), to = new Date(Date.now() + 45 * 86400000);
  const rows = await fmpGet("economic-calendar", { from: iso(from), to: iso(to) });
  const seen = new Set();
  const out = (Array.isArray(rows) ? rows : [])
    .filter((e) => e?.country === "US" && e?.impact === "High" && e?.date)
    .map((e) => {
      const { dateET, timeET } = utcToET(e.date);
      return { label: e.event, date: dateET, timeET, kind: "macro" };
    })
    .filter((e) => (seen.has(e.label + e.date) ? false : (seen.add(e.label + e.date), true)))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, 12);
  cache.set("macro", { at: Date.now(), data: out });
  return out;
}
