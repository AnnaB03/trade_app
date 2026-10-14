import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exitConfig, updatePeak, gainFigures, decideProfitExit, decideLevelExit, decideReversalExit,
  latestIdeaForSymbol, intrinsicAtExpiry, directionOf, heldQuantity,
  TRAIL_ARM_PCT, TRAIL_GIVEBACK_PCT, HARD_TAKE_PROFIT_PCT, EOD_FLAT_FROM_ET_MIN, HARD_LOSS_PCT,
} from "../app/api/order/exitRules.js";

/* The cases here are the trades named in the rule comments. Each test states
   the figures the route would have fetched and asserts which rule fires, so
   a threshold change shows its effect on the real record before it trades. */

const CFG = exitConfig(10000); // the $10K working account
const at15 = EOD_FLAT_FROM_ET_MIN;

// Build the figures the way the route does, from a premium path.
function figures({ vehicle = "OPTION", entry, peak, mark, qty = 1, dir = 1 }) {
  return { vehicle, entryPremium: entry, peakMark: peak, markNow: mark, ...gainFigures({ vehicle, dir, markNow: mark, entryPremium: entry, peakMark: peak, qty }) };
}

test("exitConfig scales the dollar bars with the account", () => {
  const ref = exitConfig(99000);
  assert.equal(ref.eodTakeProfitUsd, 200);
  assert.equal(ref.trailTightenUsd, 2000);
  assert.equal(ref.maxLossUsd, 990);
  assert.ok(Math.abs(CFG.eodTakeProfitUsd - 20.2) < 0.01, "$200 at $99K is ~$20 at $10K");
  assert.equal(CFG.maxLossUsd, 100, "1% of $10K");
  assert.equal(exitConfig(undefined).account, 99000, "no account = the reference account");
});

test("NVDA $225c: $3.13 -> $8.78 peak is banked by the 150% ceiling before any trail", () => {
  // +180% at the peak clears the outright ceiling; the trail never gets a say.
  const f = figures({ entry: 3.13, peak: 8.78, mark: 8.78 });
  assert.equal(decideProfitExit(CFG, f).tag, "take_profit");
});

test("NVDA $225c: sliding from $8.78 — the trail fires at 25% giveback of the peak gain", () => {
  // One contract on the $99K reference account, where a +$565 peak gain is
  // under the $2,000 tighten bar. Peak gain +181%; keep at least 135%;
  // $7.10 is +127%, through the band.
  const ref = exitConfig(99000);
  const slid = figures({ entry: 3.13, peak: 8.78, mark: 7.10 });
  const exit = decideProfitExit(ref, slid);
  assert.equal(exit.tag, "trail_stop");
  assert.match(exit.detail, /25% giveback/);
  // Still above the band: +140% ($7.51) holds.
  assert.equal(decideProfitExit(ref, figures({ entry: 3.13, peak: 8.78, mark: 7.51 })), null);
  // On the $10K account the same +$565 clears its ~$202 tighten bar, so the
  // band is 15% (keep 154%) and $7.51 is already through it.
  assert.match(decideProfitExit(CFG, figures({ entry: 3.13, peak: 8.78, mark: 7.51 })).detail, /tightened/);
});

test("the trail arms at +5% for options and does nothing below it", () => {
  // Peaked +4%, now flat: not armed, no exit.
  assert.equal(decideProfitExit(CFG, figures({ entry: 10, peak: 10.4, mark: 10 })), null);
  // Peaked +5%, gave back all of it: armed, 25% giveback of 5% keeps 3.75%, 0% is through it.
  assert.equal(decideProfitExit(CFG, figures({ entry: 10, peak: 10.5, mark: 10 })).tag, "trail_stop");
  assert.equal(TRAIL_ARM_PCT.OPTION, 5);
  assert.equal(TRAIL_GIVEBACK_PCT, 25);
});

test("a position still climbing never trips the trail", () => {
  // mark == peak: gain equals peak gain, nothing given back.
  assert.equal(decideProfitExit(CFG, figures({ entry: 3.05, peak: 6.10, mark: 6.10 })), null);
});

