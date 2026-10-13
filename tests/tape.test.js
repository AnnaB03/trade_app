import { test } from "node:test";
import assert from "node:assert/strict";
import { vwap, atr, tapeRead, tapeLine, ATR_USED_MAX_PCT } from "../app/lib/tape.js";

const bar = (o, h, l, c, v) => ({ open: o, high: h, low: l, close: c, volume: v });

test("vwap weights the typical price by volume", () => {
  // bar 1 typical 10, vol 100; bar 2 typical 20, vol 300 → (1000 + 6000) / 400 = 17.5
  assert.equal(vwap([bar(9, 11, 9, 10, 100), bar(19, 21, 19, 20, 300)]), 17.5);
  assert.equal(vwap([bar(9, 11, 9, 10, 0)]), null, "no volume, no VWAP");
});

test("atr is the average true range over the last n complete days, gaps included", () => {
  const days = [
    { high: 102, low: 98, close: 100 },
    { high: 103, low: 99, close: 101 },   // TR 4
    { high: 110, low: 106, close: 108 },  // gap up: TR = max(4, |110-101|=9, |106-101|=5) = 9
    { high: 109, low: 105, close: 106 },  // TR = max(4, 1, 3) = 4
  ];
  assert.equal(atr(days, 14), (4 + 9 + 4) / 3);
  assert.equal(atr(days, 2), 6.5, "window of the last two");
  assert.equal(atr([days[0]], 14), null);
});

test("tapeRead: VWAP side, opening range, and range used against the ATR", () => {
  const bars = [
    bar(100, 101, 99.5, 100.5, 1000), bar(100.5, 101.2, 100.2, 101, 800), bar(101, 101.5, 100.8, 101.3, 700),
    bar(101.3, 101.4, 100.9, 101.1, 500), bar(101.1, 101.3, 100.7, 100.9, 400), bar(100.9, 101.0, 100.4, 100.6, 600), // 6 bars = opening range
    bar(100.6, 102.5, 100.5, 102.3, 1500), // breakout bar
  ];
  const priorDaily = Array.from({ length: 15 }, (_, i) => ({ date: `2026-09-${String(10 + i).padStart(2, "0")}`, high: 101, low: 99, close: 100 })); // ATR 2
  const t = tapeRead({ bars, priorDaily, last: 102.3 });
  assert.equal(t.bars, 7);
  assert.equal(t.side, "above");
  assert.ok(t.vwap > 100 && t.vwap < 102.3);
  assert.deepEqual(t.openingRange, { high: 101.5, low: 99.5, complete: true });
  assert.equal(t.orPosition, "above", "trading above the first half hour's high");
  assert.equal(t.atr14, 2);
  assert.equal(t.dayHigh, 102.5); assert.equal(t.dayLow, 99.5);
  assert.equal(t.rangeUsedPct, 150, "a $3 range on a $2 ATR: the move is mostly done");
  assert.ok(t.rangeUsedPct >= ATR_USED_MAX_PCT, "this is what the continuation gate refuses");
  assert.ok(Math.abs(t.fromOpenPct - 2.3) < 0.01);
  assert.match(tapeLine("TEST", t), /above VWAP/);
  assert.match(tapeLine("TEST", t), /150% of a normal day/);
  assert.match(tapeLine("TEST", t), /EXTENDED/);
});

test("tapeRead: a quiet morning inside the opening range, still forming", () => {
  const bars = [bar(50, 50.4, 49.8, 50.1, 300), bar(50.1, 50.3, 49.9, 50.0, 200)];
  const priorDaily = Array.from({ length: 15 }, (_, i) => ({ date: `d${i}`, high: 51, low: 49, close: 50 }));
  const t = tapeRead({ bars, priorDaily, last: 50.0 });
  assert.equal(t.openingRange.complete, false);
  assert.equal(t.orPosition, "inside");
  assert.ok(Math.abs(t.rangeUsedPct - 30) < 1e-9);
  assert.doesNotMatch(tapeLine("Q", t), /EXTENDED/);
  assert.match(tapeLine("Q", null), /unavailable/);
});
