import { test } from "node:test";
import assert from "node:assert/strict";
import { trendRead, TREND_FROM_ET_MIN } from "../app/api/trendDayLib.js";

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
