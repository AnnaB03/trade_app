import { NextResponse } from "next/server";
import { listJournal } from "../store";
import { reconcileJournal } from "../journalReconcile";

// Every REAL order this app placed (open -> close), auto-linked to its
// originating idea when there was one. See app/api/journalLib.js. Reads
// fills / stop-outs / expired entries back from Tradier first (throttled),
// so autopilot trades close themselves out here — see journalReconcile.js.
export async function GET() {
  const reconcile = await reconcileJournal();
  return NextResponse.json({ entries: listJournal(), reconcile });
}
