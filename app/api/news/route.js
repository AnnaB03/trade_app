import { NextResponse } from "next/server";
import { fetchStockNews } from "../fmp";

export async function GET(req) {
  const symbols = new URL(req.url).searchParams.get("symbols");
  if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
  const limit = new URL(req.url).searchParams.get("limit") || "5";
  const result = await fetchStockNews(symbols.split(",").map(s => s.trim()).filter(Boolean), limit);
  return NextResponse.json(result);
}