test("NVDA 10/07 $232.50c (25 contracts): a peak gain past the tighten bar halves the band", () => {
  // $3.05 -> $6.10 is +100% / +$7,625 on 25 contracts; at $99K the band is 15%, keep 85%.
  const ref = exitConfig(99000);
  const held = figures({ entry: 3.05, peak: 6.10, mark: 5.80, qty: 25 }); // +90%: inside a 15% band
  assert.equal(decideProfitExit(ref, held), null);
  const gaveBack = figures({ entry: 3.05, peak: 6.10, mark: 5.60, qty: 25 }); // +83.6%: through 85%
  const exit = decideProfitExit(ref, gaveBack);
  assert.equal(exit.tag, "trail_stop");
  assert.match(exit.detail, /tightened/);
  // The 25% band would have let it fall to +75% ($5.34) — the $2,288 giveback the rule exists to stop.
  assert.equal(decideProfitExit(ref, figures({ entry: 3.05, peak: 6.10, mark: 5.34, qty: 25 })).tag, "trail_stop");
});

test("max loss: 1% of the account at the bid closes a multi-day position whatever its own levels say", () => {
  // INTC put, four contracts, -$436: over the $100 line at $10K. The dollar
  // rule is reported first when it is the larger loss.
  const f = figures({ entry: 2.00, peak: 2.00, mark: 0.91, qty: 4 }); // -$436
  assert.equal(decideProfitExit(CFG, f).tag, "max_loss");
  // Inside the dollar line but 12% down: since 2026-10-14 the option stop takes it.
  assert.equal(decideProfitExit(CFG, figures({ entry: 2.00, peak: 2.00, mark: 1.76, qty: 4 })).tag, "premium_stop"); // -12%, -$96
  // Inside both: holds.
  assert.equal(decideProfitExit(CFG, figures({ entry: 2.00, peak: 2.00, mark: 1.84, qty: 4 })), null); // -8%, -$64
});

test("a tiny option position is cut on percentage even though the dollars never reach the account rule", () => {
  // -90% on a $50 contract is $45: the dollar rule never fires, the option stop does.
  const f = figures({ entry: 0.50, peak: 0.50, mark: 0.05, qty: 1 });
  assert.equal(decideProfitExit(CFG, f).tag, "premium_stop");
});

test("short-dated (closeByEod) contract: +7% is taken outright, before the trail", () => {
  // MU 10/9 $1082.50c: $19.25 -> $21.10 is +9.6%.
  const f = figures({ entry: 19.25, peak: 21.10, mark: 21.10 });
  assert.equal(decideProfitExit(CFG, { ...f, closeByEod: true }).tag, "quick_target");
  // The same figures on a multi-day position: still climbing, no exit.
  assert.equal(decideProfitExit(CFG, f), null);
});

test("short-dated contract goes flat from 15:45 ET on the eod pass, win or lose", () => {
  // -6%: inside the option stop, so this is about the close rule alone.
  const loser = figures({ entry: 5, peak: 5, mark: 4.7 });
  assert.equal(decideProfitExit(CFG, { ...loser, closeByEod: true, eod: true, nowEtMinutes: at15 }).tag, "eod_flat");
  assert.equal(decideProfitExit(CFG, { ...loser, closeByEod: true, eod: true, nowEtMinutes: at15 - 1 }), null, "15:44 is not yet the close");
  assert.equal(decideProfitExit(CFG, { ...loser, closeByEod: true, eod: false, nowEtMinutes: at15 }), null, "only on the eod sweep");
});

test("end-of-day bar banks a dollar gain that is invisible as a percentage", () => {
  // FEIM-style: a big share position up 2.7% is real money.
  const f = figures({ vehicle: "SHARES", entry: 24.33, peak: 25.0, mark: 25.0, qty: 1000 }); // +$670 / +2.75%
  assert.equal(decideProfitExit(CFG, f), null, "no rule on an ordinary pass");
  const eod = decideProfitExit(CFG, { ...f, eod: true, nowEtMinutes: at15 });
  assert.equal(eod.tag, "eod_take_profit");
  // Below the bar it carries overnight. At $10K the bar is ~$20.
  const small = figures({ vehicle: "SHARES", entry: 100, peak: 100.1, mark: 100.1, qty: 10 }); // +$1
  assert.equal(decideProfitExit(CFG, { ...small, eod: true, nowEtMinutes: at15 }), null);
});

