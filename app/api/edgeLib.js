/* ---------- Edge: what the realized record says about each way of trading ----------
   The Track Record tab grades IDEAS (did the price go the right way). This
   grades TRADES: what the book actually banked, net of fees, from the
   journal's closed rows. Those are different questions, and only the second
   one pays. Measured the way a trader reads a statement:

   - expectancy  = average P&L per trade, in dollars and in R (one R is the
                   most one trade may lose: 1% of the account). The number
                   that decides whether a playbook is worth running at all.
   - profit factor = gross wins / gross losses. Under 1 loses money; a
                   durable edge for a discretionary book is usually 1.3+.
   - win rate and average win / average loss, because the same expectancy
                   can come from 70% small winners or 35% big ones, and they
                   feel very different to sit through.
   - max drawdown  of the cumulative P&L in close order: how deep the hole
                   got on the way to the total.

   Cut by playbook (swing / intraday / manual), entry hour, exit reason,
   symbol and catalyst. Groups under minN are shown with their n and no
   verdict: ten trades is a story, not a statistic. Pure functions; the
   /api/edge route feeds them the journal. */

const PLAYBOOK = (r) => (r.strategy === "intraday" ? "intraday" : r.strategy ? "swing" : "manual");
const hourET = (iso) => Number(new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit" })) % 24;

// Closed rows with a booked number, oldest close first.
export function closedTrades(rows) {
  return rows
    .filter((r) => r.status === "closed" && typeof r.pnl === "number" && r.exitReasonTag !== "orphaned" && !r.excludeFromGoal && r.exitAt)
    .sort((a, b) => new Date(a.exitAt) - new Date(b.exitAt));
}

export function edgeStats(trades, { rUsd }) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0), losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((s, v) => s + v, 0), grossLoss = -losses.reduce((s, v) => s + v, 0);
  const net = pnls.reduce((s, v) => s + v, 0);
  let cum = 0, peak = 0, maxDD = 0;
  for (const p of pnls) { cum += p; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }
  const holds = trades.map((t) => (t.entryAt && t.exitAt ? (new Date(t.exitAt) - new Date(t.entryAt)) / 60000 : null)).filter((m) => m != null && m >= 0);
  const expectancyUsd = net / n;
  return {
    n, wins: wins.length, losses: losses.length, winRate: wins.length / n,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    netUsd: net, expectancyUsd,
    expectancyR: rUsd > 0 ? expectancyUsd / rUsd : null,
    maxDrawdownUsd: maxDD,
    best: Math.max(...pnls), worst: Math.min(...pnls),
    avgHoldMin: holds.length ? holds.reduce((s, v) => s + v, 0) / holds.length : null,
  };
}

