import { NextResponse } from "next/server";
import { tradier, asArray } from "../tradier";
import { macroEvents, todayET } from "../eventsLib";
import { toRows, optMid } from "../../lib/metrics";
import {
  vwapSeries, emaSeries, openingRange, classifyRegime, pullbackState,
  leaderAgrees, holdCostEstimate, nearSpotPin,
} from "../../lib/scalperMath";

/* Deterministic intraday engine for a 2-5 minute SPY/SPX/XSP scalp — no LLM
   in this loop. Built because the main Ideas engine judges an index off
   DAILY bars every 2.5 hours with a ~60s reasoning delay, which is the
   wrong tool for this: it called a clean, zero-VWAP-flip trend day
   "chasing" 16 times in a row on 2026-09-21. This looks inside the day
   instead — 1-minute bars, VWAP, EMA, opening range, leader confirmation,
   event lock windows, live option cost — and answers one question:
   is there a trade RIGHT NOW, or not, with a stated reason either way. */

const PRIMARY = "SPY";
const LEADERS = ["QQQ", "NVDA"];
const SESSION_START_MIN = 9 * 60 + 30; // 9:30 ET
const SESSION_END_MIN = 16 * 60; // 16:00 ET

function etNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function etMinutes(d) { return d.getHours() * 60 + d.getMinutes(); }
const pad = (n) => String(n).padStart(2, "0");

// Today's regular-session 1-min bars for a symbol, via Tradier timesales.
async function sessionBars(symbol) {
  const today = todayET();
  try {
    const d = await tradier(`/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=1min&start=${today}%2009:30&end=${today}%2016:00&session_filter=open`);
    return asArray(d?.series?.data).filter((b) => b?.close != null);
  } catch {
    return [];
  }
}

// Time-of-day trading windows a sharp intraday desk actually observes.
function timeWindow(nowMin) {
  if (nowMin < SESSION_START_MIN || nowMin >= SESSION_END_MIN) return { label: "MARKET CLOSED", tradable: false };
  if (nowMin < SESSION_START_MIN + 5) return { label: "OPEN — first 5 min, spreads still settling", tradable: false };
  if (nowMin >= SESSION_END_MIN - 10) return { label: "LAST 10 MIN — MOC imbalance risk, no new entries", tradable: false };
  if (nowMin >= 11 * 60 + 30 && nowMin < 13 * 60 + 30) return { label: "MIDDAY — historically the chop window, be selective", tradable: true, caution: true };
  if (nowMin >= 14 * 60 && nowMin < 15 * 60 + 30) return { label: "AFTERNOON — trend-resumption window", tradable: true };
  return { label: "REGULAR", tradable: true };
}

// Event lock: inside -5/+3 minutes of a scheduled release/speech today, per
// the audit — a Fed line can flip the regime read instantly.
function eventLockState(events, nowMin) {
  const todaysEvents = events.filter((e) => e.timeET);
  let active = null, next = null, minToNext = Infinity;
  for (const e of todaysEvents) {
    const m = parseETTimeToMinutes(e.timeET);
    if (m == null) continue;
    if (nowMin >= m - 5 && nowMin <= m + 3) active = { ...e, minutes: m };
    const delta = m - nowMin;
    if (delta >= -3 && delta < minToNext) { minToNext = delta; next = { ...e, minutes: m }; }
  }
  return {
    locked: Boolean(active),
    active,
    next: next && minToNext !== Infinity ? { ...next, inMinutes: Math.round(minToNext) } : null,
  };
}
function parseETTimeToMinutes(timeET) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(timeET.trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}

