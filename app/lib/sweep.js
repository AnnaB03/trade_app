/* ---------- Liquidity-sweep (stop-hunt) detector ----------
   Pure functions — no network — shared by the /api/sweeps routes and
   runnable offline against any list of daily bars ({date, open, high, low,
   close, volume}), oldest first.

   The idea being tested: retail stops cluster just under obvious swing
   lows. Price often trades through that level briefly (the "sweep"), fills
   those stops, then snaps back. Two ways to trade it, deliberately kept
   separate so the app can measure which one (if either) actually works:

   1. LIMIT ("buy where the stops are") — the naive version from the video.
      A resting buy limit just under an unswept swing low, stop well below.
      Its known weakness is adverse selection: a quick wick may barely fill
      it, a real breakdown fills it in full. The backtest and the fill
      tracking exist to put a number on that.
   2. RECLAIM ("wait for the snap-back") — price trades below the level,
      then closes back above it. Enter on the reclaim, stop just under the
      sweep low. Gives up the perfect fill to skip most real breakdowns.

   A "level" is an UNSWEPT swing low: a bar whose low is below the K bars
   on each side of it, that no later bar has traded under yet. Levels with
   several near-equal lows ("equal lows") are where stops pile up most. */

// Default watch list for the Sweeps tab. Uber by request; the rest from
// running backtest() over ~15 liquid names and keeping the ones where at
// least one variant had positive expectancy AND one share fits a $1k
// account's 25% position cap (SPY, MU, AMD tested fine but cost too much a
// share). See README. Editable in the tab.
export const DEFAULT_SWEEP_SYMS = ["UBER", "LYFT", "SOFI", "PLTR", "NVDA", "INTC", "BAC", "HOOD"];

export const K = 3;                  // swing pivot half-width, in bars
export const LOOKBACK = 60;          // how far back a level can come from
export const LIMIT_BELOW_ATR = 0.1;  // limit sits this far under the level
export const LIMIT_STOP_ATR = 1.0;   // naive stop: this far under the level
export const MAX_SWEEP_ATR = 1.0;    // deeper than this = breakdown, not a sweep
export const RECLAIM_STOP_BUF_ATR = 0.1; // reclaim stop: this far under the sweep low
export const MIN_STOP_ATR = 0.3;     // ...but never closer than this to the entry (a shallow sweep would otherwise leave a noise-level stop)

const reclaimStop = (entry, sweepLow, a) => Math.min(sweepLow - RECLAIM_STOP_BUF_ATR * a, entry - MIN_STOP_ATR * a);
export const NEAR_ATR = 1.5;         // a limit is only worth resting if the level is this close
export const MAX_HOLD = 10;          // backtest: bars before a time exit
export const EQUAL_LOW_ATR = 0.25;   // lows within this many ATR count as "equal"

const n2 = (v) => Math.round(v * 100) / 100;

export function atr(bars, n = 14, end = bars.length) {
  if (end < n + 1) return null;
  let sum = 0;
  for (let i = end - n; i < end; i++) {
    const b = bars[i], prev = bars[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  }
  return sum / n;
}

export function sma(bars, n, end = bars.length) {
  if (end < n) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) s += bars[i].close;
  return s / n;
}

// "uptrend" | "downtrend" | "mixed", judged on bars[0..end-1]
export function trendAt(bars, end = bars.length) {
  const s20 = sma(bars, 20, end), s50 = sma(bars, 50, end);
  const last = bars[end - 1]?.close;
  if (s20 == null || s50 == null || last == null) return "unknown";
  if (last > s50 && s20 > s50) return "uptrend";
  if (last < s50 && s20 < s50) return "downtrend";
  return "mixed";
}

/* Unswept swing lows as of bars[0..end-1], nearest (highest) first.
   A pivot needs K confirming bars after it, so the newest possible pivot is
   at end-1-K. `touches` counts other swing lows within EQUAL_LOW_ATR of it. */
export function liquidityLevels(bars, end = bars.length, a = atr(bars, 14, end)) {
  if (!a) return [];
  const pivots = [];
  for (let i = Math.max(K, end - LOOKBACK); i <= end - 1 - K; i++) {
    let isLow = true;
    for (let j = 1; j <= K && isLow; j++) {
      if (!(bars[i].low < bars[i - j].low && bars[i].low <= bars[i + j].low)) isLow = false;
    }
    if (isLow) pivots.push(i);
  }
  const levels = [];
  for (const i of pivots) {
    let swept = false;
    for (let t = i + 1; t < end; t++) if (bars[t].low < bars[i].low) { swept = true; break; }
    if (swept) continue;
    const touches = pivots.filter((p) => p !== i && Math.abs(bars[p].low - bars[i].low) <= EQUAL_LOW_ATR * a).length;
    levels.push({ price: bars[i].low, index: i, date: bars[i].date, touches });
  }
  return levels.sort((x, y) => y.price - x.price);
}

