import { NextResponse } from "next/server";
import { computeReality } from "../realityLib";

/* Reality check for one symbol: is the volume real, does news justify the
   move, and where are the halt bands. Cached 2 min per symbol. See
   ../realityLib.js for the shared computation (also used by /api/penny). */

const TTL = 2 * 60 * 1000;
const cache = new Map();

export async function GET(req) {
  const symbol = new URL(req.url).searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const sym = symbol.toUpperCase();

  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json(hit.data);

  try {
    const data = await computeReality(sym);
    cache.set(sym, { at: Date.now(), data });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e.message || e) });
  }
}
