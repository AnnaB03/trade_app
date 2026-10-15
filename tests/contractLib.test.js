import { test } from "node:test";
import assert from "node:assert/strict";
const c = await import("../app/api/contractLib.js");

const mu = [
  { occ: "MU261021C00885000", strike: 885, expiration: "2026-10-21", dte: 6, bid: 25.6, ask: 30.4, delta: 0.55 }, // the idea's: 17% wide
  { occ: "MU261023C00880000", strike: 880, expiration: "2026-10-23", dte: 8, bid: 46.45, ask: 48.2, delta: 0.62 },
  { occ: "MU261023C00900000", strike: 900, expiration: "2026-10-23", dte: 8, bid: 35.5, ask: 37.6, delta: 0.57 },
  { occ: "MU261030C00900000", strike: 900, expiration: "2026-10-30", dte: 15, bid: 45.0, ask: 46.55, delta: 0.57 },
  { occ: "MU261016C00900000", strike: 900, expiration: "2026-10-16", dte: 1, bid: 20.85, ask: 21.15, delta: 0.61 }, // tightest, but tomorrow
  { occ: "MU261023C00960000", strike: 960, expiration: "2026-10-23", dte: 8, bid: 9.4, ask: 9.5, delta: 0.25 },   // tight, wrong delta
];

test("a wide-spread contract is switched to the tightest one carrying the same bet — 2026-10-15, MU", () => {
  const pick = c.pickLiquid(mu, { targetDelta: 0.55, currentSpreadPct: 17.1, minDte: 3, maxDte: 13, maxCost: 3750 });
  assert.equal(pick.occ, "MU261023C00900000", "same delta band, inside the expiry window, under the 15% cap");
  assert.ok(pick.spreadPct < 6);
});

test("never shorter than the idea needs, never the wrong delta, never over the position cap, never worse than now", () => {
  assert.equal(c.pickLiquid(mu, { targetDelta: 0.55, currentSpreadPct: 17, minDte: 3, maxDte: 20, maxCost: 3750 }).dte >= 3, true, "the 1-day contract is out for a swing idea");
  assert.notEqual(c.pickLiquid(mu, { targetDelta: 0.55, currentSpreadPct: 17, minDte: 3, maxDte: 20, maxCost: 3750 }).occ, "MU261023C00960000", "delta 0.25 is a different bet");
  assert.equal(c.pickLiquid(mu, { targetDelta: 0.55, currentSpreadPct: 17, minDte: 3, maxDte: 13, maxCost: 3000 }), null, "nothing tight enough under $3,000");
  assert.equal(c.pickLiquid(mu, { targetDelta: 0.55, currentSpreadPct: 3, minDte: 3, maxDte: 20, maxCost: 9999 }), null, "only ever a tighter one");
  assert.equal(c.SWITCH_SPREAD_PCT, 6);
  assert.equal(c.SWITCH_DELTA_BAND, 0.08);
});
