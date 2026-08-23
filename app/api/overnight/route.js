import { NextResponse } from "next/server";
import { extendedQuotes } from "../extended";

/* Overnight brief data: last extended-session (pre/post-market) trade per
   watchlist symbol vs the regular close. Headlines come from /api/news;
   the client combines the two. */
export async function GET(req) {
  const symbols = new URL(req.url).searchParams.get("symbols");
  if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
  try {
    const syms = symbols.split(",").map((s) => s.trim()).filter(Boolean);
    return NextResponse.json({ quotes: await extendedQuotes(syms) });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
