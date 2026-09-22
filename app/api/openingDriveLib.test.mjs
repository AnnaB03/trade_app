import { test } from "node:test";
import assert from "node:assert/strict";
import { openingDrive, openingDriveText } from "./openingDriveLib.js";

// Fixed instants, so "isToday" and the pending/n/a cutoff are deterministic
// regardless of when this test actually runs. Times are ET wall-clock.
const DATE = "2026-06-15";
const at = (hhmm) => new Date(`${DATE}T${hhmm}:00-04:00`); // EDT in June

function fakeDeps({ bars = [], dataMode = () => "realtime", median = null, recorded = [] } = {}) {
  return {
    fetchBars: async () => bars,
    dataMode,
    medianAbsDrive: () => median,
    recordDrive: (symbol, date, drivePct) => recorded.push({ symbol, date, drivePct }),
    cache: new Map(), // fresh per test — no cross-test bleed
  };
}
const bar = (time, o, c) => ({ time: `${DATE}T${time}:00`, open: o, close: c, price: c });

test("openingDrive: before 10:00 ET with no 10:00 bar yet -> pending", async () => {
  const deps = fakeDeps({ bars: [bar("09:30", 100, 100.5), bar("09:35", 100.5, 100.7)] });
  const d = await openingDrive("TEST", { sessionDate: DATE, now: at("09:50"), deps });
  assert.equal(d.state, "pending");
  assert.equal(d.drivePct, null);
});

test("openingDrive: window still open (before 10:00 ET) is pending with no note, even in delayed mode", async () => {
  const deps = fakeDeps({ bars: [bar("09:30", 100, 100.5), bar("09:35", 100.5, 100.7)], dataMode: () => "delayed" });
  const d = await openingDrive("TEST", { sessionDate: DATE, now: at("09:50"), deps });
  assert.equal(d.state, "pending");
  assert.equal(d.note, null); // too early to say anything about the drive OR the feed lag
});

test("openingDrive: window closed but bar not in yet -> pending, with a sandbox-lag note only in delayed mode", async () => {
  const closedNoBar = fakeDeps({ bars: [], dataMode: () => "delayed" });
  const d = await openingDrive("TEST", { sessionDate: DATE, now: at("10:05"), deps: closedNoBar });
  assert.equal(d.state, "pending");
  assert.match(d.note, /delayed/i);

  const realtime = fakeDeps({ bars: [], dataMode: () => "realtime" });
  const d2 = await openingDrive("TEST2", { sessionDate: DATE, now: at("10:05"), deps: realtime });
  assert.equal(d2.state, "pending");
  assert.equal(d2.note, null);
});

test("openingDrive: well past 10:00 ET with still no bar -> n/a (no intraday data)", async () => {
  const deps = fakeDeps({ bars: [] });
  const d = await openingDrive("SPX", { sessionDate: DATE, now: at("10:30"), deps });
  assert.equal(d.state, "n/a");
});

test("openingDrive: a past (non-today) session with no bars -> n/a, never pending", async () => {
  const deps = fakeDeps({ bars: [] });
  const d = await openingDrive("TEST", { sessionDate: "2020-01-02", now: at("09:31"), deps });
  assert.equal(d.state, "n/a");
});

test("openingDrive: resolved strong-up drive, using history-based typical", async () => {
  const bars = [bar("09:30", 100, 100.2), bar("09:55", 100.5, 101.5)]; // open=100, at10(09:55 bar close)=101.5 -> +1.5%
  const deps = fakeDeps({ bars, median: 1.0 }); // typical 1.0% -> strength 1.5x -> strong
  const d = await openingDrive("TEST", { sessionDate: DATE, now: at("10:05"), deps });
  assert.equal(d.state, "strong up");
  assert.ok(Math.abs(d.drivePct - 1.5) < 1e-9);
  assert.ok(Math.abs(d.strength - 1.5) < 1e-9);
});

test("openingDrive: resolved drive with no history falls back to the flat 0.6% default", async () => {
  const bars = [bar("09:30", 100, 100.1), bar("09:55", 100.2, 100.3)]; // +0.3%, well under 0.6*0.5=0.3 boundary -> flat
  const deps = fakeDeps({ bars, median: null });
  const d = await openingDrive("TEST", { sessionDate: DATE, now: at("10:05"), deps });
  assert.equal(d.typical, 0.6);
  assert.equal(d.state, "flat");
});

test("openingDrive: a resolved TODAY session records to history; a past-date session does not", async () => {
  const bars = [bar("09:30", 100, 100), bar("09:55", 101, 102)]; // +2%
  const recordedToday = [];
  const dToday = await openingDrive("TEST", { sessionDate: DATE, now: at("10:05"), deps: fakeDeps({ bars, recorded: recordedToday }) });
  assert.equal(recordedToday.length, 1);
  assert.equal(recordedToday[0].symbol, "TEST");

  const recordedPast = [];
  await openingDrive("TEST", { sessionDate: "2020-01-02", now: at("10:05"), deps: fakeDeps({ bars, recorded: recordedPast }) });
  assert.equal(recordedPast.length, 0);
});

test("openingDrive: large gapPct is annotated as noisier, small gapPct is not", async () => {
  const bars = [bar("09:30", 100, 100), bar("09:55", 101, 102)];
  const noisy = await openingDrive("TEST", { sessionDate: DATE, now: at("10:05"), gapPct: 2.5, deps: fakeDeps({ bars }) });
  const clean = await openingDrive("TEST", { sessionDate: DATE, now: at("10:05"), gapPct: 0.3, deps: fakeDeps({ bars }) });
  assert.match(noisy.note, /post-gap/);
  assert.equal(clean.note, null);
});

test("openingDrive: a thrown fetch resolves to n/a, never throws", async () => {
  const deps = fakeDeps();
  deps.fetchBars = async () => { throw new Error("network down"); };
  const d = await openingDrive("TEST", { sessionDate: DATE, now: at("10:05"), deps });
  assert.equal(d.state, "n/a");
});

test("openingDrive: resolved results are cached and not refetched", async () => {
  let calls = 0;
  const deps = fakeDeps({ bars: [bar("09:30", 100, 100), bar("09:55", 101, 102)] });
  deps.fetchBars = async () => { calls++; return [bar("09:30", 100, 100), bar("09:55", 101, 102)]; };
  await openingDrive("TEST", { sessionDate: DATE, now: at("10:05"), deps });
  await openingDrive("TEST", { sessionDate: DATE, now: at("10:06"), deps });
  assert.equal(calls, 1);
});

test("openingDriveText: phrasing for each state", () => {
  assert.equal(openingDriveText(null), null);
  assert.equal(openingDriveText({ state: "n/a" }), null);
  assert.match(openingDriveText({ state: "pending", note: null }), /pending until 10:00 ET/);
  const txt = openingDriveText({ state: "strong up", drivePct: 1.23, strength: 1.8, note: null });
  assert.match(txt, /\+1\.2% by 10:00 \(strong up, 1\.8× its usual\)/);
  const withNote = openingDriveText({ state: "mild down", drivePct: -0.7, strength: 0.7, note: "post-gap; drive is noisier" });
  assert.match(withNote, /^opening drive -0\.7%.*mild down.*post-gap/);
});
