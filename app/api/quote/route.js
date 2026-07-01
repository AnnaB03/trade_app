import { NextResponse } from "next/server";
import { tradier, asArray } from "../tradier";

export async function GET(req) {
  const symbols = new URL(req.url).searchParams.get("symbols");
  if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbols)}`);
    return NextResponse.json({ quotes: asArray(d?.quotes?.quote) });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