async function nearestExpirationChain(symbol) {
  try {
    const expD = await tradier(`/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true`);
    const exps = asArray(expD?.expirations?.date).filter(Boolean).sort();
    const today = todayET();
    const exp = exps.find((e) => e >= today) || exps[0];
    if (!exp) return null;
    const chainD = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(exp)}&greeks=true`);
    return { expiration: exp, options: asArray(chainD?.options?.option) };
  } catch {
    return null;
  }
}

export async function GET(req) {
  const params = new URL(req.url).searchParams;
  const symbol = (params.get("symbol") || PRIMARY).toUpperCase();

  try {
    const now = etNow();
    const nowMin = etMinutes(now);
    const nowLabel = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const [bars, ...leaderBarsArr] = await Promise.all([sessionBars(symbol), ...LEADERS.map(sessionBars)]);
    const leaderBars = Object.fromEntries(LEADERS.map((s, i) => [s, leaderBarsArr[i]]));

    if (!bars.length) {
      return NextResponse.json({
        available: false,
        reason: nowMin < SESSION_START_MIN || nowMin >= SESSION_END_MIN ? "Market closed — no session bars yet today." : "No bars returned yet for today's session.",
        nowET: nowLabel,
      });
    }

    const closes = bars.map((b) => Number(b.close));
    // A cash-settled index (XSP, SPX) reports zero share volume on every
    // bar — confirmed live: feeding that straight into a volume-weighted
    // VWAP degenerates into each bar's own typical price, which "crosses"
    // constantly and misread a clean SPY trend day as 184-flip CHOP on
    // XSP. Per the audit: proxy real participation from SPY, which trades
    // the same underlying index and the same regular-session minutes.
    const hasVolume = bars.some((b) => Number(b.volume) > 0);
    let barsForVwap = bars;
    if (!hasVolume && symbol !== "SPY") {
      const spyBars = await sessionBars("SPY");
      const volByTime = new Map(spyBars.map((b) => [b.time, Number(b.volume) || 0]));
      barsForVwap = bars.map((b) => ({ ...b, volume: volByTime.get(b.time) ?? 0 }));
    }
    const { vwap } = vwapSeries(barsForVwap);
    const ema9 = emaSeries(closes, 9);
    const ema21 = emaSeries(closes, 21);
    const or15 = openingRange(bars, 15);
    const regime = classifyRegime({ bars, closes, vwap, or: or15 });
    const dir = regime.state === "TREND UP" ? "up" : regime.state === "TREND DOWN" ? "down" : null;
    const pullback = dir ? pullbackState(closes, ema9, dir) : { state: "N/A" };

    const leaders = {};
    for (const s of LEADERS) {
      const lb = leaderBars[s] || [];
      const lc = lb.map((b) => Number(b.close));
      leaders[s] = dir ? leaderAgrees(lc, Math.min(10, lc.length - 1), dir) : null;
    }
    const leaderConfirmCount = Object.values(leaders).filter((l) => l?.agrees).length;
    const leaderTotal = Object.values(leaders).filter((l) => l != null).length;

    // Today's macro/Fed calendar, filtered to today, with an active-lock and
    // next-event countdown — see eventsLib.js for the Fed-speech inclusion.
    let events = [];
    try { events = (await macroEvents()).filter((e) => e.date === todayET()); } catch {}
    const eventLock = eventLockState(events, nowMin);
    const window = timeWindow(nowMin);

    // Live ATM option: nearest expiration, cost of a 5-min hold, near-spot pin.
    const chain = await nearestExpirationChain(symbol);
    const spot = closes[closes.length - 1];
    let atm = null, pin = null;
    if (chain?.options?.length) {
      const rows = toRows(chain.options);
      pin = nearSpotPin(rows, spot);
      const nearest = rows.reduce((b, r) => Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b, rows[0]);
      const callLeg = nearest.call, putLeg = nearest.put;
      const build = (leg, type) => leg ? {
        type, strike: nearest.strike, bid: Number(leg.bid), ask: Number(leg.ask), mid: optMid(leg),
        delta: leg.greeks?.delta != null ? Number(leg.greeks.delta) : null,
        theta: leg.greeks?.theta != null ? Number(leg.greeks.theta) : null,
        hold5min: holdCostEstimate({ bid: Number(leg.bid), ask: Number(leg.ask), theta: leg.greeks?.theta != null ? Number(leg.greeks.theta) : null, minutes: 5 }),
      } : null;
      atm = { expiration: chain.expiration, strike: nearest.strike, call: build(callLeg, "call"), put: build(putLeg, "put") };
    }

    // Final signal: only fires with regime + pullback + leader confirmation
    // + no event lock + a tradable time window all agreeing. Anything less
    // is reported as NO TRADE with the specific reason, never a forced call.
    let signal = { action: "NO TRADE", reason: "" };
    if (eventLock.locked) {
      signal = { action: "NO TRADE", reason: `Event lock — ${eventLock.active.label} at ${eventLock.active.timeET} ET. No entries within 5 min before / 3 min after a scheduled release.` };
    } else if (!window.tradable) {
      signal = { action: "NO TRADE", reason: window.label };
    } else if (regime.state === "CHOP") {
      signal = { action: "NO TRADE", reason: regime.detail };
    } else if (regime.state === "MIXED" || regime.state === "UNKNOWN") {
      signal = { action: "NO TRADE", reason: `Regime not yet established — ${regime.detail}` };
    } else if (pullback.state !== "AT_EMA" && pullback.state !== "NEAR_EMA") {
      signal = { action: "NO TRADE", reason: `${regime.state}, but entry state is ${pullback.state} — ${pullback.detail || "wait for a pullback"}` };
    } else if (leaderTotal > 0 && leaderConfirmCount < Math.ceil(leaderTotal / 2)) {
      signal = { action: "NO TRADE", reason: `${regime.state} with a valid pullback, but only ${leaderConfirmCount}/${leaderTotal} leaders (QQQ/NVDA) confirm — SPY may be leading alone` };
    } else {
      const side = dir === "up" ? "call" : "put";
      const leg = atm?.[side];
      signal = {
        action: dir === "up" ? "BUY CALL" : "BUY PUT",
        reason: `${regime.state}, pullback to 9-EMA holding (${pullback.detail}), ${leaderConfirmCount}/${leaderTotal || "?"} leaders confirm.`,
        contract: leg ? { expiration: atm.expiration, strike: atm.strike, type: side, ask: leg.ask, delta: leg.delta } : null,
        hold5minCost: leg?.hold5min ?? null,
      };
    }

    return NextResponse.json({
      available: true, symbol, nowET: nowLabel, spot,
      openingRange: or15, regime, pullback,
      leaders: Object.fromEntries(LEADERS.map((s) => [s, leaders[s]])),
      window, eventLock, atm, pin, signal,
      barsUsed: bars.length,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
