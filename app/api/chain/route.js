import { NextResponse } from "next/server";
import { tradier, asArray } from "../tradier";

export async function GET(req) {
  const p = new URL(req.url).searchParams;
  const symbol = p.get("symbol"), expiration = p.get("expiration");
  if (!symbol || !expiration) return NextResponse.json({ error: "symbol and expiration required" }, { status: 400 });
  try {
    const d = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(expiration)}&greeks=true`);
    const opts = asArray(d?.options?.option).map((o) => ({
      symbol: o.symbol, strike: o.strike, type: o.option_type,
      bid: o.bid, ask: o.ask, last: o.last, volume: o.volume, oi: o.open_interest,
      iv: o.greeks?.mid_iv ?? null, delta: o.greeks?.delta ?? null,
      gamma: o.greeks?.gamma ?? null, theta: o.greeks?.theta ?? null, vega: o.greeks?.vega ?? null,
    }));
    return NextResponse.json({ options: opts });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
