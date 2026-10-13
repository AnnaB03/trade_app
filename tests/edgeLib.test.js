import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeStats, edgeReport, playbookVerdicts, closedTrades } from "../app/api/edgeLib.js";

const R = 100; // 1% of $10K
let t = 0;
const trade = (pnl, extra = {}) => ({ status: "closed", pnl, strategy: "ai", exitReasonTag: "trail_stop", entryAt: new Date(Date.UTC(2026, 9, 6, 14, 30 + t)).toISOString(), exitAt: new Date(Date.UTC(2026, 9, 6, 15, 30 + t++)).toISOString(), ...extra });

test("edgeStats: the statement numbers on a known set", () => {
  // Wins 300, 100; losses 100, 100 → net 200 over 4 trades.
  const s = edgeStats([trade(300), trade(-100), trade(-100), trade(100)], { rUsd: R });
  assert.equal(s.n, 4); assert.equal(s.winRate, 0.5);
  assert.equal(s.avgWin, 200); assert.equal(s.avgLoss, -100);
  assert.equal(s.profitFactor, 2, "gross wins 400 / gross losses 200");
  assert.equal(s.expectancyUsd, 50); assert.equal(s.expectancyR, 0.5);
  assert.equal(s.netUsd, 200); assert.equal(s.maxDrawdownUsd, 200, "300 peak, then two -100s");
  assert.equal(s.best, 300); assert.equal(s.worst, -100);
  assert.equal(s.avgHoldMin, 60);
});

test("edgeStats: no losses is an infinite profit factor; no trades is n=0", () => {
  assert.equal(edgeStats([trade(50), trade(20)], { rUsd: R }).profitFactor, Infinity);
  assert.deepEqual(edgeStats([], { rUsd: R }), { n: 0 });
});

test("closedTrades drops what is not a trade and sorts by close time", () => {
  const rows = [trade(10), { status: "open", pnl: 5 }, trade(null), trade(-5, { exitReasonTag: "orphaned" }), trade(-9, { excludeFromGoal: true }), trade(20)];
  assert.deepEqual(closedTrades(rows).map((r) => r.pnl), [10, 20]);
});

test("playbookVerdicts: judged on the last 20 only once there are 20, and stops a losing playbook", () => {
  const few = Array.from({ length: 19 }, () => trade(-50, { strategy: "intraday" }));
  const v1 = playbookVerdicts(closedTrades(few), { rUsd: R });
  assert.equal(v1.intraday.ok, true, "19 losers are not yet a verdict");
  assert.match(v1.intraday.reason, /19 of the 20/);
  const enough = [...few, trade(-50, { strategy: "intraday" })];
  const v2 = playbookVerdicts(closedTrades(enough), { rUsd: R });
  assert.equal(v2.intraday.ok, false);
  assert.match(v2.intraday.reason, /negative expectancy over its last 20/);
  assert.equal(v2.swing.ok, true, "the other playbook is untouched");
  // The recent record decides: 20 old losers followed by 20 winners is a working playbook.
  const turned = [...enough, ...Array.from({ length: 20 }, () => trade(40, { strategy: "intraday" }))];
  assert.equal(playbookVerdicts(closedTrades(turned), { rUsd: R }).intraday.ok, true);
});

test("edgeReport groups by playbook, hour, exit tag, symbol and catalyst, with a minimum sample", () => {
  const rows = [
    ...Array.from({ length: 12 }, () => trade(30, { symbol: "NVDA", catalyst: "earnings", exitReasonTag: "trail_stop" })),
    ...Array.from({ length: 3 }, () => trade(-60, { symbol: "MU", strategy: "intraday", catalyst: "intraday fade", exitReasonTag: "max_loss" })),
    trade(15, { strategy: null }),
  ];
  const r = edgeReport(rows, { rUsd: R, minN: 10 });
  assert.equal(r.overall.n, 16);
  const pb = Object.fromEntries(r.byPlaybook.map((g) => [g.key, g]));
  assert.equal(pb.swing.n, 12); assert.equal(pb.swing.enough, true);
  assert.equal(pb.intraday.n, 3); assert.equal(pb.intraday.enough, false, "three trades is a story, not a statistic");
  assert.equal(pb.manual.n, 1);
  assert.ok(r.byExitTag.find((g) => g.key === "max_loss").netUsd === -180);
  assert.ok(r.byHour.every((g) => /^\d\d:00 ET$/.test(g.key)));
  assert.equal(r.bySymbol[0].key, "NVDA", "largest group first");
  assert.ok(r.verdicts.swing.ok);
});
