/* ===================== THE RULES CONTRACT =====================

   Every rule the user has agreed to, written as a test. If a change breaks
   one of these, the change is wrong OR the rule is being changed — and a rule
   changes only when the user says so (2026-10-14: "we need to make sure that
   all of the basic rules are always followed unless I agree we change them").

   When the user agrees a change: update the test here in the same commit,
   and put the date and the user's words in the test's name or comment.
   Never edit a test here just to make a failing build pass. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-contract-"));
process.env.STORE_FILE = path.join(tmp, "t.db");
process.env.SIM_FILE = path.join(tmp, "sim.json");
process.env.SIM_ACCOUNT_TYPE = "margin";
process.env.ACCOUNT_SIZE = "25000";
for (const k of ["ENTRY_AT_MID", "FADE_LIVE", "INTRADAY_LIVE", "SELECTION_RULES", "TRADIER_TOKEN", "TRADIER_TOKEN_SANDBOX"]) delete process.env[k];

const store = await import("../app/api/store.js");
const entry = await import("../app/api/order/entryRules.js");
const exits = await import("../app/api/order/exitRules.js");
const risk = await import("../app/api/riskLib.js");
const sel = await import("../app/api/selectionLib.js");
const fade = await import("../app/api/fadeLib.js");
const swing = await import("../app/api/swingLib.js");
const sizing = await import("../app/api/sizingLib.js");
const sim = await import("../app/api/simBroker.js");
const accountLib = await import("../app/api/accountLib.js");
const edge = await import("../app/api/edgeLib.js");
after(() => { store._closeForTests(); fs.rmSync(tmp, { recursive: true, force: true }); });

const ACCOUNT = 25000;

/* ---------- 1. Money at risk ---------- */

/* 1% -> 2% on 2026-10-14, the owner choosing "2%, and a 10% daily halt", after
   the 20% option stop had halved the contracts bought for the same $250. */
test("RULE: one trade may lose at most 2% of the account ($500 at $25K) — 2026-10-08 at 1%, 2% since 2026-10-14", () => {
  assert.equal(exits.MAX_LOSS_PCT, 2);
  assert.equal(exits.exitConfig(ACCOUNT).maxLossUsd, 500);
  assert.equal(entry.RISK_PER_TRADE_PCT, 2);
  const f = { vehicle: "OPTION", entryPremium: 2, markNow: 1.37, gainPct: -31.5, gainUsd: -502, peakGainPct: 0, peakGainUsd: 0, peakMark: 2 };
  assert.equal(exits.decideProfitExit(exits.exitConfig(ACCOUNT), f).tag, "max_loss", "a position down $502 is sold");
});

test("RULE: the day stops at a loss of 10% of the account ($2,500) — the one halt kept on 2026-10-13; 5% until 2026-10-14", () => {
  assert.equal(risk.DAILY_LOSS_LIMIT_PCT, 10);
  assert.equal(risk.planLimits(ACCOUNT).lossLimitUsd, 2500);
});

test("RULE: one account size for every rule, read from ACCOUNT_SIZE", () => {
  assert.equal(accountLib.accountSize(), 25000);
});

/* ---------- 2. Entries ---------- */

test("RULE: buys pay the ASK — 2026-10-14, after the mid-price entries filled only on losers", () => {
  const leg = { bid: 5.21, ask: 5.25 };
  assert.equal(entry.payPrice(leg), 5.25);
  assert.equal(entry.payPrice(leg, { atMid: true }), 5.23, "the mid only when asked for");
});

test("RULE: no new positions outside the regular session — 2026-10-13, the after-hours AMZN order", () => {
  assert.equal(entry.entriesAllowed("open"), true);
  for (const s of ["premarket", "postmarket", "closed", "unknown", undefined]) assert.equal(entry.entriesAllowed(s), false, String(s));
});

