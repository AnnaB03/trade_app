/* ---------- Strategy comparison: AI ideas vs liquidity sweeps ----------
   Two independent reads per strategy, because they answer different
   questions and can disagree:
   - LEDGER (every suggestion, graded at +1h / +1d / final by grade/route.js):
     "was the call right?" — cheap, large sample, point-in-time.
   - JOURNAL (every paper order actually placed): "what did the trade make?"
     — real fills, real stop-outs, and for the limit variant, real fill rate.
   Win rate over n < 5 is shown but flagged, never hidden. */
import { STRATEGIES } from "./sweepsLib";

const ACTIONABLE = ["CALL", "PUT", "BUY", "SELL"];
const R_CLAMP = 5; // same winsorizing as calibrationLib, for averages only
const clampR = (r) => Math.max(-R_CLAMP, Math.min(R_CLAMP, r));
const mean = (xs) => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;

function gradeStats(ideas, key) {
  const gs = ideas.map((i) => i.grades?.[key]).filter((g) => g && g.correct != null);
  const rs = gs.filter((g) => g.r != null).map((g) => clampR(g.r));
  return { n: gs.length, winRate: gs.length ? gs.filter((g) => g.correct).length / gs.length : null, avgR: mean(rs) };
}

export function compareStrategies(ideas, journal, { days = 60 } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const recentIdeas = ideas.filter((i) => ACTIONABLE.includes(i.action) && new Date(i.createdAt).getTime() >= cutoff);
  // Entries from before strategy tagging existed: an idea-linked one was an AI idea.
  const stratOf = (j) => j.strategy || (j.source === "idea" ? "ai" : null);
  const recentJournal = journal.filter((j) => stratOf(j) && new Date(j.entryAt || j.createdAt).getTime() >= cutoff);

  const rows = Object.entries(STRATEGIES).map(([key, label]) => {
    const mine = recentIdeas.filter((i) => (i.strategy || "ai") === key);
    const trades = recentJournal.filter((j) => stratOf(j) === key);
    const closed = trades.filter((j) => j.status === "closed");
    const pnls = closed.map((j) => Number(j.pnl)).filter(Number.isFinite);
    const rs = closed.map((j) => j.rMultiple).filter((r) => r != null).map(clampR);
    return {
      key, label,
      ledger: {
        suggested: mine.length,
        // limit-only: how many resting limits price ever reached
        filled: key === "sweep_limit" ? mine.filter((i) => i.filled).length : null,
        unfilled: key === "sweep_limit" ? mine.filter((i) => i.unfilled).length : null,
        pending: key === "sweep_limit" ? mine.filter((i) => i.pendingFill).length : null,
        h1: gradeStats(mine, "h1"), d1: gradeStats(mine, "d1"), final: gradeStats(mine, "final"),
      },
      journal: {
        placed: trades.length,
        open: trades.filter((j) => j.status === "open").length,
        unfilled: trades.filter((j) => j.status === "unfilled").length,
        closed: closed.length,
        stoppedOut: closed.filter((j) => j.exitReasonTag === "stop").length,
        winRate: pnls.length ? pnls.filter((p) => p > 0).length / pnls.length : null,
        totalPnl: pnls.length ? pnls.reduce((s, v) => s + v, 0) : null,
        avgR: mean(rs),
      },
    };
  });
  return { days, asOf: new Date().toISOString(), strategies: rows };
}
