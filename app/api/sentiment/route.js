import { NextResponse } from "next/server";

// LunarCrush v4 public topic endpoint, read server-side. Degrades gracefully:
// { available: false, reason } is a valid answer — the UI falls back to manual entry.
export async function GET(req) {
  const symbol = new URL(req.url).searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const token = process.env.LUNARCRUSH_TOKEN;
  if (!token) {
    return NextResponse.json({ available: false, reason: "LUNARCRUSH_TOKEN not set" });
  }
  // stocks are usually cashtag topics ($nvda); fall back to the bare name
  const topics = [`$${symbol.toLowerCase()}`, symbol.toLowerCase()];
  for (const t of topics) {
    try {
      const r = await fetch(`https://lunarcrush.com/api4/public/topic/${encodeURIComponent(t)}/v1`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!r.ok) continue;
      const d = await r.json();
      const s = Number(d?.data?.sentiment);
      if (Number.isFinite(s) && s >= 0 && s <= 100) {
        return NextResponse.json({ available: true, topic: t, sentiment: s });
      }
    } catch {}
  }
  return NextResponse.json({ available: false, reason: "no LunarCrush topic for this symbol (or tier blocks it)" });
}
