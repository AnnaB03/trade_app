import { NextResponse } from "next/server";
import { fmpGet } from "../fmp";

/* Auto event risk: the next earnings date for the symbol (FMP) plus high-impact
   US macro releases (CPI, FOMC, NFP, ISM…) in the next 45 days. These feed the
   same hold-through-event warning as manually entered events.
   Degrades to { available:false } without FMP_API_KEY. */

const TTL = 6 * 3600 * 1000;
const cache = new Map(); // key → { at, data }
const getCached = (k) => {
  const c = cache.get(k);
  return c && Date.now() - c.at < TTL ? c.data : null;
};
const iso = (d) => d.toISOString().slice(0, 10);

async function upcomingEarnings(symbol) {
  const k = `earn:${symbol}`;
  const hit = getCached(k);
  if (hit) return hit;
  const rows = await fmpGet("earnings", { symbol, limit: 8 });
  const today = iso(new Date());
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

async function macroEvents() {
  const hit = getCached("macro");
  if (hit) return hit;
  const from = new Date(), to = new Date(Date.now() + 45 * 86400000);
  const rows = await fmpGet("economic-calendar", { from: iso(from), to: iso(to) });
  const seen = new Set();
  const out = (Array.isArray(rows) ? rows : [])
    .filter((e) => e?.country === "US" && e?.impact === "High" && e?.date)
    .map((e) => ({ label: e.event, date: e.date.slice(0, 10), kind: "macro" }))
    .filter((e) => (seen.has(e.label + e.date) ? false : (seen.add(e.label + e.date), true)))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, 12);
  cache.set("macro", { at: Date.now(), data: out });
  return out;
}

export async function GET(req) {
  const symbol = new URL(req.url).searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!process.env.FMP_API_KEY) {
    return NextResponse.json({ available: false, reason: "FMP_API_KEY not set", events: [] });
  }
  try {
    const [earn, macro] = await Promise.all([upcomingEarnings(symbol.toUpperCase()), macroEvents()]);
    return NextResponse.json({ available: true, events: [...earn, ...macro].sort((a, b) => (a.date < b.date ? -1 : 1)) });
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e.message || e), events: [] });
  }
}
