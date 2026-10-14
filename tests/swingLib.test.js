import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-swing-"));
process.env.STORE_FILE = path.join(tmp, "t.db");
const store = await import("../app/api/store.js");
const swing = await import("../app/api/swingLib.js");
after(() => { store._closeForTests(); fs.rmSync(tmp, { recursive: true, force: true }); });

// One synthetic session: price 100, every bar's high +0.2 and low -0.1.
const session = (day) => {
  const out = [];
  for (let m = 0; m <= 300; m++) {
    const h = 10 + Math.floor(m / 60), mm = m % 60;
    out.push({ time: `${day}T${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`, open: 100, high: 100.2, low: 99.9, close: 100 });
  }
  return out;
};

test("profileFromBars: the move up and down within the window, per entry", () => {
  const p = swing.profileFromBars([...session("2026-10-01"), ...session("2026-10-02")]);
  assert.equal(p.sessions, 2);
  assert.ok(p.n > 50);
  assert.ok(Math.abs(p.up.p90 - 0.2) < 1e-9, "a put loses to the move UP");
  assert.ok(Math.abs(p.down.p90 - 0.1) < 1e-9);
});

test("optionStopPct: the stock's adverse move expressed in the option's price", () => {
  // QQQ 10/19 $736 put on 2026-10-14: price 736, delta 0.48, premium 5.25.
  const qqq = { up: { p80: 0.21, p90: 0.29, p95: 0.38 }, down: { p80: 0.2, p90: 0.27, p95: 0.35 } };
  // floor: 8 shows the raw arithmetic; the live floor is 20% (2026-10-14).
  const stop = swing.optionStopPct({ optionType: "put", profile: qqq, price: 736, delta: -0.48, premium: 5.25, floor: 8 });
  assert.equal(stop, 19.5, "0.48 x 0.29% x 736 / 5.25");
  assert.ok(stop > 13.9, "outside the 13.9% dip that the flat 10% stop sold");
  // A call reads the DOWN side.
  assert.equal(swing.optionStopPct({ optionType: "call", profile: qqq, price: 736, delta: 0.48, premium: 5.25, floor: 8 }), 18.2);
  assert.equal(swing.optionStopPct({ optionType: "call", profile: qqq, price: 736, delta: 0.48, premium: 5.25 }), 20, "floored at 20%");
});

test("optionStopPct: floored, capped, and absent without a profile", () => {
  const quiet = { up: { p90: 0.01 }, down: { p90: 0.01 } };
  assert.equal(swing.optionStopPct({ optionType: "put", profile: quiet, price: 100, delta: 0.5, premium: 5 }), swing.STOP_FLOOR_PCT);
  const wild = { up: { p90: 5 }, down: { p90: 5 } };
  assert.equal(swing.optionStopPct({ optionType: "put", profile: wild, price: 100, delta: 0.5, premium: 1 }), swing.STOP_CAP_PCT);
  assert.equal(swing.optionStopPct({ optionType: "put", profile: null, price: 100, delta: 0.5, premium: 1 }), null);
});
