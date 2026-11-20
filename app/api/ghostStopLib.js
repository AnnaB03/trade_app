/* The 35% stop, as a recorded test (owner, 2026-11-20 review: "set up the 35%
   stop as a recorded test"). Nothing here places an order.

   Every live option bought from 2026-11-20 gets a ghost: the same contract,
   bought at the same price, sized to the SAME DOLLAR RISK at a 35% stop
   (fewer contracts), and sold by the live exit rules with the stop at 35%
   instead of 20%: the +$80 quick sale and the rest of decideProfitExit, the
   market-turn and afternoon-fade sales, the idea's own target and
   invalidation, and the 15:45 sweep. A ghost keeps running after the live
   trade closes, until its own rules sell it. Sales are at the bid; the stop is
   judged at the mid and needs two reads 20 s apart, as the simulated broker's
   stops do since 11/19.

   Why: since 11/04, 21 live option stops filled at -22.9% on average, and a
   minute-price estimate put a 35% stop at +$170 / +$205 by half against about
   -$1,340 for 20% at the same dollar risk (noisy: 25% came out worse). This
   records the real answer, trade by trade, before anything changes.

   Stored in kv "ghost35". Read with GET /api/ghost35. */
import { listJournal, kvGet, kvSet } from "./store.js";
import { tradier, asArray } from "./tradier.js";
import { exitConfig, decideProfitExit, decideLevelExit, confirmedMarketTurn, decideAfternoonFadeExit } from "./order/exitRules.js";
import { accountSize } from "./accountLib.js";

export const GHOST_STOP_PCT = 35;
export const GHOST_FROM = "2026-11-20";
export const GHOST_KEY = "ghost35";
const FEE = 0.35; // per contract per side, as the simulated broker charges
const STOP_CONFIRM_MS = 20000;
const EOD_MIN = 15 * 60 + 45;

const etMinutesOf = (d = new Date()) => {
  const [h, m] = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).split(":").map(Number);
  return (h % 24) * 60 + m;
};

// Contracts at the same dollar risk: live contracts x live stop / 35, at least 1.
export function ghostContracts({ liveQty, liveStopPct = 20, ghostStopPct = GHOST_STOP_PCT }) {
  const q = Number(liveQty) || 0;
  return Math.max(1, Math.floor((q * (Number(liveStopPct) || 20)) / ghostStopPct + 1e-9));
}

export function ghostPnl(g, exitPrice) {
  return Math.round(((exitPrice - g.entryPremium) * 100 * g.qty - 2 * FEE * g.qty) * 100) / 100;
}

// The ghost's result scaled to the live trade's dollar risk (they differ only when a 1-contract trade cannot shrink).
export function scaledPnl(g) {
  if (g.pnl == null) return null;
  const liveRisk = g.liveQty * g.liveStopPct, ghostRisk = g.qty * GHOST_STOP_PCT;
  return Math.round(g.pnl * (ghostRisk > 0 ? liveRisk / ghostRisk : 1) * 100) / 100;
}

/* One step for one open ghost, from the figures of this minute. Pure: returns
   { exit: {tag, detail, price} | null, patch } so it can be tested directly. */
export function stepGhost(g, { bid, ask, underlyingPx, qqq, nowEtMinutes, now = Date.now(), cfg }) {
  const patch = {};
  if (!(bid >= 0) || !(ask > 0) || ask < bid) return { exit: null, patch };
  const mid = (bid + ask) / 2;
  if (nowEtMinutes >= EOD_MIN) return { exit: { tag: "eod_flat", detail: "Every option is sold from 15:45", price: bid }, patch };
  const peakMark = Math.max(Number(g.peakMark) || 0, bid);
  if (peakMark !== g.peakMark) patch.peakMark = peakMark;
  const e = g.entryPremium, q = g.qty;
  const gainUsd = (bid - e) * 100 * q, gainPct = ((bid - e) / e) * 100;
  const lossGainPct = ((mid - e) / e) * 100, lossGainUsd = (mid - e) * 100 * q;
  let exit = decideProfitExit(cfg, {
    vehicle: "OPTION", closeByEod: g.closeByEod, eod: false, nowEtMinutes,
    gainPct, gainUsd, peakGainPct: ((peakMark - e) / e) * 100, peakGainUsd: (peakMark - e) * 100 * q, peakMark,
    entryPremium: e, markNow: bid, stopPct: GHOST_STOP_PCT, lossGainPct, lossGainUsd, letRun: false, carry: false,
  });
  // The stop needs two reads 20 s apart (one bad quote sold AVGO's stop on 11/19).
  if (exit?.tag === "premium_stop") {
    const first = Date.parse(g.stopSeenAt || "");
    if (!(Number.isFinite(first) && now - first >= STOP_CONFIRM_MS)) {
      if (!Number.isFinite(first)) patch.stopSeenAt = new Date(now).toISOString();
      return { exit: null, patch };
    }
  } else if (g.stopSeenAt) patch.stopSeenAt = null;
  if (!exit && qqq) exit = confirmedMarketTurn({ vehicle: "OPTION", optionType: g.optionType, qqqOpen: qqq.open, qqqLast: qqq.last, qqqBid: qqq.bid, qqqAsk: qqq.ask });
  if (!exit && qqq) exit = decideAfternoonFadeExit({ vehicle: "OPTION", optionType: g.optionType, nowEtMinutes, qqqHigh: qqq.high, qqqLow: qqq.low, qqqLast: qqq.last });
  if (!exit && underlyingPx > 0) exit = decideLevelExit({ dir: g.dir, target: g.target, invalidation: g.invalidation, strategy: g.strategy, underlyingPx, favorableExtreme: underlyingPx });
  return { exit: exit ? { ...exit, price: bid } : null, patch };
}

