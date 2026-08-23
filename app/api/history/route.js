import { NextResponse } from "next/server";
import { tradier, asArray } from "../tradier";

export async function GET(req) {
  const p = new URL(req.url).searchParams;
  const symbol = p.get("symbol");
  const days = Math.min(365, Math.max(2, Number(p.get("days")) || 30));
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  try {
    const end = new Date(), start = new Date(Date.now() - days * 86400000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const d = await tradier(`/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${iso(start)}&end=${iso(end)}`);
    const bars = asArray(d?.history?.day).filter((x) => x && x.close != null);
    if (bars.length < 2) return NextResponse.json({ error: `no daily history for ${symbol}` }, { status: 502 });
    const first = Number(bars[0].close), last = Number(bars[bars.length - 1].close);
    return NextResponse.json({
      symbol, days,
      start: bars[0].date, end: bars[bars.length - 1].date,
      first_close: first, last_close: last,
      change_pct: ((last - first) / first) * 100,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
