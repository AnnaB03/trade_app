/* ---------- Pure math for the intraday Index Scalper panel ----------
   Everything here is deterministic — no LLM in this loop, on purpose: a
   2-5 minute SPY/SPX scalp needs an answer in seconds, not a ~60s Claude
   call, and the inputs (VWAP, EMA, opening range, regime state) are exact
   arithmetic, not judgment calls. The model's job (in the main Ideas
   engine) is framing catalysts in plain English; this is the clock. */

// Volume-weighted average price, running series — one value per bar, using
// the standard typical-price proxy (H+L+C)/3 since Tradier bars don't carry
// a true VWAP field. Returns { vwap: number[], upper2: number[], lower2: number[] }
// (±2 stdev bands of price around VWAP, volume-weighted) aligned to bars[].
export function vwapSeries(bars) {
  let cumPV = 0, cumV = 0, cumPV2 = 0;
  const vwap = [], upper2 = [], lower2 = [];
  for (const b of bars) {
    const tp = (Number(b.high) + Number(b.low) + Number(b.close)) / 3;
    const v = Number(b.volume) || 0;
    cumPV += tp * v; cumV += v; cumPV2 += tp * tp * v;
    const w = cumV > 0 ? cumPV / cumV : tp;
    const variance = cumV > 0 ? Math.max(0, cumPV2 / cumV - w * w) : 0;
    const sd = Math.sqrt(variance);
    vwap.push(w); upper2.push(w + 2 * sd); lower2.push(w - 2 * sd);
  }
  return { vwap, upper2, lower2 };
}

