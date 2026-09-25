import { NextResponse } from "next/server";
import { tradier } from "../../tradier";
import { findOpenJournalEntry } from "../../store";
import { scanSweeps, DEFAULT_SWEEP_SYMS } from "../../sweepsLib";
import { placeShares, liveQuote } from "../../order/autotradeLib";
import { reconcileJournal } from "../../journalReconcile";

/* Paper-only autopilot for the liquidity-sweep detector — the sibling of
   /api/order/autotrade (AI ideas), built so the two can be compared on real
   sandbox fills. Runs a fresh scan (no LLM, so it's fine to call every few
   minutes), then places each logged setup through the SAME placeShares path
   the AI autopilot uses: same limit-order + bracket-stop OTO, same sizing
   rounding, same journal write, same one-open-position-per-symbol rule
   (across both strategies — the sandbox account holds one net position per
   symbol, so two strategies can't hold UBER independently).

   - sweep_limit: the entry limit sits UNDER the market and rests for the
     day (duration=day). Whether it ever fills is the experiment; an order
     that expires unfilled is journaled as "unfilled" by journalReconcile.
   - sweep_reclaim: bought at the live price right now, only while fresh.
   Only during regular hours; ?dryRun=true shows what it would do. */

const MIN_CONVICTION = 3;

export async function GET(req) {
  const p = new URL(req.url).searchParams;
  const dryRun = p.get("dryRun") === "true";
  const minConviction = Number(p.get("minConviction")) || MIN_CONVICTION;
  const symbols = p.get("symbols") ? p.get("symbols").split(",") : DEFAULT_SWEEP_SYMS;
  const account = Number(p.get("account")) > 0 ? Number(p.get("account")) : (Number(process.env.ACCOUNT_SIZE) > 0 ? Number(process.env.ACCOUNT_SIZE) : 1000);
  // Paper money: an expensive name whose single share is most of the account
  // still gets traded (rounded up to 1 share), unless explicitly turned off.
  const allowUnaffordable = p.get("allowUnaffordable") !== "false";
  const only = p.get("strategies") ? p.get("strategies").split(",") : ["sweep_limit", "sweep_reclaim"];

  let marketState = "unknown";
  try { marketState = (await tradier("/markets/clock"))?.clock?.state || "unknown"; } catch {}

  try {
    const reconcile = await reconcileJournal();
    const scan = await scanSweeps({ symbols, account, log: true, marketState });
    if (marketState !== "open" && !dryRun) {
      return NextResponse.json({ marketState, placed: 0, skipped: 0, results: [], reconcile, note: `Market is ${marketState} — scanned and logged, placed nothing.` });
    }

    const results = [];
    for (const row of scan.symbols) {
      for (const idea of row.setups || []) {
        const tag = { symbol: idea.symbol, strategy: idea.strategy, ideaId: idea.id, entry: idea.entryPrice, stop: idea.invalidation, target: idea.target };
        if (!only.includes(idea.strategy)) { results.push({ ...tag, placed: false, reason: "Strategy not selected for this run." }); continue; }
        if (!idea.id) { results.push({ ...tag, placed: false, reason: idea.setup?.ok ? "Not logged to the ledger." : `Setup filtered (trend ${idea.setup?.trend}, or too far above the level).` }); continue; }
        if (Number(idea.conviction) < minConviction) { results.push({ ...tag, placed: false, reason: `Conviction ${idea.conviction} below the ${minConviction} bar (this symbol's own backtest for this variant is weak, or R:R < 1).` }); continue; }
        if (idea.strategy === "sweep_limit" && idea.filled) { results.push({ ...tag, placed: false, reason: "Price already traded through this limit today — too late to rest an order there." }); continue; }
        const dup = findOpenJournalEntry((r) => r.symbol === idea.symbol);
        if (dup) { results.push({ ...tag, placed: false, reason: `Already have an open paper position/order in ${idea.symbol} (${dup.strategy || "ai"}, from ${dup.createdAt}) — not stacking another.` }); continue; }

        let toPlace = idea;
        if (idea.strategy === "sweep_reclaim") {
          const live = await liveQuote(idea.symbol);
          if (live == null) { results.push({ ...tag, placed: false, reason: "Couldn't get a live quote." }); continue; }
          if (!(live > idea.setup.level)) { results.push({ ...tag, placed: false, reason: `Live $${live} is back under the $${idea.setup.level} level — reclaim failed.` }); continue; }
          toPlace = { ...idea, entryPrice: live };
        }
        const r = await placeShares(toPlace, { dryRun, allowUnaffordable });
        results.push({ ...tag, ...r });
      }
    }

    return NextResponse.json({
      dryRun, marketState, asOf: scan.asOf,
      placed: results.filter((r) => r.placed).length,
      skipped: results.filter((r) => !r.placed).length,
      results, reconcile,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
