/* The trend-day indicator (information only, 2026-10-30).

   The owner, after 10-30 (QQQ -3.7% from yesterday's close, 16 of 18 options
   won): "we need to catch those days as early in a day as possible." A
   three-year backtest (scripts/backtest/trend_day.py) showed a morning move
   does not reliably predict the rest of the day: going with it made +$37k in
   2022 and lost in 2024-25 and 2025-26. So this changes no trading rule. It
   shows the read on the dashboard, and records it at fixed times with how
   the day actually closed, so its record is judged on our own days before
   anyone trusts it with a rule. scripts/trendday-report.py scores it.

   A trend day is flagged from 10:30 ET when QQQ has moved TREND_QQQ_PCT or
   more since the open, SPY at least TREND_SPY_PCT the same way, and at least
   TREND_IDEA_SHARE of the model's directional ideas are on that side. */
import fs from "fs";
import path from "path";

export const TREND_FROM_ET_MIN = 10 * 60 + 30;
export const TREND_QQQ_PCT = 1.0;
export const TREND_SPY_PCT = 0.5;
export const TREND_LEAN_PCT = 0.5;
export const TREND_IDEA_SHARE = 2 / 3;
export const TREND_SLOTS = ["10:30", "11:00", "12:00"];
const FILE = path.join(process.cwd(), "data", "trendday.json");
const SLOT_WINDOW_MIN = 15;

const pct = (o, l) => (o > 0 && l > 0 ? ((l - o) / o) * 100 : null);

export function trendRead({ qqq = {}, spy = {}, actions = [], etMinutes }) {
  const qqqMove = pct(qqq.open, qqq.last), spyMove = pct(spy.open, spy.last);
  const calls = actions.filter((a) => a === "CALL" || a === "BUY").length;
  const puts = actions.filter((a) => a === "PUT").length;
  const read = { qqqMove, spyMove, calls, puts, flag: "none", side: null };
  if (qqqMove == null || spyMove == null) return { ...read, flag: "no_data", label: "No QQQ/SPY quote yet." };
  if (Number(etMinutes) < TREND_FROM_ET_MIN) return { ...read, flag: "too_early", label: "Before 10:30: too early to call the day." };
  const side = qqqMove > 0 ? "up" : "down";
  const sameSpy = side === "up" ? spyMove >= TREND_SPY_PCT : spyMove <= -TREND_SPY_PCT;
  const ideasSame = side === "up" ? calls : puts;
  const share = calls + puts > 0 ? ideasSame / (calls + puts) : 0;
  const moves = `QQQ ${qqqMove >= 0 ? "+" : ""}${qqqMove.toFixed(2)}%, SPY ${spyMove >= 0 ? "+" : ""}${spyMove.toFixed(2)}% since the open`;
  if (Math.abs(qqqMove) >= TREND_QQQ_PCT && sameSpy && share >= TREND_IDEA_SHARE) {
    return { ...read, side, flag: `trend_${side}`, label: `Likely trend day ${side}: ${moves}; ${ideasSame} of ${calls + puts} ideas agree.` };
  }
  if (Math.abs(qqqMove) >= TREND_LEAN_PCT && (side === "up" ? spyMove >= TREND_SPY_PCT / 2 : spyMove <= -TREND_SPY_PCT / 2)) {
    return { ...read, side, flag: `lean_${side}`, label: `Leaning ${side}: ${moves}; not a trend day yet.` };
  }
  return { ...read, label: `No trend: ${moves}.` };
}

/* Breadth (recorded only, 2026-10-30): how many core-list stocks are 1%+ down
   or up since the open. A real trend day tends to take nearly everything with
   it (10-30: nothing on the list was up); QQQ's own chart cannot show that,
   and the 3-year price-only test found no morning clue that held up. */
export function breadthOf(stocks = []) {
  const moves = stocks.map((q) => (q.open > 0 && q.last > 0 ? ((q.last - q.open) / q.open) * 100 : null)).filter((x) => x != null);
  return { total: moves.length, down: moves.filter((x) => x <= -1).length, up: moves.filter((x) => x >= 1).length };
}

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch { return {}; }
}

/* One reading per slot (the first at or after it), plus the latest reading of
   the session, which after 16:00 is that day's close. */
export function recordTrendRead(read, { date, hhmm, qqqLast, spyLast }) {
  if (!date || !hhmm || hhmm < "09:30" || hhmm > "16:05") return null;
  const all = readAll();
  const day = all[date] || { slots: {} };
  // Only within SLOT_WINDOW_MIN of the slot: a reading taken later is not what was known then.
  const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  for (const s of TREND_SLOTS) {
    const late = mins(hhmm) - mins(s);
    if (late >= 0 && late < SLOT_WINDOW_MIN && !day.slots[s]) day.slots[s] = { ...read, qqqLast, spyLast, at: hhmm };
  }
  day.last = { qqqMove: read.qqqMove, spyMove: read.spyMove, qqqLast, spyLast, at: hhmm };
  all[date] = day;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch { return null; }
  return day;
}

export const trendHistory = () => readAll();
