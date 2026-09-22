import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDrive, driveAlignment } from "./checks.js";

test("classifyDrive: null/non-finite input is n/a", () => {
  assert.deepEqual(classifyDrive(null, 0.6), { strength: null, state: "n/a" });
  assert.deepEqual(classifyDrive(undefined, 0.6), { strength: null, state: "n/a" });
  assert.deepEqual(classifyDrive(NaN, 0.6), { strength: null, state: "n/a" });
});

test("classifyDrive: below 0.5x typical is flat, regardless of sign", () => {
  assert.equal(classifyDrive(0.1, 1).state, "flat");
  assert.equal(classifyDrive(-0.4, 1).state, "flat");
  assert.equal(classifyDrive(0, 1).state, "flat");
});

test("classifyDrive: 0.5x-1x typical is mild, 1x+ is strong, sign sets direction", () => {
  assert.equal(classifyDrive(0.6, 1).state, "mild up");
  assert.equal(classifyDrive(-0.6, 1).state, "mild down");
  assert.equal(classifyDrive(1.2, 1).state, "strong up");
  assert.equal(classifyDrive(-1.2, 1).state, "strong down");
  assert.equal(classifyDrive(1.0, 1).state, "strong up"); // boundary is inclusive
});

test("classifyDrive: typical<=0 falls back to the flat default (0.6)", () => {
  const a = classifyDrive(0.9, 0);
  const b = classifyDrive(0.9, -1);
  assert.equal(a.state, "strong up"); // 0.9 / 0.6 = 1.5x
  assert.equal(b.state, "strong up");
  assert.ok(Math.abs(a.strength - 1.5) < 1e-9);
});

test("driveAlignment: no drive, n/a, or pending -> null", () => {
  assert.equal(driveAlignment(1, null), null);
  assert.equal(driveAlignment(1, { state: "n/a" }), null);
  assert.equal(driveAlignment(1, { state: "pending" }), null);
});

test("driveAlignment: flat drive -> 'flat' regardless of action direction", () => {
  assert.equal(driveAlignment(1, { state: "flat", drivePct: 0.1 }), "flat");
  assert.equal(driveAlignment(-1, { state: "flat", drivePct: -0.1 }), "flat");
  assert.equal(driveAlignment(0, { state: "flat", drivePct: 0 }), "flat");
});

test("driveAlignment: matching sign is 'with', opposite is 'against'", () => {
  assert.equal(driveAlignment(1, { state: "strong up", drivePct: 0.9 }), "with");
  assert.equal(driveAlignment(-1, { state: "strong up", drivePct: 0.9 }), "against");
  assert.equal(driveAlignment(-1, { state: "strong down", drivePct: -0.9 }), "with");
  assert.equal(driveAlignment(1, { state: "strong down", drivePct: -0.9 }), "against");
});

test("driveAlignment: no action direction (WAIT) -> null on a resolved, non-flat drive", () => {
  assert.equal(driveAlignment(0, { state: "strong up", drivePct: 0.9 }), null);
  assert.equal(driveAlignment(null, { state: "mild down", drivePct: -0.4 }), null);
});
