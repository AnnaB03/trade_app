/* ---------- Liquidity-sweep scan: live data -> setups -> ideas ledger ----------
   Runs the pure detector in app/lib/sweep.js against Tradier data and logs
   every setup it finds into the SAME ideas ledger the AI suggestions use
   (store.js), tagged with a `strategy` field, so both get graded by the
   same +1h / +1d / final checkpoints (grade/route.js) and journaled by the
   same order path. `strategy` is absent on AI ideas — see STRATEGIES.

   The naive LIMIT variant is logged as `pendingFill: true`: a resting limit
   that price never reaches is not a trade, and grading it as if it filled
   would hide the exact thing this strategy needs measured (adverse
   selection — what fills is disproportionately what keeps falling). It
   starts grading from the moment price actually touches the limit
   (`gradeFrom`), or is marked `unfilled` once its day ends without a touch. */
import { tradier, asArray } from "./tradier";
import { dailyBars } from "./historyCache";
import { listIdeas, appendIdea, updateIdea } from "./store";
import { sizeIdea } from "./sizingLib";
import { DEFAULT_SWEEP_SYMS, limitSetup, dailyReclaimSetup, intradayReclaimSetup, backtest, fitScore, liquidityLevels, trendAt, atr, setupConviction } from "../lib/sweep";

export { DEFAULT_SWEEP_SYMS };

export const STRATEGIES = {
  ai: "AI ideas (trigger / breakout)",
  sweep_limit: "Sweep · limit at the stops",
  sweep_reclaim: "Sweep · reclaim confirmation",
};
export const strategyOf = (idea) => idea?.strategy || "ai";

export const etDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function quotes(symbols) {
  if (!symbols.length) return {};
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
    return Object.fromEntries(asArray(d?.quotes?.quote).map((q) => [q.symbol, q]));
  } catch {
    return {};
  }
}

async function todayFiveMin(symbol) {
  const day = etDate();
  try {
    const d = await tradier(`/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=5min&start=${encodeURIComponent(day + " 09:30")}&end=${encodeURIComponent(day + " 16:00")}&session_filter=open`);
    return asArray(d?.series?.data).map((b) => ({ time: b.time, open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume) }))
      .filter((b) => b.close > 0);
  } catch {
    return [];
  }
}

const toBars = (raw) => raw
  .map((b) => ({ date: b.date, open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume) }))
  .filter((b) => b.close > 0 && b.low > 0);

// Backtests only change once a day — cache per symbol per ET date.
const btCache = new Map();
function cachedBacktest(symbol, bars) {
  const key = `${symbol}:${bars[bars.length - 1]?.date}`;
  if (!btCache.has(key)) btCache.set(key, backtest(bars));
  return btCache.get(key);
}

/* A limit idea still waiting on a touch: fill it if price has reached the
   limit (today's low from the live quote, or that day's daily bar if we're
   checking after the fact), expire it once its day is over. Also run from
   grade/route.js so this resolves even if the Sweeps tab isn't reopened. */
export async function resolvePendingLimits({ quoteBySym = null } = {}) {
  const pending = listIdeas().filter((i) => i.strategy === "sweep_limit" && i.pendingFill);
  if (!pending.length) return 0;
  const today = etDate();
  const qs = quoteBySym || await quotes([...new Set(pending.map((i) => i.symbol))]);
  let changed = 0;
  for (const idea of pending) {
    const day = idea.setupDate || etDate(new Date(idea.createdAt));
    let low = null;
    if (day === today) low = Number(qs[idea.symbol]?.low) || null;
    else {
      const bar = (await dailyBars(idea.symbol, 20)).find((b) => b.date === day);
      low = bar ? Number(bar.low) : null;
    }
    if (low != null && low <= idea.entryPrice) {
      // Found today: it filled at or before now. Found after the fact: the
      // exact touch time isn't known, so start the clock at that day's close.
      const gradeFrom = day === today ? new Date().toISOString() : new Date(`${day}T20:00:00Z`).toISOString();
      updateIdea(idea.id, { pendingFill: false, filled: true, gradeFrom, filledLow: low });
      changed++;
    } else if (day < today && low != null) {
      updateIdea(idea.id, { pendingFill: false, filled: false, unfilled: true });
      changed++;
    }
  }
  return changed;
}