function groups(trades, keyFn, { rUsd, minN }) {
  const m = new Map();
  for (const t of trades) { const k = keyFn(t); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  return [...m.entries()]
    .map(([key, rows]) => ({ key: String(key), ...edgeStats(rows, { rUsd }), enough: rows.length >= minN }))
    .sort((a, b) => b.n - a.n);
}

export function edgeReport(rows, { rUsd, minN = 10, lastN = 20 } = {}) {
  const trades = closedTrades(rows);
  const opt = { rUsd, minN };
  return {
    rUsd, minN, lastN,
    overall: edgeStats(trades, { rUsd }),
    recent: edgeStats(trades.slice(-lastN), { rUsd }),
    byPlaybook: groups(trades, PLAYBOOK, opt),
    byVehicle: groups(trades, (t) => t.vehicle || null, opt),
    byExitTag: groups(trades, (t) => t.exitReasonTag || "unknown", opt),
    byHour: groups(trades, (t) => (t.entryAt ? `${String(hourET(t.entryAt)).padStart(2, "0")}:00 ET` : null), opt).sort((a, b) => a.key.localeCompare(b.key)),
    bySymbol: groups(trades, (t) => t.symbol || null, opt),
    byCatalyst: groups(trades, (t) => t.catalyst || null, opt),
    // Learning mode: trades taken over a soft rule against trades that passed
    // every rule, and per rule overridden (a trade can count under several).
    byEntryStyle: groups(trades, (t) => t.entryStyle || null, opt), // the entry-confirmation test
    byLearning: groups(trades, (t) => (t.learningOverrides?.length ? "rule overridden" : "all rules passed"), opt),
    byOverriddenRule: groups(trades.flatMap((t) => (t.learningOverrides || []).map((o) => ({ ...t, __rule: o.rule }))), (t) => t.__rule, opt),
    verdicts: playbookVerdicts(trades, { rUsd, lastN: Math.max(lastN, minN), minN: Math.max(lastN, minN) }),
  };
}

/* The gate: is each playbook still worth running? Judged on its LAST lastN
   closed trades (the recent record, not the lifetime one — a playbook that
   worked in September and stopped in October should stop trading in
   October), and only once there are at least minN of them. Negative
   expectancy = not ok. A playbook with too few trades is ok by default:
   the record has to be earned before it can be judged. */
export function playbookVerdicts(trades, { rUsd, lastN = 20, minN = 20 } = {}) {
  const out = {};
  for (const pb of ["swing", "intraday", "manual"]) {
    const mine = trades.filter((t) => PLAYBOOK(t) === pb);
    const recent = mine.slice(-lastN);
    const s = edgeStats(recent, { rUsd });
    if (recent.length < minN) { out[pb] = { ok: true, n: recent.length, needed: minN, reason: `${recent.length} of the ${minN} closed trades needed to judge it` }; continue; }
    const ok = s.expectancyUsd >= 0;
    out[pb] = {
      ok, n: s.n, expectancyR: s.expectancyR, expectancyUsd: s.expectancyUsd, profitFactor: s.profitFactor, winRate: s.winRate,
      reason: ok
        ? `last ${s.n}: ${(s.expectancyR ?? 0) >= 0 ? "+" : ""}${(s.expectancyR ?? 0).toFixed(2)}R per trade, profit factor ${s.profitFactor === Infinity ? "∞" : s.profitFactor?.toFixed(2)}`
        : `negative expectancy over its last ${s.n} closed trades (${s.expectancyR.toFixed(2)}R per trade, profit factor ${s.profitFactor?.toFixed(2)}, ${(s.winRate * 100).toFixed(0)}% winners) — this playbook is losing money as currently traded`,
    };
  }
  return out;
}

export const playbookOf = PLAYBOOK;

/* ---------- The edge throttle ----------
   Replaces the edge GATE's hard stop, 2026-10-14 (the owner: "find a better
   solution"). The gate stopped a playbook once its last 20 closed trades lost
   money — and then it could never come back: with no new trades, the last 20
   never change, so a stopped playbook stayed stopped for good. It tripped that
   afternoon on 20 trades made mostly under rules since replaced, and refused
   four puts that had passed every other check.

   A trader in a drawdown trades smaller and keeps measuring. So the recent
   record now sets the SIZE, never zero:
     not enough trades to judge, or expectancy >= 0   -> full risk
     expectancy between 0 and -0.25R a trade          -> half risk
     expectancy below -0.25R a trade                  -> quarter risk
   The daily loss limit (riskLib) is still the hard stop. */
export const THROTTLE_HALF_BELOW_R = 0;
export const THROTTLE_QUARTER_BELOW_R = -0.25;

export function edgeRiskMultiplier(verdict) {
  if (!verdict || verdict.n == null || (verdict.needed != null && verdict.n < verdict.needed)) return { mult: 1, label: "full size — not enough trades yet to judge" };
  const e = Number(verdict.expectancyR);
  if (!Number.isFinite(e) || e >= THROTTLE_HALF_BELOW_R) return { mult: 1, label: "full size" };
  if (e >= THROTTLE_QUARTER_BELOW_R) return { mult: 0.5, label: `half size — last ${verdict.n} trades ${e.toFixed(2)}R each` };
  return { mult: 0.25, label: `quarter size — last ${verdict.n} trades ${e.toFixed(2)}R each` };
}
