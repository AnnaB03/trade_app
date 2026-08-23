import { NextResponse } from "next/server";
import { fmpGet } from "../fmp";

/* Street price-target consensus (FMP). Context, not signal — shown as a muted
   strip on the symbol card. Degrades to { available:false } without a key. */

const TTL = 12 * 3600 * 1000;
const cache = new Map();

export async function GET(req) {
  const symbol = new URL(req.url).searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!process.env.FMP_API_KEY) {
    return NextResponse.json({ available: false, reason: "FMP_API_KEY not set" });
  }
  const sym = symbol.toUpperCase();
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json(hit.data);
  try {
    const rows = await fmpGet("price-target-consensus", { symbol: sym });
    const r = Array.isArray(rows) ? rows[0] : rows;
    const data = r?.targetConsensus
      ? { available: true, consensus: r.targetConsensus, median: r.targetMedian, high: r.targetHigh, low: r.targetLow }
      : { available: false, reason: "no analyst coverage" };
    cache.set(sym, { at: Date.now(), data });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e.message || e) });
  }
}
