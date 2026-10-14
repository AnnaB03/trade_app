import { NextResponse } from "next/server";
import { listIdeas } from "../../store";

/* The most recent idea refresh, read from the ledger — no model call, no cost.

   The Ideas tab used to make its own billed /api/suggestions call each time it
   was opened, on an old six-symbol list kept in the browser and on its own
   schedule, so it never showed the scheduled refreshes the automation actually
   trades from (2026-10-14: "refresh did not happen, I just manually
   refreshed" — it had, at 12:12). A refresh writes every idea within a few
   seconds; the newest group of rows is that refresh. Derived rows (the fade,
   the fade scan) are not the model's ideas and are left out. */
const BATCH_WINDOW_MS = 30 * 60000; // one refresh slot

export async function GET() {
  try {
    const rows = listIdeas().filter((i) => i.strategy !== "contrarian" && i.strategy !== "fade_scan");
    if (!rows.length) return NextResponse.json({ ideas: [], timestamp: null });
    const newest = new Date(rows[0].createdAt).getTime(); // listIdeas is newest first
    /* Two refreshes can land minutes apart (a scheduled one and a click), and
       each covers its own list, so a fixed window merged them into duplicates.
       Instead: each symbol's own newest read, per playbook, from the last
       refresh window — the current view of every name, once. */
    const seen = new Set(), ideas = [];
    for (const i of rows) {
      if (newest - new Date(i.createdAt).getTime() > BATCH_WINDOW_MS) break;
      const k = `${i.symbol}|${i.strategy || "swing"}`;
      if (seen.has(k)) continue;
      seen.add(k); ideas.push(i);
    }
    return NextResponse.json({ ideas, timestamp: new Date(newest).toISOString(), count: ideas.length, source: "ledger" });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
