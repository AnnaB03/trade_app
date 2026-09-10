import { NextResponse } from "next/server";
import { fetchRsi, fetchGrades } from "../trendLib";

/* Momentum (RSI 14) + analyst conviction for one symbol.
   Context, not signal — the symbol card shows it beside the volatility read.
   Degrades to { available:false } without an FMP key, and each half degrades
   independently so a missing RSI never hides the grades (or vice versa). */
export async function GET(req) {
  const symbol = new URL(req.url).searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!process.env.FMP_API_KEY) {
    return NextResponse.json({ available: false, reason: "FMP_API_KEY not set" });
  }
  const sym = symbol.toUpperCase();
  try {
    const [rsi, grades] = await Promise.all([
      fetchRsi(sym).catch(() => null),
      fetchGrades(sym).catch(() => null),
    ]);
    if (rsi == null && grades == null) {
      // index products (SPX) and thin names have neither
      return NextResponse.json({ available: false, reason: "no momentum or analyst coverage for this symbol" });
    }
    return NextResponse.json({ available: true, symbol: sym, rsi, grades });
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e.message || e) });
  }
}
