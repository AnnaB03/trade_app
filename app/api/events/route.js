import { NextResponse } from "next/server";
import { upcomingEarnings, macroEvents } from "../eventsLib";

/* Auto event risk: the next earnings date for the symbol (FMP) plus high-impact
   US macro releases (CPI, FOMC, NFP, ISM…) in the next 45 days. These feed the
   same hold-through-event warning as manually entered events.
   Degrades to { available:false } without FMP_API_KEY. */

export async function GET(req) {
  const symbol = new URL(req.url).searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!process.env.FMP_API_KEY) {
    return NextResponse.json({ available: false, reason: "FMP_API_KEY not set", events: [] });
  }
  try {
    const [earn, macro] = await Promise.all([upcomingEarnings(symbol.toUpperCase()), macroEvents()]);
    return NextResponse.json({ available: true, events: [...earn, ...macro].sort((a, b) => (a.date < b.date ? -1 : 1)) });
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e.message || e), events: [] });
  }
}
