/* Shared FMP momentum + analyst-conviction fetchers.
   Used by /api/trend (the symbol card) and /api/suggestions (the Ideas prompt).

   The app already carries plenty of VOLATILITY context — IV rank, HV, expected
   move. What it had no read on was DIRECTION: whether a name is stretched, and
   whether the street is already unanimously long it. These two fill that gap.

   Both are cached in-memory to protect the FMP quota: RSI moves once a day, and
   analyst grades move a few times a quarter, so the Ideas tab's 60s refresh must
   not re-fetch them. */
import { fmpGet } from "./fmp";

const RSI_TTL = 60 * 60 * 1000;        // daily bar — an hour is plenty fresh
const GRADES_TTL = 12 * 60 * 60 * 1000; // ratings change a handful of times a quarter
const cache = new Map(); // key → { at, data }

const getCached = (k, ttl) => {
  const c = cache.get(k);
  return c && Date.now() - c.at < ttl ? c.data : undefined;
};

/* 14-day RSI on daily bars. Returns a number, or null when unavailable
   (no key, no coverage, index symbols like SPX). */
export async function fetchRsi(symbol) {
  const k = `rsi:${symbol}`;
  const hit = getCached(k, RSI_TTL);
  if (hit !== undefined) return hit;

  const rows = await fmpGet("technical-indicators/rsi", {
    symbol, periodLength: 14, timeframe: "1day",
  });
  // FMP returns newest-first; take the latest bar that actually carries an rsi
  const latest = (Array.isArray(rows) ? rows : []).find((r) => Number.isFinite(Number(r?.rsi)));
  const out = latest ? Number(latest.rsi) : null;
  cache.set(k, { at: Date.now(), data: out });
  return out;
}

/* Analyst ratings distribution: { strongBuy, buy, hold, sell, strongSell, consensus }
   or null. This is the spread of opinion behind the price target the app
   already shows — a target of $250 means something different when 3 analysts
   cover it than when 79 do. */
export async function fetchGrades(symbol) {
  const k = `grades:${symbol}`;
  const hit = getCached(k, GRADES_TTL);
  if (hit !== undefined) return hit;

  const rows = await fmpGet("grades-summary", { symbol });
  const r = Array.isArray(rows) ? rows[0] : rows;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const out = r
    ? {
        strongBuy: n(r.strongBuy), buy: n(r.buy), hold: n(r.hold),
        sell: n(r.sell), strongSell: n(r.strongSell),
        consensus: r.consensus ?? null,
      }
    : null;
  // a row of all-zeros means "no coverage", not "unanimously neutral"
  const total = out ? out.strongBuy + out.buy + out.hold + out.sell + out.strongSell : 0;
  const data = total > 0 ? out : null;
  cache.set(k, { at: Date.now(), data });
  return data;
}
