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
const closed = (pnl, exitAt = new Date().toISOString(), extra = {}) => ({ status: "closed", pnl, exitAt, createdAt: exitAt, ...extra });
const noBaseline = { freshStartAt: null, freshStartMs: 0 };

test("realized P&L today sums closed rows booked today in New York, nothing else", () => {
  const rows = [
    closed(-150), closed(-80), closed(40),
    closed(-999, "2026-01-05T20:00:00Z"),                    // another day
    { status: "open", pnl: -500, exitAt: null },             // not booked
    closed(null),                                            // orphaned, no P&L
    closed(-700, new Date().toISOString(), { legacy: true }), // before the fresh start
  ];
  assert.equal(risk.realizedPnlToday(rows, { today, baseline: noBaseline }), -190);
});

test("the limit is a share of the account", () => {
  assert.equal(risk.DAILY_LOSS_LIMIT_PCT, 3);
  assert.equal(risk.dailyLossLimitUsd(10000), 300);
  assert.equal(risk.dailyLossLimitUsd(undefined), 0, "no account, no limit");
});

test("evaluateHalt: trips at the limit, not before, and says why", () => {
  assert.deepEqual(risk.evaluateHalt({ stored: null, lossToday: -299, limitUsd: 300, today }), { halted: false });
  const v = risk.evaluateHalt({ stored: null, lossToday: -300, limitUsd: 300, today });
  assert.equal(v.halted, true);
  assert.equal(v.kind, "daily_loss");
  assert.ok(v.fresh, "a fresh trip asks the caller to record it");
  assert.match(v.reason, /\$300 daily loss limit/);
  assert.deepEqual(risk.evaluateHalt({ stored: null, lossToday: -5000, limitUsd: 0, today }), { halted: false }, "a zero limit is off");
});

test("evaluateHalt: a stored daily halt holds for its day and expires the next", () => {
  const stored = { halted: true, kind: "daily_loss", day: today, reason: "down", since: "x" };
  assert.equal(risk.evaluateHalt({ stored, lossToday: 0, limitUsd: 300, today }).halted, true, "still today, even if P&L moved");
  const v = risk.evaluateHalt({ stored, lossToday: 0, limitUsd: 300, today: "2099-01-01" });
  assert.equal(v.halted, false);
  assert.equal(v.expired, true);
});

test("evaluateHalt: a manual halt never expires on its own", () => {
  const stored = { halted: true, kind: "manual", reason: "earnings week", since: "x" };
  const v = risk.evaluateHalt({ stored, lossToday: 500, limitUsd: 300, today: "2099-01-01" });
  assert.equal(v.halted, true);
  assert.equal(v.kind, "manual");
  assert.equal(v.reason, "earnings week");
});

test("tradingHalt: records a fresh daily halt, clears an expired one, and the manual switch round-trips", () => {
  assert.equal(risk.tradingHalt({ accountSize: 10000, journal: [] }).halted, false);
  // Trip it.
  const tripped = risk.tradingHalt({ accountSize: 10000, journal: [closed(-200), closed(-150)] });
  assert.equal(tripped.halted, true);
  assert.equal(tripped.lossToday, -350);
  assert.equal(risk.readHalt().kind, "daily_loss");
  assert.equal(risk.readHalt().day, today);
  // The next session: expired and cleared, even with yesterday's rows still there.
  const tomorrow = new Date(Date.now() + 36 * 3600000);
  const next = risk.tradingHalt({ accountSize: 10000, journal: [closed(-200), closed(-150)], now: tomorrow });
  assert.equal(next.halted, false);
  assert.equal(risk.readHalt(), null);
  // Manual.
  risk.haltTrading("earnings week");
  assert.equal(risk.tradingHalt({ accountSize: 10000, journal: [] }).reason, "earnings week");
  risk.resumeTrading();
  assert.equal(risk.tradingHalt({ accountSize: 10000, journal: [] }).halted, false);
});
