import { NextResponse } from "next/server";
import { tradier, asArray } from "../tradier";
import { listIdeas, updateIdea } from "../store";
import { CHECKPOINTS, gradeAt, isFinalDue, isGradable, gradeStart } from "../gradeLib";
import { resolvePendingLimits } from "../sweepsLib";
import { computeCalibration } from "../calibrationLib";

/* Runs a grading pass over every idea due for a checkpoint (h1, d1, or its
   expiration-aware final), then returns the full idea history + calibration.
   Cheap to call often: grading only fetches one quote per symbol that
   actually has something due. Called from the Ideas tab and the History
   panel on mount — there is no cron in this build, so "on view" is the
   trigger. See app/api/store.js for the persistence caveat. */

async function quoteFor(symbol) {
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const q = asArray(d?.quotes?.quote)?.[0];
    return q?.last != null ? Number(q.last) : null;
  } catch {
    return null;
  }
}

export async function GET(req) {
  try {
    // How many days of ledger history the Track Record tab actually gets to
    // see. Used to be a flat 200-row cap — on a day with heavy refresh
    // activity (300+ ideas is normal) that didn't even cover TODAY, let
    // alone the "at least 2 days" this is meant to guarantee. Date-windowed
    // instead of row-capped, so volume on a busy day can't silently push
    // older-but-still-recent ideas out of view. Storage itself (ideas.json)
    // was never the limit — this only fixes what got served back out.
    const days = Math.min(30, Math.max(2, Number(new URL(req.url).searchParams.get("days")) || 3));
    const windowStart = Date.now() - days * 86400000;
    // Sweep limit ideas waiting on a touch get resolved (filled / unfilled)
    // before grading, so a fill is graded from its own start time.
    try { await resolvePendingLimits(); } catch {}
    const ideas = listIdeas();
    const now = Date.now();
    const due = ideas.filter((idea) => {
      if (!isGradable(idea)) return false;
      const age = now - gradeStart(idea);
      const cpDue = CHECKPOINTS.some((cp) => age >= cp.afterMs && !idea.grades?.[cp.key]);
      return cpDue || isFinalDue(idea, now);
    });

    // One quote per distinct symbol among the due ideas, not one per idea.
    const symbols = [...new Set(due.map((i) => i.symbol))];
    const priceBySym = Object.fromEntries(await Promise.all(symbols.map(async (s) => [s, await quoteFor(s)])));

    let gradedCount = 0;
    for (const idea of due) {
      const px = priceBySym[idea.symbol];
      if (px == null) continue;
      const g = gradeAt(idea, px);
      if (!g) continue;
      const patch = { grades: { ...idea.grades } };
      const age = now - gradeStart(idea);
      for (const cp of CHECKPOINTS) {
        if (age >= cp.afterMs && !idea.grades?.[cp.key]) patch.grades[cp.key] = g;
      }
      if (isFinalDue(idea, now)) patch.grades.final = g;
      updateIdea(idea.id, patch);
      gradedCount++;
    }

    const refreshed = listIdeas();
    const calibration = computeCalibration(refreshed);
    // Safety cap well above what "days" normally implies, purely to bound
    // response size on a truly extreme day — the date window above is the
    // real limit day-to-day, this just prevents a runaway payload.
    const windowed = refreshed.filter((i) => new Date(i.createdAt).getTime() >= windowStart).slice(0, 2000);
    return NextResponse.json({ gradedCount, ideas: windowed, days, calibration });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