test("shares: the trail arms at +15% and the ceiling is +60%", () => {
  assert.equal(TRAIL_ARM_PCT.SHARES, 15);
  assert.equal(HARD_TAKE_PROFIT_PCT.SHARES, 60);
  assert.equal(decideProfitExit(CFG, figures({ vehicle: "SHARES", entry: 10, peak: 11.4, mark: 10 })), null, "+14% peak: not armed");
  assert.equal(decideProfitExit(CFG, figures({ vehicle: "SHARES", entry: 10, peak: 11.5, mark: 10.5 })).tag, "trail_stop");
  assert.equal(decideProfitExit(CFG, figures({ vehicle: "SHARES", entry: 10, peak: 16, mark: 16 })).tag, "take_profit");
});

test("a put gains when its premium rises, even though its underlying direction is -1", () => {
  // This was null for every put once: the trail never armed and the ceiling never fired.
  const f = figures({ entry: 2, peak: 5.2, mark: 5.2, dir: -1 });
  assert.equal(f.gainPct, 160);
  assert.equal(decideProfitExit(CFG, f).tag, "take_profit");
});

test("short shares have no gain figure and are left to the level rules", () => {
  const f = gainFigures({ vehicle: "SHARES", dir: -1, markNow: 9, entryPremium: 10, peakMark: 10, qty: 100 });
  assert.equal(f.gainPct, null);
});

test("peak: a position entered today ignores the day high printed before it", () => {
  // SPCX 10/30 $167.50c bought at $7.75 on a day the contract had traded $8.775.
  assert.equal(updatePeak({ previousPeak: null, markNow: 7.75, dayHigh: 8.775, spread: 0.1, enteredToday: true }), 7.75);
  // Held from yesterday: the day high counts, less the spread (a last-trade print is not a bid).
  assert.equal(updatePeak({ previousPeak: null, markNow: 7.75, dayHigh: 8.775, spread: 0.1, enteredToday: false }), 8.675);
  // A stored peak is never lowered.
  assert.equal(updatePeak({ previousPeak: 9, markNow: 7.75, dayHigh: 8.775, spread: 0, enteredToday: false }), 9);
  // A new high mark raises it.
  assert.equal(updatePeak({ previousPeak: 9, markNow: 9.5, dayHigh: 8.775, spread: 0, enteredToday: false }), 9.5);
});

test("target counts the day's favorable extreme; invalidation only the live price", () => {
  // NVDA hit $233.21 against a $232 target, then pulled back to $230.
  assert.equal(decideLevelExit({ dir: 1, target: 232, invalidation: 225, underlyingPx: 230, favorableExtreme: 233.21 }).tag, "target");
  // A wick through invalidation that has recovered is NOT a loss: $228.465 low vs $228.50, price back at $230.87.
  assert.equal(decideLevelExit({ dir: 1, target: 240, invalidation: 228.5, underlyingPx: 230.87, favorableExtreme: 231 }), null);
  // Live price through it is.
  assert.equal(decideLevelExit({ dir: 1, target: 240, invalidation: 228.5, underlyingPx: 228.4, favorableExtreme: 231 }).tag, "invalidation");
  // Mirror image for a put / short.
  assert.equal(decideLevelExit({ dir: -1, target: 100, invalidation: 110, underlyingPx: 104, favorableExtreme: 99.8 }).tag, "target");
  assert.equal(decideLevelExit({ dir: -1, target: 100, invalidation: 110, underlyingPx: 110.5, favorableExtreme: 104 }).tag, "invalidation");
});

test("an intraday target is judged on the live price, not the day's extreme", () => {
  // A fade's target sits inside today's range; the day high was through it before entry.
  assert.equal(decideLevelExit({ dir: -1, strategy: "intraday", target: 140, invalidation: 143, underlyingPx: 141, favorableExtreme: 139 }), null);
  assert.equal(decideLevelExit({ dir: -1, strategy: "intraday", target: 140, invalidation: 143, underlyingPx: 139.9, favorableExtreme: 139 }).tag, "target");
});

