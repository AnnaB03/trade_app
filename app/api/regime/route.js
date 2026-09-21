import { NextResponse } from "next/server";
import { marketRegime } from "../regimeLib";

// Market regime is shared across every viewer and doesn't change fast — cache
// 5 min server-side so the Ideas tab and Watchlist banner don't each trigger
// a fresh SPY/QQQ/IWM/VIX read every 30s poll.
const TTL = 5 * 60 * 1000;
let cached = null;

export async function GET() {
  if (cached && Date.now() - cached.at < TTL) return NextResponse.json(cached.data);
  const data = await marketRegime();
  cached = { at: Date.now(), data };
  return NextResponse.json(data);
}