// Exponential moving average over closes, standard smoothing 2/(n+1).
// First `n` values seeded with a simple average so the series has no NaNs.
export function emaSeries(closes, n) {
  if (closes.length < n) return closes.map(() => null);
  const k = 2 / (n + 1);
  const out = new Array(closes.length).fill(null);
  const seed = closes.slice(0, n).reduce((s, v) => s + v, 0) / n;
  out[n - 1] = seed;
  for (let i = n; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

// Opening range from the first `minutes` of 1-min bars (session must already
// be sliced to regular hours starting 9:30 ET).
export function openingRange(bars, minutes = 15) {
  const orBars = bars.slice(0, minutes);
  if (!orBars.length) return null;
  return {
    high: Math.max(...orBars.map((b) => Number(b.high))),
    low: Math.min(...orBars.map((b) => Number(b.low))),
    barsUsed: orBars.length,
  };
}

// Count how many times the close crosses from one side of VWAP to the
// other — the single best cheap proxy for "is this a trend day or chop."
export function vwapFlipCount(closes, vwap) {
  let flips = 0, prevAbove = null;
  for (let i = 0; i < closes.length; i++) {
    if (vwap[i] == null) continue;
    const above = closes[i] > vwap[i];
    if (prevAbove != null && above !== prevAbove) flips++;
    prevAbove = above;
  }
  return flips;
}

// The regime state machine described in the audit: classify by ~9:50 ET
// (bar ~20 of the session) using the opening range and VWAP-flip behavior
// since, then keep re-evaluating live all day the same way.
export function classifyRegime({ bars, closes, vwap, or }) {
  if (!bars.length || !or) return { state: "UNKNOWN", detail: "not enough bars yet" };
  const last = closes[closes.length - 1];
  const flips = vwapFlipCount(closes, vwap);
  const brokeUp = last > or.high;
  const brokeDown = last < or.low;
  const aboveVwap = vwap[vwap.length - 1] != null && last > vwap[vwap.length - 1];
  const belowVwap = vwap[vwap.length - 1] != null && last < vwap[vwap.length - 1];

  // On 1-min bars, most of the day's VWAP crossings happen in the first
  // 15-20 minutes before enough volume has accumulated to stabilize it —
  // confirmed against the audit's 5-min-bar read of 2026-09-21 (0 flips)
  // vs this same day on 1-min bars (2, both in the opening range). Flip
  // count alone would call that day "MIXED"; thresholds widened so a real
  // trend day with a noisy open still classifies as TREND.
  if (flips >= 5) return { state: "CHOP", detail: `${flips} VWAP flips — no clean side, fade the range edges or sit out`, flips };
  if (brokeUp && aboveVwap && flips <= 2) return { state: "TREND UP", detail: `opening range broke up (${or.low.toFixed(2)}-${or.high.toFixed(2)}) and held above VWAP, ${flips} flip${flips === 1 ? "" : "s"}`, flips };
  if (brokeDown && belowVwap && flips <= 2) return { state: "TREND DOWN", detail: `opening range broke down (${or.low.toFixed(2)}-${or.high.toFixed(2)}) and held below VWAP, ${flips} flip${flips === 1 ? "" : "s"}`, flips };
  return { state: "MIXED", detail: `${flips} VWAP flip${flips === 1 ? "" : "s"}, no clean OR break-and-hold yet`, flips };
}

// Pullback-to-EMA entry state for a TREND UP/DOWN regime: is price currently
// pulled back toward the 9-EMA (a live entry zone) or extended away from it?
export function pullbackState(closes, ema9, dir) {
  const last = closes[closes.length - 1];
  const e = ema9[ema9.length - 1];
  if (e == null) return { state: "UNKNOWN" };
  const distPct = ((last - e) / e) * 100;
  if (dir === "up") {
    if (last < e) return { state: "BELOW_EMA", distPct, detail: "price below 9-EMA — trend may be breaking, not a long entry" };
    if (distPct <= 0.05) return { state: "AT_EMA", distPct, detail: "sitting right at the 9-EMA — the entry zone" };
    if (distPct <= 0.25) return { state: "NEAR_EMA", distPct, detail: "close to the 9-EMA — watch for a reclaim" };
    return { state: "EXTENDED", distPct, detail: `${distPct.toFixed(2)}% above the 9-EMA — chasing here pays for the move already made` };
  }
  if (dir === "down") {
    if (last > e) return { state: "ABOVE_EMA", distPct, detail: "price above 9-EMA — trend may be breaking, not a short entry" };
    if (distPct >= -0.05) return { state: "AT_EMA", distPct, detail: "sitting right at the 9-EMA — the entry zone" };
    if (distPct >= -0.25) return { state: "NEAR_EMA", distPct, detail: "close to the 9-EMA — watch for a rejection" };
    return { state: "EXTENDED", distPct, detail: `${Math.abs(distPct).toFixed(2)}% below the 9-EMA — chasing here pays for the move already made` };
  }
  return { state: "UNKNOWN" };
}

// Does a leader (QQQ/NVDA) agree with SPY's own direction over the last N
// bars? Confirmation, not causation — SPY leading a move alone is weaker
// than SPY + QQQ + NVDA all making the same higher-low / lower-high.
export function leaderAgrees(leaderCloses, lookback, dir) {
  if (leaderCloses.length < lookback + 1) return null;
  const now = leaderCloses[leaderCloses.length - 1];
  const then = leaderCloses[leaderCloses.length - 1 - lookback];
  const chg = ((now - then) / then) * 100;
  const agrees = dir === "up" ? chg > 0 : dir === "down" ? chg < 0 : null;
  return { chg, agrees };
}

// Real dollar cost of holding an ATM long option for `minutes` — the
// spread paid crossing the market plus theta decay for that slice of the
// day. This is the number that has to be beaten before a scalp is even a
// breakeven idea, independent of being right.
export function holdCostEstimate({ bid, ask, theta, minutes = 5, sessionMinutes = 390 }) {
  if (!(bid > 0) || !(ask > 0)) return null;
  const mid = (bid + ask) / 2;
  const spreadCost = (ask - bid) * 100; // round-trip: buy ask, sell bid, per contract
  const thetaCost = theta != null ? Math.abs(theta) * 100 * (minutes / sessionMinutes) : null;
  const total = spreadCost + (thetaCost || 0);
  return { mid, spreadCost, thetaCost, total, totalPctOfMid: mid > 0 ? (total / (mid * 100)) * 100 : null };
}

// Strikes within `pctBand` of spot, ranked by open interest — the intraday
// "pin" a 0DTE/short-dated chain tends to gravitate toward, as opposed to
// oiWalls() in metrics.js which scans the WHOLE chain and often surfaces a
// far-OTM strike no one actually trades intraday.
export function nearSpotPin(rows, spot, pctBand = 0.015) {
  if (!spot || !rows?.length) return null;
  const band = rows.filter((r) => Math.abs(r.strike - spot) / spot <= pctBand);
  if (!band.length) return null;
  const callWall = band.reduce((b, r) => (Number(r.call?.oi) || 0) > (Number(b?.call?.oi) || 0) ? r : b, null);
  const putWall = band.reduce((b, r) => (Number(r.put?.oi) || 0) > (Number(b?.put?.oi) || 0) ? r : b, null);
  return {
    callWall: callWall?.call?.oi ? { strike: callWall.strike, oi: Number(callWall.call.oi) } : null,
    putWall: putWall?.put?.oi ? { strike: putWall.strike, oi: Number(putWall.put.oi) } : null,
  };
}
