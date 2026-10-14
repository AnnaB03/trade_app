/* How far each stock normally moves AGAINST a position, from its own history.

   Added 2026-10-14 at the user's suggestion: "not all contracts work the same
   way... learning how the contracts we usually buy/sell work intraday". A flat
   10% option stop was inside ordinary noise for some names and loose for
   others. Measured over 15 sessions of 1-minute bars, the move against a
   position within 30 minutes of a 10:00-14:30 entry:

     SPY  p80 0.15%  p90 ~0.21%  p95 0.27%      QQQ  p80 0.21%  p95 0.38%
     NVDA / GOOGL / TSLA  p80 ~0.36%  p95 ~0.6%
     HOOD / ORCL / INTC / MU  p80 ~0.64%  p95 ~1.2%

   That morning's QQQ 10/19 $736 put dipped 13.9% six minutes after entry and
   finished the day +17%: an 80th-percentile QQQ move is a 14% move in that
   option, so a 10% stop sold a correct trade at the bottom of an ordinary dip.

   The stop for an option is therefore the option-price equivalent of the
   stock's p90 adverse move: delta x (p90% x stock price) / premium, between a
   floor and a cap. Wider stops mean fewer contracts for the same 1% of the
   account, so the dollar loss stays the same — only its likelihood changes.
   The option's own extra noise (gamma, the spread) is not in the stock's move;
   the floor covers the quiet cases, and the record will show if it is enough. */
import { tradier } from "./tradier.js";
import { kvGet, kvSet } from "./store.js";

export const SWING_KEY = "swing_profile";
export const SWING_WINDOW_MIN = 30;
export const SWING_DAYS = 15;
export const STOP_PCTILE = "p90";
export const STOP_FLOOR_PCT = 20; // 8 -> 20 on 2026-10-14; see exitRules.HARD_LOSS_PCT for the replay
export const STOP_CAP_PCT = 35;
const MAX_AGE_MS = 20 * 3600000;

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const pctile = (sorted, k) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * k))] : null);

/* Pure: 1-minute bars (one or more sessions) -> the adverse-move profile.
   Entries are sampled every 5 minutes from 10:00 to 14:30 ET; for each, the
   largest move up and down over the next `win` bars of the same session. */
export function profileFromBars(bars, { win = SWING_WINDOW_MIN } = {}) {
  const bySession = new Map();
  for (const b of bars) {
    const t = String(b.time || "");
    const day = t.slice(0, 10), hm = t.slice(11, 16);
    if (hm < "10:00" || hm > "15:00") continue;
    if (!bySession.has(day)) bySession.set(day, []);
    bySession.get(day).push(b);
  }
  const ups = [], downs = [];
  for (const rows of bySession.values()) {
    for (let i = 0; i + win < rows.length; i += 5) {
      if (String(rows[i].time).slice(11, 16) > "14:30") break;
      const p = Number(rows[i].close);
      if (!(p > 0)) continue;
      const w = rows.slice(i + 1, i + 1 + win);
      ups.push(((Math.max(...w.map((x) => Number(x.high))) - p) / p) * 100);
      downs.push(((p - Math.min(...w.map((x) => Number(x.low)))) / p) * 100);
    }
  }
  ups.sort((a, b) => a - b); downs.sort((a, b) => a - b);
  const side = (a) => ({ p50: pctile(a, 0.5), p80: pctile(a, 0.8), p90: pctile(a, 0.9), p95: pctile(a, 0.95) });
  return { n: ups.length, sessions: bySession.size, up: side(ups), down: side(downs) };
}

/* Pure: the stop for one option, as a percent of its premium.
   A PUT loses when the stock goes UP, a CALL when it goes DOWN. */
export function optionStopPct({ optionType, profile, price, delta, premium, which = STOP_PCTILE, floor = STOP_FLOOR_PCT, cap = STOP_CAP_PCT }) {
  const side = optionType === "put" ? profile?.up : profile?.down;
  const movePct = side?.[which];
  const d = Math.abs(Number(delta)), S = Number(price), P = Number(premium);
  if (!(movePct > 0) || !(d > 0) || !(S > 0) || !(P > 0)) return null;
  const raw = (d * (movePct / 100) * S / P) * 100;
  return Math.round(Math.max(floor, Math.min(cap, raw)) * 10) / 10;
}

export function readSwingProfile() {
  return kvGet(SWING_KEY);
}

export function profileFor(symbol, stored = readSwingProfile()) {
  return stored?.symbols?.[String(symbol).toUpperCase()] ?? null;
}

// Fetch 1-minute bars for the last SWING_DAYS sessions and store the profiles.
export async function refreshSwingProfile(symbols, { force = false, now = new Date() } = {}) {
  const cur = readSwingProfile();
  if (!force && cur?.asOf && now - new Date(cur.asOf) < MAX_AGE_MS) return cur;
  const start = new Date(now.getTime() - (SWING_DAYS + 8) * 86400000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const out = { asOf: now.toISOString(), windowMin: SWING_WINDOW_MIN, days: SWING_DAYS, symbols: { ...(cur?.symbols || {}) } };
  for (const s of symbols) {
    try {
      const d = await tradier(`/markets/timesales?symbol=${encodeURIComponent(s)}&interval=1min&start=${start}%2009:30&end=${end}%2016:00&session_filter=open`, { timeoutMs: 20000 });
      let bars = asArray(d?.series?.data);
      // Keep the last SWING_DAYS sessions only.
      const days = [...new Set(bars.map((b) => String(b.time).slice(0, 10)))].sort().slice(-SWING_DAYS);
      bars = bars.filter((b) => days.includes(String(b.time).slice(0, 10)));
      const p = profileFromBars(bars);
      if (p.n >= 100) out.symbols[s.toUpperCase()] = { ...p, asOf: out.asOf };
    } catch {}
  }
  kvSet(SWING_KEY, out);
  return out;
}
