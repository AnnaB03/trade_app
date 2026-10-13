/* ---------- The intraday tape ----------
   The MARKET REGIME block (regimeLib.js) reads daily closes against 20/50/
   200-day averages. That is the right context for a three-week position and
   no context at all for a trade that opens and closes today. For that, a
   trader looks at three things on the 5-minute chart before anything else:

   - where price is against VWAP: the session's volume-weighted average, the
     line institutions mark themselves against. Above it with SPY above its
     own, longs have the tape; below, shorts do. A fade INTO VWAP is a
     different trade from a continuation AWAY from it.
   - the opening range: the first 30 minutes' high and low. A break out of
     it with volume is the day's first real signal; chop inside it is noise.
   - how much of a normal day's range is already used: today's high-to-low
     against the 14-day average true range. A continuation idea on a name
     that has already travelled 120% of its ATR is buying the end of the
     move — the setup autotrade refuses (ATR_USED_MAX_PCT).

   Pure math here, tested; the fetch wraps Tradier's 5-minute timesales with
   a short timeout and a one-minute cache, and answers null when it cannot,
   so a slow feed costs one line of context, never a stalled route. */
export const ATR_USED_MAX_PCT = Number(process.env.ATR_USED_MAX_PCT) > 0 ? Number(process.env.ATR_USED_MAX_PCT) : 120;
const OPENING_RANGE_BARS = 6; // 6 x 5 min = the first half hour

export function vwap(bars) {
  let pv = 0, vol = 0;
  for (const b of bars) {
    const v = Number(b.volume) || 0, h = Number(b.high), l = Number(b.low), c = Number(b.close);
    if (!(v > 0) || !(h > 0) || !(l > 0) || !(c > 0)) continue;
    pv += ((h + l + c) / 3) * v; vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

// Average true range over the last n COMPLETE days (today excluded by the caller).
export function atr(daily, n = 14) {
  const rows = daily.filter((b) => Number(b.high) > 0 && Number(b.low) > 0 && Number(b.close) > 0);
  if (rows.length < 2) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const h = Number(rows[i].high), l = Number(rows[i].low), pc = Number(rows[i - 1].close);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const w = trs.slice(-n);
  return w.length ? w.reduce((s, v) => s + v, 0) / w.length : null;
}

/* bars: today's 5-minute bars in session order. priorDaily: complete prior
   days (not today). last: the live price. */
export function tapeRead({ bars, priorDaily, last }) {
  const px = Number(last) > 0 ? Number(last) : (bars.length ? Number(bars[bars.length - 1].close) : null);
  const v = vwap(bars);
  const highs = bars.map((b) => Number(b.high)).filter((x) => x > 0), lows = bars.map((b) => Number(b.low)).filter((x) => x > 0);
  const dayHigh = highs.length ? Math.max(...highs) : null, dayLow = lows.length ? Math.min(...lows) : null;
  const or = bars.slice(0, OPENING_RANGE_BARS);
  const orHigh = or.length ? Math.max(...or.map((b) => Number(b.high))) : null, orLow = or.length ? Math.min(...or.map((b) => Number(b.low))) : null;
  const open = bars.length ? Number(bars[0].open) : null;
  const a = atr(priorDaily, 14);
  const range = dayHigh != null && dayLow != null ? dayHigh - dayLow : null;
  return {
    last: px, bars: bars.length,
    vwap: v, vsVwapPct: v > 0 && px > 0 ? ((px - v) / v) * 100 : null, side: v > 0 && px > 0 ? (px >= v ? "above" : "below") : null,
    openingRange: orHigh != null ? { high: orHigh, low: orLow, complete: or.length >= OPENING_RANGE_BARS } : null,
    orPosition: orHigh != null && px > 0 ? (px > orHigh ? "above" : px < orLow ? "below" : "inside") : null,
    dayHigh, dayLow, fromOpenPct: open > 0 && px > 0 ? ((px - open) / open) * 100 : null,
    atr14: a, rangeUsedPct: a > 0 && range != null ? (range / a) * 100 : null,
    offHighPct: dayHigh > 0 && px > 0 ? ((px - dayHigh) / dayHigh) * 100 : null,
    offLowPct: dayLow > 0 && px > 0 ? ((px - dayLow) / dayLow) * 100 : null,
  };
}

// One line for the prompt, in the terms a trader reads.
export function tapeLine(symbol, t) {
  if (!t || t.bars === 0) return `${symbol}: intraday bars unavailable`;
  const f = (n, d = 2) => (n == null ? "?" : Number(n).toFixed(d));
  const sgn = (n) => (n == null ? "?" : (n >= 0 ? "+" : "") + Number(n).toFixed(2) + "%");
  const bits = [`${symbol}: $${f(t.last)} is ${t.side ?? "?"} VWAP $${f(t.vwap)} (${sgn(t.vsVwapPct)})`];
  if (t.openingRange) bits.push(`${t.orPosition} the opening range $${f(t.openingRange.low)}-$${f(t.openingRange.high)}${t.openingRange.complete ? "" : " (still forming)"}`);
  if (t.fromOpenPct != null) bits.push(`${sgn(t.fromOpenPct)} from the open`);
  if (t.rangeUsedPct != null) bits.push(`today's range $${f(t.dayLow)}-$${f(t.dayHigh)} = ${f(t.rangeUsedPct, 0)}% of a normal day (14-day ATR $${f(t.atr14)})${t.rangeUsedPct >= ATR_USED_MAX_PCT ? " — EXTENDED, a continuation here is buying the end of the move" : ""}`);
  return bits.join(" · ");
}

export function tapeText(spy, bySymbol) {
  const lines = [tapeLine("SPY", spy)];
  for (const [sym, t] of Object.entries(bySymbol)) if (sym !== "SPY") lines.push(tapeLine(sym, t));
  return lines.join("\n");
}