test("RULE: position and exposure caps — 15% a position, 20% a stock, 100% in total, 4 entries a stock a day, 45 min before re-entry", () => {
  assert.equal(sizing.OPTION_HARD_PCT, 0.15);
  assert.equal(entry.MAX_SYMBOL_EXPOSURE_PCT, 20);
  assert.equal(entry.MAX_TOTAL_EXPOSURE_PCT, 100);
  assert.equal(entry.MAX_ENTRIES_PER_SYMBOL_DAY, 4, "2 -> 4 on 2026-10-13");
  assert.equal(entry.REENTRY_COOLDOWN_MIN, 45);
});

test("RULE: an idea needs conviction 2+ and 1.5:1 reward to risk", () => {
  assert.equal(entry.MIN_CONVICTION, 2);
  assert.equal(entry.MIN_REWARD_RISK, 1.5);
});

test("RULE: same-day contracts are not opened after 15:00 ET", () => {
  assert.equal(entry.LAST_FLAT_BY_CLOSE_ENTRY_MIN, 15 * 60);
  assert.equal(entry.lateEntryRefused({ flatByClose: true, etMinutes: 15 * 60 }), true);
  assert.equal(entry.lateEntryRefused({ flatByClose: true, etMinutes: 14 * 60 + 59 }), false);
  assert.equal(entry.lateEntryRefused({ flatByClose: false, etMinutes: 15 * 60 + 30 }), false, "multi-day positions are not same-day contracts");
});

/* ---------- 3. Sizing ---------- */

const hoodLeg = { bid: 3.65, ask: 3.75, delta: -0.4381 };
const qqqProfile = { up: { p90: 0.30 }, down: { p90: 0.28 } };

test("RULE: contracts come from the stop that fires FIRST, inside 2% of the account — 2026-10-14, 'why only 1 option for HOOD'", () => {
  // Flat 20% option stop (10% until 2026-10-14): $75 + $10 spread = $85 a contract;
  // $500 of risk (2% since 2026-10-14) -> 5, the same 5 the 10% stop bought at 1%.
  const flat = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg: hoodLeg, entryPrice: 104.82, invalidation: 107.5, action: "PUT", strategy: undefined });
  assert.equal(flat.ok, true);
  assert.equal(flat.stopPct, 20);
  assert.equal(flat.contracts, 5);
  assert.ok(flat.riskAtStop <= 500, `risk ${flat.riskAtStop} must stay inside $500`);
});

/* Floor 8 -> 20 and the flat stop 10 -> 20 on 2026-10-14, the owner: "lets not
   have the stop losses this conservative, check the stocks that were sold too
   early and adjust the stop loss". Replay in exitRules.HARD_LOSS_PCT. */
test("RULE: each option's stop comes from its own stock's swings, 20% to 35% — 2026-10-14, 'not all contracts work the same way', 'not this conservative'", () => {
  assert.equal(swing.STOP_FLOOR_PCT, 20);
  assert.equal(swing.STOP_CAP_PCT, 35);
  assert.equal(swing.STOP_PCTILE, "p90");
  const qqq = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg: { bid: 5.21, ask: 5.25, delta: -0.48 }, entryPrice: 736, invalidation: 740.6, action: "PUT", profile: qqqProfile });
  assert.ok(qqq.stopPct > 13.9, `QQQ's stop ${qqq.stopPct}% must sit outside the 13.9% dip of 2026-10-14`);
  assert.ok(qqq.riskAtStop <= 500);
});

test("RULE: never more than the 15% position cap, however cheap the risk", () => {
  const cheap = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg: { bid: 9.98, ask: 10.0, delta: 0.05 }, entryPrice: 100, invalidation: 99.9, action: "CALL" });
  assert.ok(cheap.contracts * 10.0 * 100 <= ACCOUNT * 0.15 + 1e-6, `${cheap.contracts} contracts at $1,000 exceeds $3,750`);
});

