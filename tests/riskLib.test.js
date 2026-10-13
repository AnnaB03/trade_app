import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-risk-"));
process.env.STORE_FILE = path.join(tmp, "test.db");
const store = await import("../app/api/store.js");
const risk = await import("../app/api/riskLib.js");
after(() => { store._closeForTests(); fs.rmSync(tmp, { recursive: true, force: true }); });

const today = risk.dateET();
let seq = 0;
// Closed today, in the order given (each a minute later than the last).
const closed = (pnl, extra = {}) => ({ status: "closed", pnl, exitAt: new Date(Date.now() - 60000 * (500 - seq++)).toISOString(), createdAt: "2026-10-01T14:00:00Z", ...extra });
const noBaseline = { freshStartAt: null, freshStartMs: 0 };
const L = risk.planLimits(10000);

test("planLimits: the plan in dollars for a $10K account", () => {
  assert.deepEqual({ loss: L.lossLimitUsd, goal: L.goalUsd, lock: L.profitLockUsd, streak: L.maxStreak, giveback: L.givebackPct }, { loss: 500, goal: 100, lock: 200, streak: 3, giveback: 50 });
  assert.equal(risk.dailyLossLimitUsd(10000), 500);
  assert.equal(risk.dailyLossLimitUsd(undefined), 0, "no account, no limit");
});

test("dayStats: realized, the running peak, and the losing streak, in close order", () => {
  const rows = [
    closed(80), closed(70),            // +150, peak 150
    closed(-100), closed(-60),         // +(-10), streak 2
    closed(-999, { exitAt: "2026-01-05T20:00:00Z" }),   // another day
    { status: "open", pnl: -500, exitAt: null },       // not booked
    closed(null),                                      // no P&L
    closed(-700, { legacy: true }),                    // before the fresh start
    closed(-5, { exitReasonTag: "orphaned" }),         // not a trade
    closed(-40, { excludeFromGoal: true }),
  ];
  const d = risk.dayStats(rows, { today, baseline: noBaseline });
  assert.deepEqual(d, { realized: -10, peak: 150, streak: 2, closes: 4, wins: 2, losses: 2 });
  assert.equal(risk.realizedPnlToday(rows, { today, baseline: noBaseline }), -10);
});

test("dayStats: a winner resets the streak; a scratch does not count as a loss", () => {
  const d = risk.dayStats([closed(-50), closed(-50), closed(0), closed(-50)], { today, baseline: noBaseline });
  assert.equal(d.streak, 1, "the $0 scratch broke the streak");
  assert.equal(d.losses, 3);
});

const ev = (day, stored = null) => risk.evaluateHalt({ stored, day, limits: L, today });
const D = (o) => ({ realized: 0, peak: 0, streak: 0, closes: 0, wins: 0, losses: 0, ...o });

test("daily_loss: trips at the limit, not before, and says why", () => {
  assert.deepEqual(ev(D({ realized: -499 })), { halted: false });
  const v = ev(D({ realized: -500 }));
  assert.equal(v.kind, "daily_loss"); assert.ok(v.fresh); assert.match(v.reason, /\$500 daily loss limit/);
});

test("loss_streak: three in a row stops the day even when the dollars are small", () => {
  assert.deepEqual(ev(D({ realized: -90, streak: 2 })), { halted: false });
  const v = ev(D({ realized: -90, streak: 3 }));
  assert.equal(v.kind, "loss_streak"); assert.match(v.reason, /3 losing trades in a row/);
});

test("profit_lock: twice the goal banks the day", () => {
  assert.deepEqual(ev(D({ realized: 199, peak: 199 })), { halted: false });
  const v = ev(D({ realized: 200, peak: 200 }));
  assert.equal(v.kind, "profit_lock"); assert.match(v.reason, /\$200 profit lock/);
});

test("day_giveback: once the goal was reached, giving back half the peak stops", () => {
  // Peaked +$150 (past the $100 goal), now +$80: kept 53%, still trading.
  assert.deepEqual(ev(D({ realized: 80, peak: 150 })), { halted: false });
  // Now +$75: exactly half given back.
  const v = ev(D({ realized: 75, peak: 150 }));
  assert.equal(v.kind, "day_giveback"); assert.match(v.reason, /peaked at \$150/);
  // A peak that never reached the goal is not protected: +$60 to +$20 keeps trading.
  assert.deepEqual(ev(D({ realized: 20, peak: 60 })), { halted: false });
});

test("precedence: a loss rule is reported before a profit rule", () => {
  // Up big, then three straight losers: the streak is what stops it.
  assert.equal(ev(D({ realized: 250, peak: 400, streak: 3 })).kind, "loss_streak");
});

test("a stored automatic halt holds for its day and lapses the next; a manual one never lapses", () => {
  for (const kind of ["daily_loss", "loss_streak", "profit_lock", "day_giveback"]) {
    const stored = { halted: true, kind, day: today, reason: "r", since: "x" };
    assert.equal(ev(D({}), stored).halted, true, `${kind} holds today even with a flat day`);
    const v = risk.evaluateHalt({ stored, day: D({}), limits: L, today: "2099-01-01" });
    assert.deepEqual(v, { halted: false, expired: true });
  }
  const manual = { halted: true, kind: "manual", reason: "earnings week", since: "x" };
  assert.equal(risk.evaluateHalt({ stored: manual, day: D({ realized: 500 }), limits: L, today: "2099-01-01" }).reason, "earnings week");
});

test("a lapsed halt does not hide today's own figures", () => {
  const stored = { halted: true, kind: "profit_lock", day: "2026-01-01", reason: "y", since: "x" };
  const v = ev(D({ realized: -600 }), stored);
  assert.equal(v.kind, "daily_loss"); assert.ok(v.fresh); assert.ok(v.expired);
});

test("a rule set to 0% is off", () => {
  const off = { ...L, profitLockUsd: 0, goalUsd: 0, maxStreak: 0, lossLimitUsd: 0 };
  assert.deepEqual(risk.evaluateHalt({ stored: null, day: D({ realized: -5000, streak: 9, peak: 9000 }), limits: off, today }), { halted: false });
});

test("tradingHalt: records a fresh halt with its time, clears a lapsed one, and the manual switch round-trips", () => {
  assert.equal(risk.tradingHalt({ accountSize: 10000, journal: [] }).halted, false);
  assert.equal(risk.tradingHalt({ accountSize: 10000, journal: [closed(-300), closed(-190)] }).halted, false, "-$490 is inside the line");
  const tripped = risk.tradingHalt({ accountSize: 10000, journal: [closed(-300), closed(-250)] });
  assert.equal(tripped.kind, "daily_loss");
  assert.equal(tripped.day.realized, -550);
  assert.equal(tripped.lossToday, -550, "older field name still answered");
  assert.equal(tripped.limits.lossLimitUsd, 500);
  assert.equal(tripped.since, risk.readHalt().since, "the tripping call reports the recorded time");
  const tomorrow = new Date(Date.now() + 36 * 3600000);
  assert.equal(risk.tradingHalt({ accountSize: 10000, journal: [closed(-300), closed(-250)], now: tomorrow }).halted, false);
  assert.equal(risk.readHalt(), null);
  risk.haltTrading("earnings week");
  assert.equal(risk.tradingHalt({ accountSize: 10000, journal: [] }).reason, "earnings week");
  risk.resumeTrading();
  assert.equal(risk.tradingHalt({ accountSize: 10000, journal: [] }).halted, false);
});
