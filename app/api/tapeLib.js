/* Fetching the intraday tape — the math and the prompt text live in
   app/lib/tape.js (pure, tested); this wraps Tradier's 5-minute timesales
   with a short timeout and a one-minute cache, and answers null when it
   cannot, so a slow feed costs one line of context, never a stalled route. */
import { tradier, asArray } from "./tradier";
import { dailyBars } from "./historyCache";
import { tapeRead } from "../lib/tape";
export { vwap, atr, tapeRead, tapeLine, tapeText, ATR_USED_MAX_PCT } from "../lib/tape";

/* ---------- Fetch, cached for a minute ---------- */
const cache = new Map();
const TTL_MS = 60000;

function etParts(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour") % 24 === g("hour") ? g("hour") : String(Number(g("hour")) % 24).padStart(2, "0")}:${g("minute")}` };
}

export async function fetchTape(symbol, { last = null, timeoutMs = 4000 } = {}) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tape;
  try {
    const { date, time } = etParts();
    const [ts, daily] = await Promise.all([
      tradier(`/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=5min&start=${encodeURIComponent(`${date} 09:30`)}&end=${encodeURIComponent(`${date} ${time}`)}&session_filter=open`, { timeoutMs }),
      dailyBars(symbol, 40),
    ]);
    const bars = asArray(ts?.series?.data);
    const priorDaily = daily.filter((b) => b.date < date);
    const tape = tapeRead({ bars, priorDaily, last });
    cache.set(symbol, { at: Date.now(), tape });
    return tape;
  } catch {
    return null;
  }
}

export async function fetchTapes(symbols, { lastBySym = {} } = {}) {
  const out = {};
  await Promise.all([...new Set(["SPY", ...symbols])].map(async (s) => { out[s] = await fetchTape(s, { last: lastBySym[s] }); }));
  return out;
}
