import { NextResponse } from "next/server";
import { getMovers } from "../moversLib";
import { fmpGet } from "../fmp";
import { tradier, asArray } from "../tradier";
import { dailyBars } from "../historyCache";
import { rvolTimeAdjusted, floatRotation, volumeRead } from "../../lib/checks";
import { vwapSeries } from "../../lib/scalperMath";

/* Deterministic movers scanner — no LLM in this loop, meant to be polled
   every 2-5 minutes from well before the open through the close. Built
   because the main Ideas engine only looks at the market a few times a day
   and only has room for a handful of the biggest movers by %, which are
   usually the LEAST tradeable ones (already extended, already reversing).
   This classifies every real mover's CURRENT state — still running, pulled
   back and holding, or already fading — using the same RVOL-from-daily-bars
   fix applied to the main engine, plus float rotation and a live VWAP read
   from 5-min bars. Cached 2 min; each full scan is a real batch of Tradier
   timesales + FMP profile/float calls, not something to run on every
   keystroke. */

const TTL = 2 * 60 * 1000;
let cached = null;
const CANDIDATE_CAP = 12;
const MIN_MOVE_PCT = 15; // below this, it's not a "mover" for this radar's purpose

async function rvolFor(symbol, todayVolume) {
  try {
    const bars = await dailyBars(symbol, 30);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const prior = bars.filter((b) => b.date < today).slice(-20);
    const vols = prior.map((b) => Number(b.volume)).filter((v) => v > 0);
    const avg = vols.length >= 5 ? vols.reduce((s, v) => s + v, 0) / vols.length : null;
    return avg ? rvolTimeAdjusted(todayVolume, avg, { sessionOpen: true }) : null;
  } catch {
    return null;
  }
}

async function floatRotationFor(symbol, todayVolume) {
  try {
    const fl = await fmpGet("shares-float", { symbol });
    const row = Array.isArray(fl) ? fl[0] : fl;
    return row?.floatShares ? floatRotation(todayVolume, row.floatShares) : null;
  } catch {
    return null;
  }
}

// 5-min intraday state: VWAP position, off-high/off-low, and whether a
// pullback happened and held (CONTINUATION) or VWAP was lost after a run
// (FADE) — reusing the same VWAP math the Scalper panel uses.
async function intradayState(symbol) {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const d = await tradier(`/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=5min&start=${today}%2004:00&end=${today}%2020:00&session_filter=all`);
    const bars = asArray(d?.series?.data).filter((b) => b?.close != null);
    if (bars.length < 3) return null;
    const closes = bars.map((b) => Number(b.close));
    const { vwap } = vwapSeries(bars);
    const last = closes[closes.length - 1];
    const lastVwap = vwap[vwap.length - 1];
    const todayHigh = Math.max(...bars.map((b) => Number(b.high)));
    const todayLow = Math.min(...bars.map((b) => Number(b.low)));
    const offHighPct = ((last - todayHigh) / todayHigh) * 100;
    const offLowPct = ((last - todayLow) / todayLow) * 100;
    // Pullback-held check: among the last 6 bars (30 min), did price dip
    // below the prior swing high and then reclaim it, without losing VWAP?
    const recent = bars.slice(-6);
    const recentAboveVwap = recent.every((b, i) => vwap[vwap.length - recent.length + i] == null || Number(b.close) >= vwap[vwap.length - recent.length + i] * 0.995);
    return { last, aboveVwap: lastVwap != null ? last >= lastVwap : null, offHighPct, offLowPct, todayHigh, todayLow, recentAboveVwap };
  } catch {
    return null;
  }
}

function classify(m, rvol, rot, state) {
  const bigRvol = rvol != null && rvol >= 8;
  const bigRot = rot != null && rot >= 0.5;
  const realVolume = bigRvol || bigRot;
  if (!state) return { type: "WATCH", note: "no intraday bar data yet" };
  const nearHigh = state.offHighPct != null && state.offHighPct >= -3;
  const fadingHard = state.offHighPct != null && state.offHighPct <= -15;
  const lostVwap = state.aboveVwap === false;

  if (fadingHard && lostVwap) {
    return { type: "FADE", note: `${Math.abs(state.offHighPct).toFixed(0)}% off today's high and below VWAP — the parabolic phase is over` };
  }
  if (nearHigh && state.aboveVwap && realVolume) {
    return { type: "CONTINUATION", note: `holding within 3% of today's high, above VWAP, real volume (${bigRvol ? `${rvol.toFixed(1)}x RVOL` : `${(rot * 100).toFixed(0)}% float rotation`})` };
  }
  if (state.aboveVwap === false && !fadingHard) {
    return { type: "WATCH", note: "below VWAP but not yet a hard fade — needs to reclaim or it likely rolls over" };
  }
  return { type: "WATCH", note: "moving, but no clean continuation or fade signature yet" };
}

async function buildRadar() {
  const moversData = await getMovers();
  if (!moversData.available) return { available: false, reason: moversData.reason || "FMP_API_KEY not set", movers: [] };

  const pool = [...moversData.session.gainers, ...moversData.session.losers]
    .filter((m) => Math.abs(m.changePct) >= MIN_MOVE_PCT)
    .slice(0, CANDIDATE_CAP);

  const quotesD = pool.length
    ? await tradier(`/markets/quotes?symbols=${encodeURIComponent(pool.map((m) => m.symbol).join(","))}`).catch(() => null)
    : null;
  const quoteBySym = Object.fromEntries(asArray(quotesD?.quotes?.quote).map((q) => [q.symbol, q]));

  const movers = await Promise.all(pool.map(async (m) => {
    const q = quoteBySym[m.symbol] || {};
    const todayVolume = Number(q.volume) || null;
    const [rvol, rot, state] = await Promise.all([
      rvolFor(m.symbol, todayVolume),
      floatRotationFor(m.symbol, todayVolume),
      intradayState(m.symbol),
    ]);
    const cls = classify(m, rvol, rot, state);
    return {
      symbol: m.symbol, name: m.name, price: m.price, changePct: m.changePct,
      headline: m.headline || null,
      rvol, floatRotation: rot, rvolRead: rvol != null ? volumeRead(rvol) : null,
      state, classification: cls,
    };
  }));

  // Most actionable first: CONTINUATION, then WATCH, then FADE (informational).
  const order = { CONTINUATION: 0, WATCH: 1, FADE: 2 };
  movers.sort((a, b) => (order[a.classification.type] - order[b.classification.type]) || (Math.abs(b.changePct) - Math.abs(a.changePct)));

  return { available: true, marketState: moversData.marketState, movers, asOf: new Date().toISOString() };
}

export async function GET() {
  if (cached && Date.now() - cached.at < TTL) return NextResponse.json(cached.data);
  const data = await buildRadar();
  cached = { at: Date.now(), data };
  return NextResponse.json(data);
}