// Nearest swing high above `price` in the last LOOKBACK bars, else the
// highest high in that window — where a reclaimed move plausibly runs to.
export function targetAbove(bars, price, end = bars.length) {
  let best = null, hi = -Infinity;
  for (let i = Math.max(K, end - LOOKBACK); i < end; i++) {
    hi = Math.max(hi, bars[i].high);
    if (i > end - 1 - K) continue;
    let isHigh = true;
    for (let j = 1; j <= K && isHigh; j++) {
      if (!(bars[i].high > bars[i - j].high && bars[i].high >= bars[i + j].high)) isHigh = false;
    }
    if (isHigh && bars[i].high > price && (best == null || bars[i].high < best)) best = bars[i].high;
  }
  if (best != null) return best;
  return hi > price ? hi : null;
}

// The level a sweep of bar `t` would be sweeping: the highest unswept level
// (as of t-1) that bar t traded under, if the sweep isn't too deep.
function sweptLevel(levels, bar, a) {
  for (const L of levels) {
    if (bar.low < L.price) {
      return (L.price - bar.low) <= MAX_SWEEP_ATR * a ? L : null;
    }
  }
  return null;
}

/* ---------- Live setups ---------- */

/* LIMIT setup off completed daily bars + the live price. Returns null when
   there's no unswept level close enough below price to be worth resting an
   order at today, or the trend isn't up (the video's setup is a dip inside
   an uptrend — in a downtrend a swept low is just the next leg down). */
export function limitSetup(bars, livePrice) {
  const a = atr(bars);
  if (!a || !(livePrice > 0)) return null;
  const trend = trendAt(bars);
  const levels = liquidityLevels(bars, bars.length, a);
  const L = levels.find((l) => l.price < livePrice);
  if (!L) return null;
  const dist = (livePrice - L.price) / a;
  if (dist > NEAR_ATR || dist < LIMIT_BELOW_ATR) return null;
  const entry = n2(L.price - LIMIT_BELOW_ATR * a);
  const stop = n2(L.price - LIMIT_STOP_ATR * a);
  const target = targetAbove(bars, livePrice);
  if (target == null) return null;
  return {
    variant: "limit", level: n2(L.price), levelDate: L.date, touches: L.touches, atr: n2(a), trend,
    entry, stop, target: n2(target), rr: (target - entry) / (entry - stop), distanceAtr: dist,
    ok: trend === "uptrend",
    why: `Unswept swing low $${L.price.toFixed(2)} (${L.date}${L.touches ? `, ${L.touches + 1} equal lows` : ""}) sits ${dist.toFixed(1)} ATR under price — resting a buy limit just under it at $${entry.toFixed(2)}, where the stops below that low would trigger.`,
  };
}

/* RECLAIM setup on the DAILY chart: the last completed bar traded under an
   unswept level and closed back above it, and price is still above it now. */
export function dailyReclaimSetup(bars, livePrice) {
  const end = bars.length;
  if (end < 60) return null;
  const a = atr(bars, 14, end - 1);
  if (!a) return null;
  const levels = liquidityLevels(bars, end - 1, a);
  const bar = bars[end - 1];
  const L = sweptLevel(levels, bar, a);
  if (!L || !(bar.close > L.price)) return null;
  const px = livePrice > 0 ? livePrice : bar.close;
  if (!(px > L.price)) return null;
  const stop = n2(reclaimStop(px, bar.low, a));
  const target = targetAbove(bars, px);
  if (target == null) return null;
  const trend = trendAt(bars, end - 1);
  return {
    variant: "reclaim", timeframe: "daily", level: n2(L.price), levelDate: L.date, touches: L.touches, atr: n2(a), trend,
    sweepLow: bar.low, sweepDepthAtr: (L.price - bar.low) / a, sweepDate: bar.date,
    entry: n2(px), stop, target: n2(target), rr: (target - px) / (px - stop),
    ok: trend !== "downtrend" && (px - L.price) <= 0.75 * a,
    why: `${bar.date} traded to $${bar.low.toFixed(2)}, under the $${L.price.toFixed(2)} swing low (${L.date}), and closed back above it at $${bar.close.toFixed(2)} — a swept-and-reclaimed level. Stop just under the sweep low.`,
  };
}

