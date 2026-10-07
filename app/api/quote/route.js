import { NextResponse } from "next/server";
import { tradier, asArray, dataMode } from "../tradier";

export async function GET(req) {
  const p = new URL(req.url).searchParams;
  const symbols = p.get("symbols");
  if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbols)}`);
    return NextResponse.json({ quotes: asArray(d?.quotes?.quote), feed: dataMode() });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