function toIdea(symbol, setup, bt, account, regimeTrend) {
  const strategy = setup.variant === "limit" ? "sweep_limit" : "sweep_reclaim";
  const conviction = setupConviction(setup, bt);
  const idea = {
    symbol, action: "BUY", vehicle: "SHARES", strategy,
    setupKey: `${strategy}:${symbol}:${setup.level}:${setup.timeframe || "daily"}`,
    setupDate: etDate(),
    entryPrice: setup.entry, invalidation: setup.stop, target: setup.target,
    triggerPrice: null, triggerDirection: null,
    entryTrigger: setup.variant === "limit"
      ? `Resting buy limit $${setup.entry.toFixed(2)} (just under the $${setup.level.toFixed(2)} swing low), good for today only`
      : `Reclaimed $${setup.level.toFixed(2)} after sweeping to $${setup.sweepLow.toFixed(2)} — buy now`,
    staleMinutes: setup.variant === "limit" ? 390 : setup.timeframe === "intraday" ? 30 : 120,
    conviction, catalyst: setup.variant === "limit" ? "liquidity sweep (limit)" : `liquidity sweep (reclaim, ${setup.timeframe})`,
    risk: conviction >= 4 ? "MEDIUM" : "HIGH",
    why_pro: `${setup.why} R:R ${setup.rr != null ? setup.rr.toFixed(1) : "?"} to $${setup.target.toFixed(2)}. Trend ${setup.trend}.`,
    why_plain: setup.variant === "limit"
      ? "Buying where other traders' stop-losses sit, betting the dip that triggers them snaps back."
      : "Price dipped under a level where stops sit, then climbed back above it — buying the snap-back.",
    pendingFill: setup.variant === "limit" ? true : undefined,
    setup, regimeTrend, accountSize: account,
  };
  const { sizing, affordable } = sizeIdea(idea, account);
  return { ...idea, sizing, affordable };
}

/* One full pass. `log` writes new setups to the ledger (deduped per setup per
   day, so a scan every few minutes doesn't flood it). Returns per-symbol
   context + the setups found, each carrying its ledger id. */
export async function scanSweeps({ symbols = DEFAULT_SWEEP_SYMS, account = 1000, log = true, intraday = true, marketState = "unknown" } = {}) {
  const syms = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z.]{1,6}$/.test(s)))].slice(0, 25);
  const today = etDate();
  const qBySym = await quotes([...syms, "SPY"]);
  await resolvePendingLimits({ quoteBySym: qBySym });

  let spyTrend = null;
  try { spyTrend = trendAt(toBars(await dailyBars("SPY", 120)).filter((b) => b.date < today)); } catch {}

  const ledgerToday = listIdeas().filter((i) => i.strategy && i.setupDate === today);
  const rows = await Promise.all(syms.map(async (symbol) => {
    try {
      const bars = toBars(await dailyBars(symbol, 700)).filter((b) => b.date < today); // completed bars only
      if (bars.length < 80) return { symbol, error: "not enough daily history" };
      const q = qBySym[symbol] || {};
      const live = Number(q.last) || bars[bars.length - 1].close;
      const bt = cachedBacktest(symbol, bars);
      const a = atr(bars);
      const levels = liquidityLevels(bars, bars.length, a).filter((l) => l.price < live).slice(0, 3);

      const open = marketState === "open" || marketState === "unknown";
      const five = intraday && open ? await todayFiveMin(symbol) : [];
      const found = [];
      const r1 = intradayReclaimSetup(bars, five) || dailyReclaimSetup(bars, live);
      if (r1) found.push(r1);
      const l1 = limitSetup(bars, live);
      // Don't also rest a limit under a level that's already been swept and reclaimed today.
      if (l1 && !(r1 && r1.level === l1.level)) found.push(l1);

      const setups = found.map((s) => {
        const idea = toIdea(symbol, s, bt, account, spyTrend);
        const existing = ledgerToday.find((i) => i.setupKey === idea.setupKey);
        if (existing) return { ...idea, id: existing.id, logged: false, pendingFill: existing.pendingFill, filled: existing.filled };
        if (!log || !s.ok) return { ...idea, id: null, logged: false };
        const row = appendIdea(idea);
        ledgerToday.push(row);
        return { ...idea, id: row.id, logged: true };
      });

      return {
        symbol, price: live, dayLow: Number(q.low) || null, changePct: q.change_percentage != null ? Number(q.change_percentage) : null,
        atr: a, trend: trendAt(bars), levels,
        nearestLevel: levels[0] ? { ...levels[0], distanceAtr: (live - levels[0].price) / a } : null,
        backtest: { ...bt, trades: undefined }, recentTrades: bt.trades, fit: fitScore(bt),
        setups,
      };
    } catch (e) {
      return { symbol, error: String(e.message || e) };
    }
  }));

  return { asOf: new Date().toISOString(), date: today, spyTrend, symbols: rows };
}
