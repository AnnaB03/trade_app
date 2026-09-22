/* ---------- Opening drive (9:30-10:00 ET) ----------
   The one signal that survived two rounds of analysis (docs/opening-drive-plan.md):
   neither yesterday's move nor another stock's move predicts today's open or
   gap, but a symbol's own first half hour modestly predicts the rest of its
   session (pooled correlation ~0.25 across NVDA/AAPL/TSLA, 228 sessions).

   This computes that read from Tradier 5-minute timesales — the same
   endpoint app/api/extended.js and app/api/moversLib.js already use — and
   compares it to the symbol's own recent typical first-30-minute size
   (app/api/driveHistoryStore.js), not a one-size-fits-all threshold.

   Never throws: any failure (no data, closed market, thrown fetch) resolves
   to state "n/a" so a caller can always safely append the result. */
// Explicit .js extensions here (unlike the rest of this app's extensionless
// relative imports) — Next's bundler resolves either style, but this file is
// also imported directly by app/api/openingDriveLib.test.mjs under plain
// Node, whose ESM loader requires an explicit extension.
import { tradier, asArray, dataMode } from "./tradier.js";
import { classifyDrive } from "../lib/checks.js";
import { driveHistoryFor, recordDrive, medianAbsDrive } from "./driveHistoryStore.js";

const FLAT_DEFAULT_PCT = 0.6; // fallback "typical" first-30 move when a symbol has no history yet
const RESOLVE_CUTOFF_ET_MIN = 10 * 60 + 15; // give the 10:00 print until 10:15 ET before calling it missing

function etDateStr(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // "YYYY-MM-DD"
}
function etMinutesOfDay(d) {
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getHours() * 60 + et.getMinutes() + et.getSeconds() / 60;
}

// Per-symbol-per-session cache. Resolved reads (state not "pending") never
// change again for that date, so they're cached indefinitely; unresolved
// reads get a short TTL so a burst of calls in one refresh doesn't refetch,
// but the next refresh gets a fresh look once more data may exist.
const cache = new Map(); // `${symbol}:${date}` -> { at, result }
const PENDING_TTL = 60 * 1000;

async function fetchBars(symbol, dateStr) {
  const start = encodeURIComponent(`${dateStr} 09:30`);
  const end = encodeURIComponent(`${dateStr} 10:05`);
  const d = await tradier(`/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=5min&start=${start}&end=${end}&session_filter=open`);
  return asArray(d?.series?.data).slice().sort((a, b) => (a.time < b.time ? -1 : 1));
}

// gapPct: optional, from the caller's own (already-fetched) gap-vs-prior-close
// read — e.g. suggestions/route.js's structureBySym. Only used to annotate a
// large-gap session as noisier; never fetched here to avoid a duplicate call.
//
// deps: dependency injection for tests (app/api/openingDriveLib.test.mjs) —
// mirrors how app/lib/checks.js's rvolTimeAdjusted takes `now` as an
// override. Production callers never pass this; every field defaults to the
// real implementation.
export async function openingDrive(symbol, {
  sessionDate, clockState, now = new Date(), gapPct = null,
  deps: {
    fetchBars: fetchBarsImpl = fetchBars,
    dataMode: dataModeImpl = dataMode,
    medianAbsDrive: medianAbsDriveImpl = medianAbsDrive,
    recordDrive: recordDriveImpl = recordDrive,
    cache: cacheImpl = cache,
  } = {},
} = {}) {
  const dateStr = sessionDate || etDateStr(now);
  const key = `${symbol}:${dateStr}`;
  const hit = cacheImpl.get(key);
  if (hit && (hit.result.state !== "pending" || Date.now() - hit.at < PENDING_TTL)) return hit.result;

  let result;
  try {
    const bars = await fetchBarsImpl(symbol, dateStr);
    const isToday = etDateStr(now) === dateStr;
    const minutesToday = isToday ? etMinutesOfDay(now) : null;
    // The 9:30-10:00 window itself hasn't closed yet — always pending, no
    // matter what a partial bar or two might already say. Resolving off an
    // early bar here was the actual bug this case caught: a 9:35 print is
    // not a stand-in for "the move by 10:00", it's a fraction of it.
    const windowOpen = isToday && minutesToday < 10 * 60;
    const openBar = bars[0];
    const at10Bar = bars.filter((b) => b.time < `${dateStr}T10:00:00`).pop();

    if (windowOpen) {
      result = { open: null, at10: null, drivePct: null, typical: null, strength: null, state: "pending", asOf: null, note: null };
    } else if (!openBar || !at10Bar) {
      // Window has closed by the wall clock, but the bar isn't in yet —
      // either the feed just lags (give it until RESOLVE_CUTOFF_ET_MIN) or
      // this symbol genuinely has no intraday timesales (e.g. an index).
      const pastCutoff = !isToday || minutesToday >= RESOLVE_CUTOFF_ET_MIN;
      if (!pastCutoff) {
        result = { open: null, at10: null, drivePct: null, typical: null, strength: null, state: "pending",
          asOf: null, note: dataModeImpl() === "delayed" ? "sandbox data ~15min delayed" : null };
      } else {
        result = { open: null, at10: null, drivePct: null, typical: null, strength: null, state: "n/a",
          asOf: null, note: "no intraday data for this symbol" };
      }
    } else {
      const open = Number(openBar.open ?? openBar.price);
      const at10 = Number(at10Bar.close ?? at10Bar.price);
      const drivePct = open > 0 ? ((at10 - open) / open) * 100 : null;
      const typical = medianAbsDriveImpl(symbol) ?? FLAT_DEFAULT_PCT;
      const { strength, state } = classifyDrive(drivePct, typical);
      const notes = [];
      if (gapPct != null && Math.abs(gapPct) > 1.5) notes.push("post-gap; drive is noisier");
      result = { open, at10, drivePct, typical, strength, state, asOf: at10Bar.time, note: notes.join("; ") || null };
      if (isToday && drivePct != null) recordDriveImpl(symbol, dateStr, drivePct);
    }
  } catch (e) {
    result = { open: null, at10: null, drivePct: null, typical: null, strength: null, state: "n/a", asOf: null, note: null };
  }
  cacheImpl.set(key, { at: Date.now(), result });
  return result;
}

// One short phrase for a prompt or a banner. null when there's nothing worth
// saying (n/a — closed market, no data, or a thrown fetch).
export function openingDriveText(d) {
  if (!d || d.state === "n/a") return null;
  if (d.state === "pending") return `opening drive pending until 10:00 ET${d.note ? ` (${d.note})` : ""}`;
  const sign = d.drivePct >= 0 ? "+" : "";
  const strengthTxt = d.strength != null ? `, ${d.strength.toFixed(1)}× its usual` : "";
  return `opening drive ${sign}${d.drivePct.toFixed(1)}% by 10:00 (${d.state}${strengthTxt})${d.note ? `; ${d.note}` : ""}`;
}

// Exposed for the Phase 0 backtest and for tests — how many prior sessions'
// drives this symbol has on file right now.
export function driveHistoryDepth(symbol) {
  return driveHistoryFor(symbol).length;
}
