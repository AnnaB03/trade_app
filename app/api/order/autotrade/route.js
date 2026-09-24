import { NextResponse } from "next/server";
import { tradier, asArray } from "../../tradier";
import { listIdeas, findOpenJournalEntry } from "../../store";
import { liveQuote, placeOption, placeShares } from "../autotradeLib";

/* Paper-only autopilot: scans the most recent Ideas refresh, places the
   qualifying ones straight into the Tradier SANDBOX account (hard-locked to
   paper money in tradeClient.js — see order/common.js), and skips the rest
   with a stated reason. Built so the Cockpit's suggestions can be tested as
   REAL (simulated) fills over time — real slippage, real bracket mechanics,
   real duplicate-avoidance — instead of only the point-in-time grading in
   gradeLib.js, which never touches an actual order.

   Deliberately conservative about what it will place on its own:
   - conviction >= MIN_CONVICTION
   - only ONE open position per symbol at a time — the same idea reappearing
     on the next refresh (which is normal, see NOK/NVDA) is a re-affirmation
     of an existing paper position, not a reason to stack another one
   - never auto-acknowledges a gate warning (wide spread, big-risk ack) —
     those exist to make a human stop and look, so an idea that trips one is
     skipped and reported, never forced through
   - does NOT skip options or share positions over the account's
     affordability caps: this is paper money, and the point is to see how
     every suggestion plays out, expensive ones included. The sizing badge
     still shows the figure. Pass allowUnaffordable=false to re-enable the
     cap (e.g. rehearsing size discipline on a real-sized account).

   Trigger checking is LIVE, not batch-cached — this is the fix for a real
   gap: this route used to trust the `triggered` flag computed once, back
   when the idea was generated. Called only every couple of hours (to avoid
   paying for a full AI refresh every time), that meant a fast intraday
   breakout-and-reversal between calls was invisible — the price could cross
   the trigger and fall back before the next check ever looked, and the
   trade that should have fired never would. A conditional idea now gets its
   OWN fresh quote at call time, independent of how old the batch is, so
   calling this route often and cheaply (no LLM involved) actually closes
   the gap instead of just narrowing it. A non-conditional idea (already
   live the moment it was generated) still uses the batch-level staleness
   check below, since there's no live re-check that makes sense for "is this
   thesis still good," only for "has this price level been crossed." */

const MIN_CONVICTION = 3;
const BATCH_WINDOW_MS = 15000; // ideas from one refresh land within ~ms of each other
const MAX_BATCH_AGE_MIN = 20; // non-conditional ideas: reject a batch older than this
const DEFAULT_TRIGGER_STALE_MIN = 120; // conditional ideas with no staleMinutes of their own

function latestBatch(ideas) {
  if (!ideas.length) return [];
  const t0 = new Date(ideas[0].createdAt).getTime(); // list() is newest-first
  return ideas.filter((i) => t0 - new Date(i.createdAt).getTime() <= BATCH_WINDOW_MS);
}