test("RULE: a same-day trade is refused when one contract risks more than 1.5x the budget; a multi-day one takes one contract", () => {
  const big = { bid: 39.9, ask: 40.0, delta: 0.9 };
  // $40 contract, delta 0.9, $12 to the stop: about $1,090 a contract, over 1.5x the $500 budget.
  const sameDay = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg: big, entryPrice: 500, invalidation: 488, action: "CALL", strategy: "intraday" });
  assert.equal(sameDay.ok, false);
  const multiDay = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg: big, entryPrice: 500, invalidation: 488, action: "CALL" });
  assert.equal(multiDay.ok, true);
  assert.equal(multiDay.contracts, 1);
});

test("RULE: no entry with a spread over 6% of the premium, or one that spends 40% of the loss limit on arrival", () => {
  assert.equal(entry.MAX_SPREAD_PCT_OF_PREMIUM, 6);
  assert.equal(entry.MAX_SPREAD_SHARE_OF_LOSS, 0.4);
  const wide = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg: { bid: 3.9, ask: 4.2, delta: 0.5 }, entryPrice: 100, invalidation: 98, action: "CALL" });
  assert.equal(wide.ok, false);
  assert.match(wide.reason, /Spread/);
});

/* ---------- 4. Selection ---------- */

test("RULE: no bullish ideas in an uptrend, no bearish ones in a transitioning tape, no calls after 14:00, no FDA — 2026-10-13", () => {
  assert.equal(sel.selectionOn(), true, "on unless SELECTION_RULES=off");
  assert.equal(sel.LATE_CALL_FROM_ET_MIN, 14 * 60);
  const v = (o) => sel.selectionVerdict({ etMinutes: 600, ...o });
  assert.equal(v({ action: "CALL", regime: "uptrend" }).ok, false);
  assert.equal(v({ action: "PUT", regime: "uptrend" }).ok, true, "puts in an uptrend are the best bucket");
  assert.equal(v({ action: "PUT", regime: "transitioning" }).ok, false);
  assert.equal(v({ action: "CALL", regime: "mixed / range", etMinutes: 14 * 60 }).ok, false);
  assert.equal(v({ action: "PUT", regime: "mixed / range", catalyst: "clinical/FDA" }).ok, false);
});

/* ---------- 5. What trades live, and what only records ---------- */

test("RULE: outside learning mode the fade and the fade scan only RECORD; same-day ideas TRADE — 2026-10-14, 'lets have those live and learn'", () => {
  const off = { LEARNING_MODE: "false" };
  assert.equal(entry.isWatchOnly("contrarian", off), true, "FADE_LIVE=true to trade it");
  assert.equal(entry.isWatchOnly("fade_scan", off), true);
  assert.equal(entry.isWatchOnly("intraday", off), false, "live since 2026-10-14; watch-only 2026-10-08 to 10-14");
  assert.equal(entry.isWatchOnly("intraday", { ...off, INTRADAY_LIVE: "false" }), true, "INTRADAY_LIVE=false to record only");
  assert.equal(entry.isWatchOnly(undefined, off), false, "multi-day ideas trade");
  assert.equal(entry.isWatchOnly("contrarian", { ...off, FADE_LIVE: "true" }), false);
});

/* Learning mode, 2026-10-14. The owner: "remove all the blockers that will
   block you from learning ... always buy->sell->learn ... always try and
   always learn from every single contract or trade." */
test("RULE: learning mode is ON by default and every playbook trades — 2026-10-14, 'always buy->sell->learn'", () => {
  assert.equal(entry.learningMode({}), true);
  assert.equal(entry.learningMode({ LEARNING_MODE: "false" }), false);
  for (const pb of ["contrarian", "fade_scan", "intraday", undefined]) assert.equal(entry.isWatchOnly(pb, {}), false, `${pb} trades in learning mode`);
  assert.deepEqual([...entry.SOFT_RULES].sort(), ["conviction", "consumed", "cooldown", "daily_cap", "edge_throttle", "extreme", "late_entry", "over_budget", "pdt", "reward_risk", "selection", "spread", "stale", "tape", "watch_only"].sort(),
    "the rules that record instead of refusing; adding one means changing this test on purpose");
});

