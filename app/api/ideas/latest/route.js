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
    const all = listIdeas();
    /* The market analyst's ideas (strategy "news", newsIdeasLib.js): today's,
       newest per symbol and direction, shown in their own section. */
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dayOf = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const newsSeen = new Set(), news = [];
    for (const i of all) {
      if (i.strategy !== "news" || dayOf(i.createdAt) !== today) continue;
      const k = `${i.symbol}|${i.action}`;
      if (newsSeen.has(k)) continue;
      newsSeen.add(k); news.push(i);
    }
    const rows = all.filter((i) => i.strategy !== "contrarian" && i.strategy !== "fade_scan" && i.strategy !== "news");
    if (!rows.length) return NextResponse.json({ ideas: [], timestamp: null, news });
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
    return NextResponse.json({ ideas, news, timestamp: new Date(newest).toISOString(), count: ideas.length, source: "ledger" });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
