import { test } from "node:test";
import assert from "node:assert/strict";
// A cash account, whatever the caller's environment says (.env.local runs margin).
delete process.env.SIM_ACCOUNT_TYPE;
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

test("margin: sale proceeds can buy again at once", async () => {
  const now = new Date("2026-10-13T18:00:00Z");
  const legs = [fill("buy_to_open", 5, 1, "2026-10-13T14:00:00Z"), fill("sell_to_close", 6, 1, "2026-10-13T15:00:00Z")];
  const cash = cashState(state(legs), now, "cash"), margin = cashState(state(legs), now, "margin");
  assert.equal(cash.unsettled, 600 - 0.35);
  assert.equal(margin.unsettled, 0);
  assert.ok(Math.abs(margin.available - (10000 + 100 - 0.70)) < 1e-6);
});

test("day trades: opened and closed the same session, counted over five business days", async () => {
  const { dayTradeCount } = await import("../app/api/simBroker.js");
  const now = new Date("2026-10-13T18:00:00Z"); // a Tuesday
  const legs = [
    fill("buy_to_open", 5, 1, "2026-10-13T14:00:00Z"), fill("sell_to_close", 6, 1, "2026-10-13T15:00:00Z"), // 1
    fill("buy_to_open", 5, 1, "2026-10-12T14:00:00Z"), fill("sell_to_close", 6, 1, "2026-10-13T14:30:00Z"), // held overnight: not one
    fill("buy_to_open", 5, 1, "2026-10-07T14:00:00Z"), fill("sell_to_close", 6, 1, "2026-10-07T15:00:00Z"), // 2 (Wed, inside the window)
    fill("buy_to_open", 5, 1, "2026-10-06T14:00:00Z"), fill("sell_to_close", 6, 1, "2026-10-06T15:00:00Z"), // outside it
  ];
  assert.equal(dayTradeCount(state(legs), now), 2);
});

test("pattern day trader rule: three day trades under $25,000, then no new positions", async () => {
  const { pdtVerdict } = await import("../app/api/simBroker.js");
  assert.deepEqual(pdtVerdict({ accountType: "cash", equity: 5000, dayTrades: 9 }), { ok: true, restricted: false }, "a cash account has no such rule");
  assert.deepEqual(pdtVerdict({ accountType: "margin", equity: 25000, dayTrades: 40 }), { ok: true, restricted: false }, "at or above the line, unlimited");
  assert.deepEqual(pdtVerdict({ accountType: "margin", equity: 24999, dayTrades: 2 }), { ok: true, restricted: true, dayTradesLeft: 1 });
  const v = pdtVerdict({ accountType: "margin", equity: 24124, dayTrades: 3 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /pattern day trader/);
});