/* RECLAIM setup INTRADAY: today's 5-min bars swept a daily level and the
   latest 5-min close is back above it, with the first reclaim recent enough
   (within `freshBars` bars) that we're not chasing an old move. */
export function intradayReclaimSetup(bars, intraday, { freshBars = 6 } = {}) {
  if (!intraday?.length || bars.length < 60) return null;
  const a = atr(bars);
  if (!a) return null;
  const levels = liquidityLevels(bars, bars.length, a);
  let lowIdx = 0;
  for (let i = 1; i < intraday.length; i++) if (intraday[i].low < intraday[lowIdx].low) lowIdx = i;
  const lowBar = intraday[lowIdx];
  const L = sweptLevel(levels, lowBar, a);
  if (!L) return null;
  const reclaimIdx = intraday.findIndex((b, i) => i >= lowIdx && b.close > L.price);
  const last = intraday[intraday.length - 1];
  if (reclaimIdx === -1 || !(last.close > L.price)) return null;
  if (intraday.length - 1 - reclaimIdx > freshBars) return null;
  const px = last.close;
  const avgVol = intraday.reduce((s, b) => s + (Number(b.volume) || 0), 0) / intraday.length;
  const sweepVolRatio = avgVol > 0 ? (Number(lowBar.volume) || 0) / avgVol : null;
  const stop = n2(reclaimStop(px, lowBar.low, a));
  const target = targetAbove(bars, px);
  if (target == null) return null;
  const trend = trendAt(bars);
  return {
    variant: "reclaim", timeframe: "intraday", level: n2(L.price), levelDate: L.date, touches: L.touches, atr: n2(a), trend,
    sweepLow: lowBar.low, sweepDepthAtr: (L.price - lowBar.low) / a, sweepTime: lowBar.time ?? null, sweepVolRatio,
    entry: n2(px), stop, target: n2(target), rr: (target - px) / (px - stop),
    ok: trend !== "downtrend" && (px - L.price) <= 0.6 * a,
    why: `Traded to $${lowBar.low.toFixed(2)} intraday, under the $${L.price.toFixed(2)} swing low (${L.date}), then closed a 5-min bar back above it${sweepVolRatio != null ? ` (sweep bar ${sweepVolRatio.toFixed(1)}× avg volume)` : ""}. Stop just under the sweep low.`,
  };
}

/* ---------- Backtest on daily bars ----------
   Walks forward one bar at a time using only what was known before that
   bar. Conservative on ambiguity: if a bar touches both stop and target, it
   counts as the stop; the fill bar itself can stop out but not hit target.
   One trade at a time per variant. Outcomes in R (risk = entry - stop). */
function simulate(bars, from, entry, stop, target) {
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  // fill bar: stop can already be hit (the adverse-selection case)
  if (bars[from].low <= stop) return { r: (stop - entry) / risk, exit: "stop", bars: 0, endIdx: from };
  for (let t = from + 1; t < Math.min(bars.length, from + 1 + MAX_HOLD); t++) {
    const b = bars[t];
    if (b.open <= stop) return { r: (b.open - entry) / risk, exit: "stop", bars: t - from, endIdx: t }; // gapped through
    if (b.low <= stop) return { r: (stop - entry) / risk, exit: "stop", bars: t - from, endIdx: t };
    if (target != null && b.high >= target) return { r: (Math.max(target, b.open) - entry) / risk, exit: "target", bars: t - from, endIdx: t };
  }
  const endIdx = Math.min(bars.length - 1, from + MAX_HOLD);
  if (endIdx === from) return null; // no bars after entry yet — still open
  return { r: (bars[endIdx].close - entry) / risk, exit: "time", bars: endIdx - from, endIdx };
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: null, avgR: null, stopRate: null };
  const wins = trades.filter((t) => t.r > 0).length;
  return {
    n,
    winRate: wins / n,
    avgR: trades.reduce((s, t) => s + t.r, 0) / n,
    stopRate: trades.filter((t) => t.exit === "stop").length / n,
  };
}

