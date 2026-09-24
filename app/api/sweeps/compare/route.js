import { NextResponse } from "next/server";
import { listIdeas, listJournal } from "../../store";
import { compareStrategies } from "../../compareLib";

// AI ideas vs the two sweep variants, side by side, from the same ledger and
// the same journal. ?days= window (default 60).
export async function GET(req) {
  const days = Math.min(365, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 60));
  return NextResponse.json(compareStrategies(listIdeas(), listJournal(), { days }));
}
