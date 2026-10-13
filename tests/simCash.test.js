import { test } from "node:test";
import assert from "node:assert/strict";
const { cashState } = await import("../app/api/simBroker.js");

const fill = (side, price, qty, when, opt = true) => ({
  status: "filled", side, option_symbol: opt ? "X261106C00100000" : null, symbol: "X",
  quantity: qty, exec_quantity: qty, avg_fill_price: price, commission: opt ? 0.35 * qty : 0, transaction_date: when,
});
const state = (legs, extra = {}) => ({ startCash: 10000, orders: [{ id: 1, legs }], ...extra });

test("a deposit is settled cash at once, and the account reports what it was funded with", () => {
  const c = cashState(state([], { deposits: [{ at: "2026-10-13T17:40:00Z", amount: 15000 }] }), new Date("2026-10-13T18:00:00Z"));
  assert.equal(c.startCash, 25000);
  assert.equal(c.openedWith, 10000);
  assert.equal(c.available, 25000);
  assert.equal(c.unsettled, 0);
});

test("today's sale proceeds stay locked; a deposit does not unlock them", () => {
  const now = new Date("2026-10-13T18:00:00Z");
  const legs = [fill("buy_to_open", 5, 1, "2026-10-13T14:00:00Z"), fill("sell_to_close", 6, 1, "2026-10-13T15:00:00Z")];
  const before = cashState(state(legs), now);
  assert.equal(before.available, 10000 - 500.35, "the buy is spent, the sale is not usable yet");
  assert.equal(before.unsettled, 600 - 0.35);
  const after = cashState(state(legs, { deposits: [{ amount: 15000 }] }), now);
  assert.equal(after.available, before.available + 15000);
  assert.equal(after.unsettled, before.unsettled, "still waiting for tomorrow");
  const tomorrow = cashState(state(legs, { deposits: [{ amount: 15000 }] }), new Date("2026-10-14T14:00:00Z"));
  assert.equal(tomorrow.unsettled, 0);
  assert.ok(Math.abs(tomorrow.available - (25000 + 100 - 0.70)) < 1e-6);
});
