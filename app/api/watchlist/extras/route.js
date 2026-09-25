import { NextResponse } from "next/server";
import { listExtras, addExtra, removeExtra, pruneStale } from "../../watchExtrasLib";

/* The self-pruning "extras" watchlist — see watchExtrasLib.js for the
   eviction/staleness logic. GET returns the current list (and the CSV of
   symbols, for a cron's curl step to consume directly); POST adds one
   (evicting the stalest if full); DELETE removes one; POST with
   {"prune": true} runs the daily staleness sweep instead of adding. */

export async function GET() {
  const extras = listExtras();
  return NextResponse.json({ extras, symbols: extras.map((e) => e.symbol), csv: extras.map((e) => e.symbol).join(",") });
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }

  if (body?.prune === true) {
    const { kept, dropped } = pruneStale();
    return NextResponse.json({ pruned: dropped, extras: kept, symbols: kept.map((e) => e.symbol) });
  }

  const symbol = String(body?.symbol || "").trim().toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const result = addExtra(symbol, body?.reason || null);
  return NextResponse.json({ ...result, symbols: result.extras.map((e) => e.symbol) });
}

export async function DELETE(req) {
  const symbol = new URL(req.url).searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const extras = removeExtra(symbol);
  return NextResponse.json({ extras, symbols: extras.map((e) => e.symbol) });
}
