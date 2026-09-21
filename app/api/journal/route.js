import { NextResponse } from "next/server";
import { listJournal } from "../store";

// Every REAL order this app placed (open -> close), auto-linked to its
// originating idea when there was one. See app/api/journalLib.js.
export async function GET() {
  return NextResponse.json({ entries: listJournal() });
}
