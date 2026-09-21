import { NextResponse } from "next/server";
import { getMovers } from "../moversLib";

const TTL = 5 * 60 * 1000;
let cached = null;

export async function GET() {
  if (cached && Date.now() - cached.at < TTL) return NextResponse.json(cached.data);
  const data = await getMovers();
  cached = { at: Date.now(), data };
  return NextResponse.json(data);
}