const load = () => kvGet(GHOST_KEY) || { ghosts: [] };

// New ghosts for live option rows bought since GHOST_FROM: open ones, and any closed in the last 15 minutes (bought and sold between two checks).
export function addGhosts(state, rows, now = Date.now()) {
  const have = new Set(state.ghosts.map((g) => g.id));
  let added = 0;
  for (const r of rows) {
    if (r.vehicle !== "OPTION" || !(Number(r.entryFillPrice) > 0) || !r.occ || have.has(r.id)) continue;
    if (String(r.entryAt || "") < GHOST_FROM) continue;
    if (r.status !== "open" && !(now - Date.parse(r.entryAt) < 15 * 60000)) continue;
    const liveQty = Number(r.entryFilledQuantity || r.entryQuantity) || 1, liveStopPct = Number(r.stopPct) || 20;
    state.ghosts.push({
      id: r.id, symbol: r.symbol, occ: r.occ, optionType: r.optionType, dir: r.optionType === "put" ? -1 : 1,
      strategy: r.strategy || null, closeByEod: Boolean(r.closeByEod), invalidation: r.invalidation ?? null, target: r.target ?? null,
      entryAt: r.entryAt, entryPremium: Number(r.entryFillPrice), liveQty, liveStopPct,
      qty: ghostContracts({ liveQty, liveStopPct }), peakMark: Number(r.entryFillPrice), status: "open",
    });
    added++;
  }
  return added;
}

// Every minute, from the exit check: add new ghosts, then step the open ones. Never throws.
export async function runGhosts() {
  try {
    const state = load();
    const rows = listJournal();
    addGhosts(state, rows);
    // The live result, for the side-by-side.
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const g of state.ghosts) {
      const r = byId.get(g.id);
      if (r && r.status === "closed" && g.livePnl == null && typeof r.pnl === "number") { g.livePnl = r.pnl; g.liveExitTag = r.exitReasonTag ?? null; }
    }
    const open = state.ghosts.filter((g) => g.status === "open");
    if (open.length) {
      const syms = [...new Set([...open.map((g) => g.occ), ...open.map((g) => g.symbol), "QQQ"])];
      const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(syms.join(","))}`);
      const qs = new Map(asArray(d?.quotes?.quote).map((q) => [q.symbol, q]));
      const qq = qs.get("QQQ");
      const qqq = qq ? { open: Number(qq.open) || null, last: Number(qq.last) || null, high: Number(qq.high) || null, low: Number(qq.low) || null, bid: Number(qq.bid) || null, ask: Number(qq.ask) || null } : null;
      const cfg = exitConfig(accountSize());
      const nowEtMinutes = etMinutesOf();
      for (const g of open) {
        const oq = qs.get(g.occ), uq = qs.get(g.symbol);
        const { exit, patch } = stepGhost(g, { bid: Number(oq?.bid), ask: Number(oq?.ask), underlyingPx: Number(uq?.last), qqq, nowEtMinutes, cfg });
        Object.assign(g, patch);
        if (exit) Object.assign(g, { status: "closed", exitAt: new Date().toISOString(), exitPrice: exit.price, exitTag: exit.tag, exitDetail: exit.detail, pnl: ghostPnl(g, exit.price) });
      }
    }
    kvSet(GHOST_KEY, state);
    return state;
  } catch (e) {
    console.error("ghost35 step failed:", e);
    return null;
  }
}

// The side-by-side, for GET /api/ghost35 and the check-ins.
export function ghostReport(state = load()) {
  const done = state.ghosts.filter((g) => g.status === "closed" && g.livePnl != null);
  const sum = (a) => Math.round(a.reduce((s, x) => s + (x || 0), 0) * 100) / 100;
  return {
    stopPct: GHOST_STOP_PCT, since: GHOST_FROM,
    finished: done.length,
    live: sum(done.map((g) => g.livePnl)),
    ghost: sum(done.map((g) => g.pnl)),
    ghostAtLiveRisk: sum(done.map((g) => scaledPnl(g))),
    trades: state.ghosts.map((g) => ({
      symbol: g.symbol, occ: g.occ, entryAt: g.entryAt, entry: g.entryPremium, liveQty: g.liveQty, ghostQty: g.qty,
      live: g.livePnl ?? null, liveExit: g.liveExitTag ?? null, ghost: g.pnl ?? null, ghostAtLiveRisk: scaledPnl(g), ghostExit: g.exitTag ?? null, status: g.status,
    })),
  };
}