test("reversal: only a read written AFTER the position's own thesis can overturn it", () => {
  const now = Date.parse("2026-10-02T18:14:00Z");
  const min = (m) => new Date(now - m * 60000).toISOString();
  const ideas = [
    { id: "old-put", symbol: "SPY", action: "PUT", createdAt: "2026-09-15T14:00:00Z", why_plain: "seventeen days old" },
    { id: "own", symbol: "SPY", action: "CALL", createdAt: min(28) },
    { id: "wait", symbol: "SPY", action: "WAIT", createdAt: min(0) },
  ];
  const pos = { symbol: "SPY", ideaId: "own", createdAt: min(9) };
  assert.equal(decideReversalExit({ pos, dir: 1, ideas, now }), null, "the 09-15 PUT is older than the thesis");
  const flipped = [...ideas, { id: "new-put", symbol: "SPY", action: "PUT", createdAt: min(2), why_plain: "rolling over" }];
  const exit = decideReversalExit({ pos, dir: 1, ideas: flipped, now });
  assert.equal(exit.tag, "reversed");
  assert.match(exit.detail, /rolling over/);
  // A later read in the SAME direction is a re-affirmation, not a reversal.
  const same = [...ideas, { id: "new-call", symbol: "SPY", action: "CALL", createdAt: min(2) }];
  assert.equal(decideReversalExit({ pos, dir: 1, ideas: same, now }), null);
  // Intraday positions are never reversed by the multi-day read.
  assert.equal(decideReversalExit({ pos: { ...pos, strategy: "intraday" }, dir: 1, ideas: flipped, now }), null);
});

test("reversal: a read older than two hours is stale even if it postdates the thesis", () => {
  const now = Date.parse("2026-10-02T18:14:00Z");
  const ideas = [
    { id: "own", symbol: "NVDA", action: "CALL", createdAt: new Date(now - 300 * 60000).toISOString() },
    { id: "put", symbol: "NVDA", action: "PUT", createdAt: new Date(now - 150 * 60000).toISOString() },
  ];
  assert.equal(latestIdeaForSymbol(ideas, "NVDA", "own", Date.parse(ideas[0].createdAt), now), null);
});

test("expiration settles at intrinsic value", () => {
  assert.equal(intrinsicAtExpiry("call", 225, 230), 5);
  assert.equal(intrinsicAtExpiry("call", 225, 220), 0);
  assert.equal(intrinsicAtExpiry("put", 225, 220), 5);
  assert.equal(intrinsicAtExpiry("put", 225, 230), 0);
  assert.equal(intrinsicAtExpiry("call", 225, null), null, "no close found: unknown, not zero");
});

test("direction and held quantity read the row the way the order path does", () => {
  assert.equal(directionOf({ vehicle: "OPTION", optionType: "put" }), -1);
  assert.equal(directionOf({ vehicle: "SHARES", side: "sell_short" }), -1);
  assert.equal(directionOf({ vehicle: "SHARES", side: "buy" }), 1);
  assert.equal(heldQuantity({ entryQuantity: 4, entryFilledQuantity: 3 }), 3, "a partial fill sells what filled");
  assert.equal(heldQuantity({ entryQuantity: 4 }), 4);
});


test("premium stop: an option is cut at -10% of its entry price, the size of a typical win", () => {
  const cfg = exitConfig(25000);
  const base = { vehicle: "OPTION", entryPremium: 5.52, peakGainPct: 0, peakGainUsd: 0, peakMark: 5.52 };
  assert.equal(HARD_LOSS_PCT.OPTION, 10);
  const cut = decideProfitExit(cfg, { ...base, markNow: 4.95, gainPct: -10.3, gainUsd: -57 });
  assert.equal(cut?.tag, "premium_stop");
  assert.equal(decideProfitExit(cfg, { ...base, markNow: 5.05, gainPct: -8.5, gainUsd: -47 }), null, "inside the stop, nothing fires");
  // The account rule still wins when it is the larger loss, as on a multi-contract position.
  const big = decideProfitExit(cfg, { ...base, markNow: 4.95, gainPct: -10.3, gainUsd: -456 });
  assert.equal(big?.tag, "max_loss");
  // Shares are not held to a percentage of their price.
  assert.equal(decideProfitExit(cfg, { vehicle: "SHARES", entryPremium: 355.73, markNow: 320, gainPct: -10.1, gainUsd: -143, peakGainPct: 0, peakGainUsd: 0, peakMark: 355.73 }), null);
});