test("RULE: learning mode keeps the safety core — same-day entries end at 15:30, 8 entries per symbol per day at most", () => {
  assert.equal(entry.LEARNING_LAST_ENTRY_MIN, 15 * 60 + 30);
  assert.equal(entry.LEARNING_MAX_ENTRIES_PER_SYMBOL_DAY, 8);
  assert.equal(entry.lateEntryRefused({ flatByClose: true, etMinutes: 15 * 60 + 10, learning: true }), false, "15:00-15:30 is an override, not a refusal");
  assert.equal(entry.lateEntryRefused({ flatByClose: true, etMinutes: 15 * 60 + 30, learning: true }), true);
  // The losses are still capped: the max-loss exit (2% since 2026-10-14) and the position cap.
  assert.equal(entry.RISK_PER_TRADE_PCT, 2);
  assert.equal(sizing.OPTION_HARD_PCT, 0.15);
});

/* The entry-confirmation test, 2026-10-14. The owner, on "wait for a 2-3
   minute close beyond the level before buying": "lets test that". */
test("RULE: triggered ideas are split between buying at the break and waiting for 2 one-minute closes beyond it — 2026-10-14, 'lets test that'", () => {
  assert.equal(entry.CONFIRM_BARS, 2);
  const arms = new Set(Array.from({ length: 40 }, (_, i) => entry.entryArm(`idea-${i}`, {})));
  assert.deepEqual([...arms].sort(), ["confirm", "immediate"], "both arms are used");
  assert.equal(entry.entryArm("x", { ENTRY_CONFIRM: "all" }), "confirm");
  assert.equal(entry.entryArm("x", { ENTRY_CONFIRM: "off" }), "immediate");
  assert.equal(entry.entryArm("same-id", {}), entry.entryArm("same-id", {}), "an idea stays in its arm");
  const bars = [
    { time: "2026-10-14T14:40:00", close: 100.1 },
    { time: "2026-10-14T14:41:00", close: 99.8 },
    { time: "2026-10-14T14:42:00", close: 99.7 },
    { time: "2026-10-14T14:43:00", close: 100.4 }, // still forming at 14:43
  ];
  assert.equal(entry.confirmedBreak({ bars, trigger: 99.9, direction: "below", nowMinute: "2026-10-14T14:43" }), true, "two completed closes under");
  assert.equal(entry.confirmedBreak({ bars, trigger: 99.9, direction: "below", nowMinute: "2026-10-14T14:44" }), false, "the last completed close is back above");
  assert.equal(entry.confirmedBreak({ bars: bars.slice(0, 2), trigger: 99.9, direction: "below", nowMinute: "2026-10-14T14:42" }), false, "only one completed close under");
  assert.equal(entry.confirmedBreak({ bars: [], trigger: 99.9, direction: "below" }), false, "no bars, no confirmation");
});

test("RULE: an idea from an earlier session never trades; an idea that reached its target is finished; unfilled orders do not count as entries — 2026-10-14 review", () => {
  const now = Date.parse("2026-10-14T18:00:00Z");
  assert.equal(entry.fromEarlierSession("2026-10-13T20:46:50Z", now), true, "the 10-13 INTC fade placed all day on 10-14");
  assert.equal(entry.fromEarlierSession("2026-10-14T13:31:00Z", now), false);
  assert.equal(entry.fromEarlierSession("2026-10-14T02:00:00Z", now), true, "22:00 ET on 10-13 is the earlier session");
  assert.deepEqual([...entry.PLAYED_OUT_EXITS].sort(), ["take_profit", "target"]);
  assert.equal(entry.countsAsEntry({ exitReasonTag: "unfilled" }), false);
  assert.equal(entry.countsAsEntry({ exitReasonTag: "premium_stop" }), true);
  assert.equal(entry.countsAsEntry({ status: "open" }), true);
});

