import { NextResponse } from "next/server";
import { tradier, tradierDelayed, asArray, dataMode } from "../tradier";

export async function GET(req) {
  const p = new URL(req.url).searchParams;
  const symbols = p.get("symbols");
  if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
  /* ?delayed=true reads the SANDBOX feed instead of production. Not a
     degraded mode — it is the correct feed for valuing a PAPER position,
     because the sandbox order engine prices fills off that same delayed data
     and it is what the sandbox UI shows. Measured on SPCX 10/23 $157.50c at
     one instant: production 6.65/6.80/7.00 against sandbox 6.60/6.75/6.64,
     which on 14 contracts is the difference between reporting +$385 and the
     -$28 actually on screen. Use delayed for "what is this position worth",
     production for "has the trigger been hit". */
  const delayed = p.get("delayed") === "true";
  try {
    const call = delayed ? tradierDelayed : tradier;
    const d = await call(`/markets/quotes?symbols=${encodeURIComponent(symbols)}`);
    return NextResponse.json({
      quotes: asArray(d?.quotes?.quote),
      feed: delayed ? "sandbox-delayed" : dataMode(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
