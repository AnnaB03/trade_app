import { NextResponse } from "next/server";
import { tradier, asArray } from "../tradier";
import { listIdeas } from "../store";
import { trendRead, recordTrendRead, trendHistory } from "../trendDayLib";

/* The trend-day read (trendDayLib.js): QQQ and SPY since the open, and which
   side today's ideas lean. Information only: it changes no trading rule. The
   schedule calls it every minute so the 10:30/11:00/12:00 reads and the close
   are recorded; the dashboard shows the latest. ?history=1 adds the record. */
export async function GET(req) {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const hhmm = now.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
  const [h, m] = hhmm.split(":").map(Number);
  let qqq = {}, spy = {};
  try {
    const d = await tradier("/markets/quotes?symbols=QQQ,SPY");
    for (const q of asArray(d?.quotes?.quote)) {
      const v = { open: Number(q.open) || null, last: Number(q.last) || null };
      if (q.symbol === "QQQ") qqq = v; else if (q.symbol === "SPY") spy = v;
    }
  } catch {}
  // Today's latest directional read per symbol, from the model's ideas.
  const latest = new Map();
  for (const i of listIdeas()) {
    if (!i.createdAt || new Date(i.createdAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) !== date) continue;
    const prev = latest.get(i.symbol);
    if (!prev || i.createdAt > prev.createdAt) latest.set(i.symbol, i);
  }
  const actions = [...latest.values()].map((i) => i.action).filter((a) => a && a !== "WAIT");
  const read = trendRead({ qqq, spy, actions, etMinutes: h * 60 + m });
  const weekday = now.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
  if (!["Sat", "Sun"].includes(weekday)) recordTrendRead(read, { date, hhmm, qqqLast: qqq.last, spyLast: spy.last });
  const out = { date, at: hhmm, ...read };
  if (new URL(req.url).searchParams.get("history")) out.history = trendHistory();
  return NextResponse.json(out);
}