test("RULE: a setup is void when price is through its invalidation or already at its target — hard, in learning mode too", () => {
  assert.match(entry.setupVoid({ dir: -1, entry: 700, target: 705, invalidation: 710 }), /target/, "the SPY put loop of 2026-10-14");
  assert.match(entry.setupVoid({ dir: 1, entry: 99, target: 110, invalidation: 100 }), /invalidation/);
  assert.equal(entry.setupVoid({ dir: 1, entry: 105, target: 110, invalidation: 100 }), null);
  assert.equal(entry.setupVoid({ dir: -1, entry: 105, target: 100, invalidation: 110 }), null);
});

test("RULE: in learning mode a same-day contract over budget, or with a wide spread, is taken at size and the override recorded", () => {
  const wide = { bid: 4.0, ask: 5.0, delta: 0.5 };
  const refused = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg: wide, entryPrice: 100, invalidation: 90, action: "CALL", strategy: "intraday" });
  assert.equal(refused.ok, false, "outside learning mode it is still refused");
  const taken = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg: wide, entryPrice: 100, invalidation: 90, action: "CALL", strategy: "intraday", learning: true });
  assert.equal(taken.ok, true);
  assert.ok(taken.contracts >= 1);
  assert.ok(taken.overrides.some((o) => o.rule === "spread"));
  const noStop = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg: { bid: 0, ask: 0 }, entryPrice: 100, invalidation: 100, action: "CALL", learning: true });
  assert.equal(noStop.ok, false, "no usable stop is a hard refusal even in learning mode");
});

test("RULE: fades never in the first half hour, and their stop is at least 0.5% of the price away", () => {
  assert.equal(fade.FADE_FROM_ET_MIN, 10 * 60);
  assert.equal(fade.MIN_STOP_PCT, 0.5);
  assert.equal(fade.fadePlan({ action: "CALL", price: 120, low: 100, high: 120, etMinutes: 9 * 60 + 59 }), null);
});

/* ---------- 6. Exits ---------- */

/* 2026-10-14, the owner: "remove all rules on selling for the profit, unless
   the stock is +50%"; of the three replayed versions they chose "+50% or the
   idea's target". The replay is in exitRules.PROFIT_TAKE_PCT. */
test("RULE: an option is sold for profit only at +50% or at the idea's target; same-day contracts still go flat from 15:45 — 2026-10-14", () => {
  assert.equal(exits.PROFIT_TAKE_PCT, 50);
  assert.equal(exits.profitExitMode({}), "target50");
  assert.equal(exits.profitExitMode({ PROFIT_EXITS: "legacy" }), "legacy");
  const cfg = exits.exitConfig(ACCOUNT);
  const opt = { vehicle: "OPTION", entryPremium: 5, profitMode: "target50" };
  // Peaked at +40%, back to +20%: the old trail would have sold it. Held.
  assert.equal(exits.decideProfitExit(cfg, { ...opt, markNow: 6, gainPct: 20, gainUsd: 100, peakGainPct: 40, peakGainUsd: 200, peakMark: 7 }), null);
  // A same-day contract up 10%: the old quick +7% would have sold it. Held.
  assert.equal(exits.decideProfitExit(cfg, { ...opt, closeByEod: true, markNow: 5.5, gainPct: 10, gainUsd: 50, peakGainPct: 10, peakGainUsd: 50, peakMark: 5.5 }), null);
  // Up $300 into the close on a multi-day contract: the old end-of-day bar would have sold it. Held.
  assert.equal(exits.decideProfitExit(cfg, { ...opt, eod: true, nowEtMinutes: 15 * 60 + 50, markNow: 6.5, gainPct: 30, gainUsd: 300, peakGainPct: 30, peakGainUsd: 300, peakMark: 6.5 }), null);
  // +50%: sold.
  assert.equal(exits.decideProfitExit(cfg, { ...opt, markNow: 7.5, gainPct: 50, gainUsd: 250, peakGainPct: 50, peakGainUsd: 250, peakMark: 7.5 }).tag, "take_profit");
  // The loss side is unchanged, and a same-day contract is still flat by the close.
  assert.equal(exits.decideProfitExit(cfg, { ...opt, markNow: 3.95, gainPct: -21, gainUsd: -105, peakGainPct: 0, peakGainUsd: 0, peakMark: 5 }).tag, "premium_stop");
  assert.equal(exits.decideProfitExit(cfg, { ...opt, closeByEod: true, eod: true, nowEtMinutes: 15 * 60 + 45, markNow: 5.5, gainPct: 10, gainUsd: 50, peakGainPct: 10, peakGainUsd: 50, peakMark: 5.5 }).tag, "eod_flat");
  // The idea's target still sells.
  assert.equal(exits.decideLevelExit({ dir: -1, target: 700, invalidation: 720, strategy: "intraday", underlyingPx: 699.5, favorableExtreme: 699 }).tag, "target");
});