export async function GET(req) {
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "true";
  const allowUnaffordable = params.get("allowUnaffordable") !== "false"; // paper: on by default
  const minConviction = Number(params.get("minConviction")) || MIN_CONVICTION;

  try {
    // AI ideas only — the sweep detector logs into the same ledger (tagged
    // `strategy`) and has its own autopilot at /api/sweeps/autotrade; a
    // sweep scan landing last must not become this route's "latest batch".
    const all = listIdeas().filter((i) => !i.strategy);
    const batch = latestBatch(all);
    if (!batch.length) return NextResponse.json({ error: "No ideas in the ledger yet — refresh the Ideas tab first." }, { status: 404 });
    const batchAgeMin = (Date.now() - new Date(batch[0].createdAt).getTime()) / 60000;

    // Conditional ideas (have a triggerPrice) get a fresh quote right now,
    // independent of batch age — see the file header for why. Fetched once
    // per unique symbol, not per idea.
    const conditionalSyms = [...new Set(
      batch.filter((i) => ["CALL", "PUT", "BUY", "SELL"].includes(i.action) && i.triggerPrice != null && i.triggerDirection).map((i) => i.symbol)
    )];
    const liveBySym = Object.fromEntries(await Promise.all(conditionalSyms.map(async (s) => [s, await liveQuote(s)])));

    const results = [];
    for (const rawIdea of batch) {
      const tag = { symbol: rawIdea.symbol, action: rawIdea.action, vehicle: rawIdea.vehicle, risk: rawIdea.risk, ideaId: rawIdea.id };
      if (!["CALL", "PUT", "BUY", "SELL"].includes(rawIdea.action)) { results.push({ ...tag, placed: false, reason: "WAIT — nothing to trade." }); continue; }
      if (Number(rawIdea.conviction) < minConviction) { results.push({ ...tag, placed: false, reason: `Conviction ${rawIdea.conviction} below the ${minConviction} bar.` }); continue; }
      // No risk-rating filter: HIGH is 78% of every actionable idea ever
      // logged (90% of options specifically) — the rulebook calls a
      // short-dated option HIGH structurally, regardless of setup quality,
      // so excluding it here meant almost nothing but shares ever traded.
      // That's a real dollar-risk gate with nothing to protect in a paper
      // account; risk still shows in every result/journal entry to review.

      let idea = rawIdea;
      const hasTrigger = idea.triggerPrice != null && idea.triggerDirection;
      if (hasTrigger) {
        // Own staleness window (the model's own "good for N minutes" call on
        // this specific setup) — falls back to a flat default if it didn't
        // set one. A trigger firing on a setup this old is a coincidence,
        // not a confirmation of anything still true about the thesis.
        const ageMin = (Date.now() - new Date(idea.createdAt).getTime()) / 60000;
        const maxAge = Number(idea.staleMinutes) > 0 ? Number(idea.staleMinutes) : DEFAULT_TRIGGER_STALE_MIN;
        if (ageMin > maxAge) { results.push({ ...tag, placed: false, reason: `Setup is ${ageMin.toFixed(0)} min old, past its own ${maxAge}-min staleness window — not acting on a trigger this late.` }); continue; }
        const live = liveBySym[idea.symbol];
        if (live == null) { results.push({ ...tag, placed: false, reason: "Couldn't get a live quote to check the trigger." }); continue; }
        const nowTriggered = idea.triggerDirection === "above" ? live >= idea.triggerPrice : live <= idea.triggerPrice;
        if (!nowTriggered) { results.push({ ...tag, placed: false, reason: `Not triggered — live $${live} vs needs to go ${idea.triggerDirection} $${idea.triggerPrice}.` }); continue; }
        // Trade off the live price, not the stale one from generation time —
        // that's what actually crossed the trigger just now.
        idea = { ...idea, entryPrice: live };
        // The contract's own premium drifts too over a multi-hour gap
        // between checks — re-quote it rather than submit a limit order at
        // whatever it cost when the idea was first generated.
        if (idea.vehicle === "OPTION" && idea.leg?.occ) {
          const legQuote = await tradier(`/markets/quotes?symbols=${encodeURIComponent(idea.leg.occ)}`).catch(() => null);
          const q = asArray(legQuote?.quotes?.quote)?.[0];
          const bid = Number(q?.bid), ask = Number(q?.ask);
          const mid = bid >= 0 && ask > 0 ? (bid + ask) / 2 : (Number(q?.last) || null);
          if (mid > 0) idea = { ...idea, leg: { ...idea.leg, bid, ask, mid } };
        }
      } else if (batchAgeMin > MAX_BATCH_AGE_MIN) {
        // No trigger to re-check live — this is already a "buy now" idea, so
        // its staleness is about the whole batch/thesis, not one price level.
        results.push({ ...tag, placed: false, reason: `Idea batch is ${batchAgeMin.toFixed(0)} min old — too stale to trade on without a live re-check. Refresh Ideas first.` });
        continue;
      }

      if (idea.vehicle === "OPTION" && idea.affordable === false && !allowUnaffordable) { results.push({ ...tag, placed: false, reason: "Contract cost is over the account's affordability cap." }); continue; }

      const dup = findOpenJournalEntry((r) => r.symbol === idea.symbol);
      if (dup) { results.push({ ...tag, placed: false, reason: `Already have an open paper position in ${idea.symbol} (from ${dup.createdAt}) — not stacking another.` }); continue; }

      let r;
      if (idea.vehicle === "OPTION") r = await placeOption(idea, { dryRun });
      else if (idea.vehicle === "SHARES") r = await placeShares(idea, { dryRun, allowUnaffordable });
      else r = { placed: false, reason: `Unhandled vehicle: ${idea.vehicle}` };
      results.push({ ...tag, ...r });
    }

    return NextResponse.json({
      dryRun, batchSize: batch.length, batchAsOf: batch[0]?.createdAt,
      placed: results.filter((r) => r.placed).length,
      skipped: results.filter((r) => !r.placed).length,
      results,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
