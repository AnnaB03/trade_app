import { test } from "node:test";
import assert from "node:assert/strict";
const s = await import("../app/api/scoreboardLib.js");

const row = (o) => ({ id: "x", ideaId: "secret-idea", entryOrderId: "ORD123", thesis: "private reasoning", broker: "sim-broker-xyz", accountId: "ACC1", ...o });
test("the public record carries trades and totals only, never ids, theses or account fields", () => {
  const b = s.buildScoreboard([
    row({ symbol: "QQQ", vehicle: "OPTION", optionType: "call", strike: 691, expiration: "2026-11-12", entryAt: "2026-11-11T16:27:29Z", entryFillPrice: 4.53, entryFilledQuantity: 1, exitAt: "2026-11-11T17:10:00Z", exitFillPrice: 5.4, exitReasonTag: "take_profit_usd", pnl: 86.3 }),
    row({ symbol: "AVGO", vehicle: "OPTION", optionType: "call", strike: 355, expiration: "2026-11-13", entryAt: "2026-11-11T16:50:23Z", entryFillPrice: 6.4, entryFilledQuantity: 1 }),
    row({ symbol: "OLD", vehicle: "SHARES", entryAt: "2026-10-20T15:00:00Z", entryFillPrice: 10, exitAt: "2026-10-20T16:00:00Z", exitFillPrice: 9, pnl: -100 }),
  ], { start: "2026-11-04", startBalance: 25000 });
  const text = JSON.stringify(b);
  for (const secret of ["secret-idea", "ORD123", "private reasoning", "ACC1", "sim-broker-xyz"]) assert.ok(!text.includes(secret), `leaks ${secret}`);
  assert.equal(b.trades.length, 2, "before the start date is left out");
  assert.equal(b.realized, 86.3);
  assert.equal(b.balance, 25086.3);
  assert.equal(b.trades.find((t) => t.symbol === "QQQ").why, "quick profit");
  assert.equal(b.trades.find((t) => t.symbol === "AVGO").open, true);
  assert.equal(b.paper, true);
  assert.match(b.note, /Paper trading/);
});