test("RULE (legacy, PROFIT_EXITS=legacy): trail arms at +5% (options) and sells on a 25% giveback; 1-3 day contracts sold at +7% and flat from 15:45", () => {
  assert.deepEqual(exits.TRAIL_ARM_PCT, { OPTION: 5, SHARES: 15 });
  assert.equal(exits.TRAIL_GIVEBACK_PCT, 25);
  assert.equal(exits.SHORT_DATED_TARGET_PCT, 7);
  assert.equal(exits.EOD_FLAT_FROM_ET_MIN, 15 * 60 + 45);
});

test("RULE: an option is sold at its own stop, else at -20%; shares keep the idea's stop — 2026-10-14", () => {
  assert.deepEqual(exits.HARD_LOSS_PCT, { OPTION: 20, SHARES: null });
  const cfg = exits.exitConfig(ACCOUNT);
  const base = { vehicle: "OPTION", entryPremium: 5, peakGainPct: 0, peakGainUsd: 0, peakMark: 5 };
  assert.equal(exits.decideProfitExit(cfg, { ...base, markNow: 4.45, gainPct: -11, gainUsd: -55 }), null, "-11% holds under the flat 20%");
  assert.equal(exits.decideProfitExit(cfg, { ...base, markNow: 3.95, gainPct: -21, gainUsd: -105 }).tag, "premium_stop", "flat 20%");
  assert.equal(exits.decideProfitExit(cfg, { ...base, markNow: 3.95, gainPct: -21, gainUsd: -105, stopPct: 30 }), null, "its own 30% stop holds it");
  assert.equal(exits.decideProfitExit(cfg, { ...base, markNow: 3.45, gainPct: -31, gainUsd: -155, stopPct: 30 }).tag, "premium_stop");
  assert.equal(exits.decideProfitExit(cfg, { vehicle: "SHARES", entryPremium: 100, markNow: 88, gainPct: -12, gainUsd: -48, peakGainPct: 0, peakGainUsd: 0, peakMark: 100 }), null);
});

test("RULE: a same-day position is never closed by the thesis-reversed rule", () => {
  for (const s of ["intraday", "contrarian", "fade_scan"]) assert.ok(exits.SAME_DAY_STRATEGIES.has(s) || s === "fade_scan", s);
  const ideas = [{ id: "b", symbol: "X", action: "CALL", createdAt: new Date().toISOString() }];
  const pos = { symbol: "X", ideaId: "f", createdAt: new Date(Date.now() - 300000).toISOString(), strategy: "contrarian" };
  assert.equal(exits.decideReversalExit({ pos, dir: -1, ideas }), null);
});

/* ---------- 7. The account (simulated broker) ---------- */

const order = (form) => sim.simFetch("/accounts/SIM/orders", { method: "POST", form });

