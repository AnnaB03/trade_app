import { test } from "node:test";
import assert from "node:assert/strict";
import { trendRead, TREND_FROM_ET_MIN, breadthOf, modelActions } from "../app/api/trendDayLib.js";

const at = (h, m) => h * 60 + m;

test("trend day: 10-30 shape — QQQ and SPY down together, ideas all puts", () => {
  const r = trendRead({ qqq: { open: 697.21, last: 688.96 }, spy: { open: 761.38, last: 755.3 }, actions: ["PUT", "PUT", "PUT", "PUT"], etMinutes: at(11, 0) });
  assert.equal(r.flag, "trend_down");
  assert.match(r.label, /Likely trend day down/);
});

test("trend day: nothing is called before 10:30", () => {
  assert.equal(TREND_FROM_ET_MIN, 630);
  const r = trendRead({ qqq: { open: 700, last: 690 }, spy: { open: 760, last: 750 }, actions: ["PUT"], etMinutes: at(10, 15) });
  assert.equal(r.flag, "too_early");
});

test("trend day: a big QQQ move with SPY flat or the ideas split is only a lean or nothing", () => {
  assert.equal(trendRead({ qqq: { open: 700, last: 692 }, spy: { open: 760, last: 759 }, actions: ["PUT", "PUT"], etMinutes: at(11, 0) }).flag, "none", "SPY barely moved");
  assert.equal(trendRead({ qqq: { open: 700, last: 692 }, spy: { open: 760, last: 754 }, actions: ["PUT", "CALL"], etMinutes: at(11, 0) }).flag, "lean_down", "ideas split 1 of 2");
  assert.equal(trendRead({ qqq: { open: 700, last: 701 }, spy: { open: 760, last: 760.5 }, actions: [], etMinutes: at(11, 0) }).flag, "none");
  assert.equal(trendRead({ qqq: {}, spy: {}, etMinutes: at(11, 0) }).flag, "no_data");
});

test("breadth counts stocks 1%+ down or up since the open", () => {
  assert.deepEqual(breadthOf([{ open: 100, last: 98 }, { open: 50, last: 50.2 }, { open: 10, last: 10.2 }, { open: 0, last: 5 }]), { total: 3, down: 1, up: 1 });
  assert.deepEqual(breadthOf([]), { total: 0, down: 0, up: 0 });
});

test("BUG 2026-11-02: the trend read counts the model's own ideas, not the fades that bet against the move", () => {
  const day = "2026-11-02", at = (h) => `2026-11-02T${h}:00.000Z`;
  const ideas = [
    { symbol: "QQQ", action: "PUT", createdAt: at("18:44") },                          // swing (no tag)
    { symbol: "QQQ", action: "CALL", strategy: "contrarian", createdAt: at("19:19") },  // a fade, newer
    { symbol: "INTC", action: "PUT", strategy: "intraday", createdAt: at("18:40") },
    { symbol: "INTC", action: "CALL", strategy: "contrarian", createdAt: at("19:18") },
    { symbol: "SOFI", action: "BUY", strategy: "dip", createdAt: at("18:20") },
    { symbol: "MU", action: "WAIT", createdAt: at("18:44") },
    { symbol: "NVDA", action: "PUT", createdAt: "2026-10-30T15:00:00.000Z" },          // another day
  ];
  assert.deepEqual(modelActions(ideas, day).sort(), ["PUT", "PUT"]);
});
