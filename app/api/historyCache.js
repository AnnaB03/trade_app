/* Shared 60s in-memory cache for Tradier daily history, so the regime read,
   the suggestions route's intraday-structure block, and anything else that
   needs recent daily bars don't each pull the same symbol separately on
   every request. Not persistent — resets on cold start, which is fine for a
   60s TTL. */
import { tradier, asArray } from "./tradier";

const TTL = 60 * 1000;
const cache = new Map(); // `${symbol}:${days}` -> { at, bars }

export async function dailyBars(symbol, days = 30) {
  const key = `${symbol}:${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.bars;
  const end = new Date(), start = new Date(Date.now() - days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  try {
    const d = await tradier(`/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${iso(start)}&end=${iso(end)}`);
    const bars = asArray(d?.history?.day).filter((x) => x && x.close != null);
    cache.set(key, { at: Date.now(), bars });
    return bars;
  } catch {
    return [];
  }
}

export async function dailyCloses(symbol, days = 30) {
  return (await dailyBars(symbol, days)).map((b) => Number(b.close));
}