test("RULE: a margin account — sale proceeds reusable at once; the day-trade rule under $25,000 of equity — 2026-10-13", () => {
  assert.equal(sim.ACCOUNT_TYPE, "margin");
  assert.equal(sim.PDT_EQUITY_USD, 25000);
  assert.equal(sim.PDT_MAX_DAY_TRADES, 3);
  assert.equal(sim.pdtVerdict({ equity: 24999, dayTrades: 3 }).ok, false);
  assert.equal(sim.pdtVerdict({ equity: 25001, dayTrades: 30 }).ok, true);
});

test("RULE: $0.35 a contract each way; no short selling and no option writing", async () => {
  assert.equal(sim.OPTION_FEE, 0.35);
  await assert.rejects(order({ class: "equity", symbol: "SPY", side: "sell_short", quantity: "1", type: "limit", price: "700", duration: "day" }), /short selling/);
  await assert.rejects(order({ class: "option", symbol: "SPY", option_symbol: "SPY261120C00700000", side: "sell_to_open", quantity: "1", type: "limit", price: "5", duration: "day" }), /option writing/);
});

test("RULE: market orders are refused; limits only", async () => {
  await assert.rejects(order({ class: "equity", symbol: "SPY", side: "buy", quantity: "1", type: "market", duration: "day" }), /limit orders/);
});

test("RULE: nothing fills while the market is closed (no clock = closed)", async () => {
  const r = await order({ class: "equity", symbol: "SPY", side: "buy", quantity: "1", type: "limit", price: "1", duration: "day" });
  const o = await sim.simFetch(`/accounts/SIM/orders/${r.order.id}`);
  assert.notEqual(o.order.status, "filled");
});

/* ---------- 8. Where ideas come from ---------- */

test("RULE: ideas come from Opus — 2026-10-13, Sonnet answered WAIT to nearly everything", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "app/api/suggestions/route.js"), "utf8");
  assert.match(src, /model: process\.env\.SUGGESTIONS_MODEL \|\| "claude-opus-5"/);
});


/* ---------- 9. A losing record trades smaller, never stops ---------- */

test("RULE: the edge throttle — a losing recent record cuts size to 1/2 or 1/4, never to zero — 2026-10-14, 'find a better solution'", () => {
  assert.equal(edge.edgeRiskMultiplier({ n: 11, needed: 20 }).mult, 1, "not enough trades to judge: full size");
  assert.equal(edge.edgeRiskMultiplier({ n: 20, expectancyR: 0.1 }).mult, 1);
  assert.equal(edge.edgeRiskMultiplier({ n: 20, expectancyR: -0.08 }).mult, 0.5, "the swing record that afternoon");
  assert.equal(edge.edgeRiskMultiplier({ n: 20, expectancyR: -0.6 }).mult, 0.25);
  for (const e of [-0.01, -0.3, -5]) assert.ok(edge.edgeRiskMultiplier({ n: 20, expectancyR: e }).mult > 0, "never zero: a stopped playbook could never prove itself again");
  // And the size really follows it.
  const leg = { bid: 3.65, ask: 3.75, delta: -0.4381 };
  const full = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg, entryPrice: 104.82, invalidation: 107.5, action: "PUT" });
  const half = entry.sizeOptionEntry({ accountSize: ACCOUNT, leg, entryPrice: 104.82, invalidation: 107.5, action: "PUT", riskMult: 0.5 });
  assert.ok(half.contracts < full.contracts && half.riskAtStop <= 250 + 1, `half ${half.contracts}/${half.riskAtStop} vs full ${full.contracts}`);
});

test("RULE: same-day ideas are asked for 1.8x reward to risk at the trigger — 2026-10-14", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "app/api/suggestions/route.js"), "utf8");
  assert.match(src, /Reward at least 1\.8x risk MEASURED FROM THE TRIGGER PRICE/);
});