export function backtest(bars, { start = 60 } = {}) {
  const limitTrades = [], reclaimTrades = [];
  let sweeps = 0, reclaimed = 0, limitArmed = 0;
  let limitBusyUntil = -1, reclaimBusyUntil = -1;

  for (let t = start; t < bars.length; t++) {
    const a = atr(bars, 14, t);
    if (!a) continue;
    const levels = liquidityLevels(bars, t, a);
    const bar = bars[t], prevClose = bars[t - 1].close;
    const trend = trendAt(bars, t);

    // Sweep census: did this bar trade under an unswept level at all?
    const anyUnder = levels.find((l) => bar.low < l.price && l.price < prevClose);
    if (anyUnder) {
      sweeps++;
      if (bar.close > anyUnder.price) reclaimed++;
    }

    // LIMIT: the order that would have been resting at the open of bar t.
    if (t > limitBusyUntil && trend === "uptrend") {
      const L = levels.find((l) => l.price < prevClose);
      if (L) {
        const dist = (prevClose - L.price) / a;
        const limit = L.price - LIMIT_BELOW_ATR * a;
        const stop = L.price - LIMIT_STOP_ATR * a;
        const target = targetAbove(bars, prevClose, t);
        if (dist <= NEAR_ATR && dist >= LIMIT_BELOW_ATR && target != null) {
          limitArmed++;
          if (bar.low <= limit) {
            const entry = Math.min(bar.open, limit); // gap under the limit fills at the open
            const res = entry > stop ? simulate(bars, t, entry, stop, target) : { r: -1, exit: "stop", bars: 0, endIdx: t };
            if (res) { limitTrades.push({ date: bar.date, entry, stop, target, ...res }); limitBusyUntil = res.endIdx; }
          }
        }
      }
    }

    // RECLAIM: bar t swept a level and closed back above it -> enter at the close.
    if (t > reclaimBusyUntil && trend !== "downtrend") {
      const L = sweptLevel(levels, bar, a);
      if (L && bar.close > L.price && bar.close - L.price <= 0.75 * a) {
        const entry = bar.close, stop = reclaimStop(entry, bar.low, a);
        const target = targetAbove(bars, entry, t + 1);
        const res = simulate(bars, t, entry, stop, target); // stop sits under this bar's low, so it can't hit on the entry bar
        if (res) { reclaimTrades.push({ date: bar.date, entry, stop, target, ...res }); reclaimBusyUntil = res.endIdx; }
      }
    }
  }

  const tested = Math.max(0, bars.length - start);
  const limit = stats(limitTrades), reclaim = stats(reclaimTrades);
  return {
    barsTested: tested,
    from: bars[start]?.date ?? null, to: bars[bars.length - 1]?.date ?? null,
    sweeps, sweepsPer100: tested ? (sweeps / tested) * 100 : null,
    reclaimRate: sweeps ? reclaimed / sweeps : null,
    limit: { ...limit, armedDays: limitArmed, fillRate: limitArmed ? limitTrades.length / limitArmed : null },
    reclaim,
    trades: { limit: limitTrades.slice(-12), reclaim: reclaimTrades.slice(-12) },
  };
}

/* How well a symbol suits this playbook, 0-100, from its own history:
   needs sweeps to actually happen, to reclaim more often than not, and for
   at least one variant to have made money. Small samples are shrunk hard. */
export function fitScore(bt) {
  if (!bt || !bt.barsTested) return null;
  const shrink = (s) => s.n ? (s.avgR * s.n) / (s.n + 5) : 0; // pull small-n averages toward 0
  const best = Math.max(shrink(bt.limit), shrink(bt.reclaim));
  const freq = Math.min(1, (bt.sweepsPer100 ?? 0) / 8);      // ~8 sweeps / 100 bars = plenty
  const rec = bt.reclaimRate ?? 0;
  const score = 40 * freq + 30 * Math.max(0, Math.min(1, (rec - 0.3) / 0.4)) + 30 * Math.max(0, Math.min(1, (best + 0.2) / 0.6));
  return Math.round(score);
}

/* Heuristic conviction (1-5) for a live setup, so it passes through the same
   conviction gate the AI ideas do: starts at 3, moves on this symbol's own
   backtest for that variant, and on equal lows / trend. */
export function setupConviction(setup, bt) {
  let c = 3;
  const s = setup.variant === "limit" ? bt?.limit : bt?.reclaim;
  if (s?.n >= 5) {
    if (s.avgR > 0.2) c++;
    if (s.avgR < 0) c--;
  }
  if (setup.touches >= 1) c++;
  if (!setup.ok) c--;
  if (setup.rr != null && setup.rr < 1) c--;
  return Math.max(1, Math.min(5, c));
}
