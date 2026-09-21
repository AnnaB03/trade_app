import { NextResponse } from "next/server";
import { getMovers } from "../moversLib";
import { computeReality } from "../realityLib";

/* Penny stock scanner: today's biggest movers priced $0.10-$5, each run
   through the full reality check (RVOL, catalyst classification incl.
   dilution, halt bands) before it's shown as a candidate anywhere — a raw
   "up 80%" is close to meaningless for this category without that context.
   Capped small: this is a bounded number of extra FMP profile/float/news
   calls, and only the more informative candidates are worth the round trip.
   Cached 5 min, matching /api/movers. */

const TTL = 5 * 60 * 1000;
let cached = null;
const CANDIDATE_CAP = 6;

export async function GET() {
  if (cached && Date.now() - cached.at < TTL) return NextResponse.json(cached.data);

  const moversData = await getMovers();
  if (!moversData.available) {
    const data = { available: false, reason: moversData.reason || "FMP_API_KEY not set", candidates: [] };
    cached = { at: Date.now(), data };
    return NextResponse.json(data);
  }

  const picks = moversData.penny.slice(0, CANDIDATE_CAP);
  const candidates = (await Promise.all(
    picks.map(async (m) => {
      try {
        const r = await computeReality(m.symbol);
        return r.available ? { ...r, changePctSession: m.changePct } : null;
      } catch {
        return null;
      }
    })
  )).filter(Boolean);

  const data = { available: true, candidates };
  cached = { at: Date.now(), data };
  return NextResponse.json(data);
}
