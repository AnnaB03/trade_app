import { NextResponse } from "next/server";
import { vetOrder, vetEquityOrder, submitOrder } from "../common";
import { tradier, asArray } from "../../tradier";
import { tradeFetch, accountId } from "../../tradeClient";
import { listJournal, listIdeas } from "../../store";
import { journalClose } from "../../journalLib";
import { dailyBars } from "../../historyCache";

/* Paper-only auto-EXIT — the other half of autotrade.js. That route only
   ever opens a position; until now, the only thing that could close one was
   the GTC stop order resting on Tradier (real, but purely price-based) or a
   human clicking Close in the Journal tab. Nothing ever took profit at the
   stated target, and nothing ever closed a position because a fresh Ideas
   refresh changed the read on it — a paper "win" could sit open indefinitely
   with no realized P&L to show for it.

   Checks every open position, in order, for the first reason that applies:
   1. Its own resting stop already filled on Tradier (silently, since
      nothing previously reconciled this) — record the REAL exit, don't
      re-derive one.
   2. Underlying reached the idea's stated target — take the win.
   3. Underlying breached the idea's invalidation with NO resting stop to
      have caught it (only reachable if a stop genuinely failed to attach,
      e.g. missing option greeks at entry) — safety net, not a duplicate of
      the real Tradier stop.
   4. The latest idea for this same symbol has flipped to the opposite
      direction — the thesis this position was opened on no longer holds.
   Every actual close is reported back with the reason, in plain terms, so
   the calling cron can tell the user in chat exactly why. */

const DIRECTION = { CALL: 1, BUY: 1, PUT: -1, SELL: -1 };

// Take a real option gain when it's there, even if the UNDERLYING never
// reached the idea's target. Those are two different events: an option can
// run +180% on a move plus an IV expansion while the stock is still well
// short of target, and with only a target-based exit nothing banks it.
// Measured cost of not having this: the NVDA $225c bought at $3.13 printed
// $8.78 (+180%) intraday and was still open when it slid back to $7.10, so
// $168 of a realized win evaporated waiting on a $232 stock target.
// Winners in this book also round-trip fast (RKLB went +$118 to stopped
// out), so banking a good gain beats holding for a better one.
const PREMIUM_TAKE_PROFIT_PCT = 80;

// Shares need their own, much lower bar. Share ideas in this book aim for
// +3% to +11%, so an 80% threshold could never fire for them — which left
// share positions carrying no target at all (a real one: AAPL bought at
// $250, now $341, +36% and +$91 unrealized) with literally no exit path:
// no target to hit, no invalidation to breach, and no premium to measure.
// 20% sits far above any real share target, so normal target exits still
// fire first and this only catches the ones that fell through.
const SHARE_TAKE_PROFIT_PCT = 20;

async function underlyingQuote(symbol) {
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const q = asArray(d?.quotes?.quote)?.[0];
    return q?.last != null ? Number(q.last) : null;
  } catch {
    return null;
  }
}

// Target/invalidation checks need the day's high/low, not just the live
// last price — a snapshot taken every ~15 min can easily miss a fast
// intraday spike that crosses the level and reverts before the next check
// runs (confirmed live: NVDA hit $233.21 against a $232 target, but by the
// next check had pulled back to $230, so a last-price-only check never saw
// the target get hit at all). Tradier's quote endpoint already carries the
// day's high/low alongside last, so this costs nothing extra to fetch.
async function underlyingDayRange(symbol) {
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const q = asArray(d?.quotes?.quote)?.[0];
    const last = q?.last != null ? Number(q.last) : null;
    const high = q?.high != null ? Number(q.high) : last;
    const low = q?.low != null ? Number(q.low) : last;
    return { last, high, low };
  } catch {
    return null;
  }
}

async function optionQuote(occ) {
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(occ)}`);
    const q = asArray(d?.quotes?.quote)?.[0];
    const bid = Number(q?.bid), ask = Number(q?.ask);
    return { bid, ask, mid: bid >= 0 && ask > 0 ? (bid + ask) / 2 : null, last: Number(q?.last) || null };
  } catch {
    return null;
  }
}

// An option past its expiration has no live quote at all — Tradier simply
// stops carrying it. That's not "no data available," it's a real, knowable
// outcome: the underlying's closing price on the expiration date settles it
// exactly, via intrinsic value. Falls back to null (handled as "orphaned")
// only if that historical close itself can't be found.
async function expirationSettlement(pos) {
  try {
    const bars = await dailyBars(pos.symbol, 60);
    const bar = bars.find((b) => b.date === pos.expiration) || bars[bars.length - 1];
    const closePx = Number(bar?.close);
    if (!(closePx > 0)) return null;
    const intrinsic = pos.optionType === "call" ? Math.max(0, closePx - Number(pos.strike)) : Math.max(0, Number(pos.strike) - closePx);
    return { settlePrice: intrinsic, underlyingClose: closePx };
  } catch {
    return null;
  }
}

function latestIdeaForSymbol(ideas, symbol, excludeIdeaId) {
  const rows = ideas.filter((i) => i.symbol === symbol && i.id !== excludeIdeaId && ["CALL", "PUT", "BUY", "SELL"].includes(i.action));
  if (!rows.length) return null;
  return rows.reduce((a, b) => (new Date(a.createdAt) > new Date(b.createdAt) ? a : b));
}

// Has this position's own resting stop already filled on Tradier? Reads the
// SAME bracket order placed at entry (its id is stored as entryOrderId) —
// if the stop leg shows "filled", the position closed itself already and
// this is purely reconciling the journal to match reality, not a decision.
async function checkBrokerStopFill(pos) {
  if (!pos.entryOrderId) return null;
  try {
    const d = await tradeFetch(`/accounts/${await accountId()}/orders/${pos.entryOrderId}`);
    const legs = asArray(d?.order?.leg);
    const stopLeg = legs.find((l) => l.type === "stop");
    if (stopLeg?.status === "filled") {
      const price = Number(stopLeg.avg_fill_price) || Number(stopLeg.last_fill_price) || null;
      return { filled: true, price };
    }
    return { filled: false };
  } catch {
    return null;
  }
}

async function cancelResting(orderId) {
  if (!orderId) return;
  try { await tradeFetch(`/accounts/${await accountId()}/orders/${orderId}`, { method: "DELETE" }); } catch {}
}

async function closeOption(pos, exitPrice) {
  await cancelResting(pos.entryOrderId); // the resting stop leg — about to be replaced by this close
  const body = {
    legs: [{ action: "sell", type: pos.optionType, strike: String(pos.strike), premium: String(exitPrice), qty: String(pos.entryQuantity || 1), occ: pos.occ }],
    closing: true,
    outcome_note: "auto-exit",
  };
  const vet = await vetOrder(body, { preview: false });
  if (vet.error) return { ok: false, error: vet.error };
  try {
    const orderResult = (await submitOrder(vet.form))?.order ?? null;
    return { ok: true, orderResult };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function closeShares(pos, exitPrice) {
  await cancelResting(pos.entryOrderId);
  const body = {
    equity: { symbol: pos.symbol, quantity: pos.entryQuantity, price: exitPrice },
    closing: true,
    outcome_note: "auto-exit",
  };
  const vet = await vetEquityOrder(body, { preview: false });
  if (vet.error) return { ok: false, error: vet.error };
  try {
    const orderResult = (await submitOrder(vet.form))?.order ?? null;
    return { ok: true, orderResult };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function GET(req) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "true";
  try {
    const open = listJournal().filter((r) => r.status === "open");
    if (!open.length) return NextResponse.json({ checked: 0, closed: 0, results: [] });
    const allIdeas = listIdeas();
    const results = [];

    for (const pos of open) {
      const dir = pos.vehicle === "OPTION"
        ? (pos.optionType === "call" ? 1 : -1)
        : (pos.side === "sell_short" ? -1 : 1);

      // 1. Already closed by its own real stop — reconcile, don't re-decide.
      const brokerStop = await checkBrokerStopFill(pos);
      if (brokerStop?.filled) {
        if (dryRun) { results.push({ symbol: pos.symbol, wouldClose: true, tag: "stop_hit", detail: "Resting stop already filled on Tradier" }); continue; }
        const underlyingPx = await underlyingQuote(pos.symbol);
        try {
          journalClose(pos, {
            exitOrderId: pos.entryOrderId, exitOrderStatus: "filled",
            exitQuantity: pos.entryQuantity, exitFillPrice: brokerStop.price,
            exitReason: "Stop-loss filled on Tradier", exitReasonTag: "stop_hit",
            underlyingPriceAtClose: underlyingPx,
          });
        } catch (e) { console.error("autoexit journal write failed:", e); }
        results.push({ symbol: pos.symbol, closed: true, tag: "stop_hit", detail: `Stop filled at $${brokerStop.price}`, exitPrice: brokerStop.price });
        continue;
      }

      // 2. Already past expiration — settles on the underlying's close that
      // day, not on a live quote that no longer exists. Target/invalidation/
      // reversal checks below don't apply to something already resolved.
      if (pos.vehicle === "OPTION" && pos.expiration && new Date(pos.expiration) < new Date()) {
        const settle = await expirationSettlement(pos);
        if (settle) {
          if (dryRun) { results.push({ symbol: pos.symbol, wouldClose: true, tag: "expired", detail: `Expired ${settle.settlePrice > 0 ? "in the money" : "worthless"} — underlying closed $${settle.underlyingClose} on ${pos.expiration}` }); continue; }
          try {
            journalClose(pos, {
              exitOrderId: null, exitOrderStatus: null, exitQuantity: pos.entryQuantity, exitFillPrice: settle.settlePrice,
              exitReason: `Expired ${settle.settlePrice > 0 ? `in the money (intrinsic $${settle.settlePrice.toFixed(2)})` : "worthless"} — underlying closed $${settle.underlyingClose} on ${pos.expiration}`,
              exitReasonTag: "expired", underlyingPriceAtClose: settle.underlyingClose,
            });
          } catch (e) { console.error("autoexit expiration reconcile failed:", e); }
          results.push({ symbol: pos.symbol, closed: true, tag: "expired", detail: `Settled at $${settle.settlePrice.toFixed(2)} intrinsic`, exitPrice: settle.settlePrice });
          continue;
        }
        // No historical close found either — fall through to the orphaned
        // path below rather than get stuck here forever.
      }

      const range = await underlyingDayRange(pos.symbol);
      const underlyingPx = range?.last ?? null;
      // Favorable direction checks the day's HIGH (calls) or LOW (puts) so a
      // spike that already touched target isn't missed just because price
      // has since pulled back; the adverse direction (invalidation) uses the
      // opposite extreme for the same reason — the worst print of the day is
      // what actually breached the level, even if price has since recovered.
      const favorableExtreme = dir > 0 ? range?.high : range?.low;
      let exit = null;

      // Options: price the contract itself up front, both to judge the
      // premium gain below and to reuse as the closing price further down.
      const oq = pos.vehicle === "OPTION" ? await optionQuote(pos.occ) : null;
      const livePremium = oq ? (oq.bid > 0 ? oq.bid : oq.mid) : null;
      const entryPremium = Number(pos.entryFillPrice ?? pos.entryLimitPrice) || null;
      // Gain on what was actually paid, measured on the contract premium for
      // options and on the share price for shares.
      const markNow = pos.vehicle === "OPTION" ? livePremium : underlyingPx;
      const takeProfitBar = pos.vehicle === "OPTION" ? PREMIUM_TAKE_PROFIT_PCT : SHARE_TAKE_PROFIT_PCT;
      const gainPct = markNow > 0 && entryPremium > 0 && dir > 0
        ? ((markNow - entryPremium) / entryPremium) * 100
        : null;

      // 1b. Already up enough to bank, target or not.
      if (gainPct != null && gainPct >= takeProfitBar) {
        exit = {
          tag: "take_profit",
          detail: `Up ${gainPct.toFixed(0)}% ($${entryPremium} to $${markNow}) — banking it rather than waiting on the ${pos.target != null ? `$${pos.target} target` : "target it never had"}`,
        };
      }

      // 2. Target hit — anywhere in today's range, not just the current tick.
      if (!exit && pos.target != null && favorableExtreme != null) {
        const hit = dir > 0 ? favorableExtreme >= pos.target : favorableExtreme <= pos.target;
        if (hit) exit = { tag: "target", detail: `Hit its $${pos.target} target intraday (day's ${dir > 0 ? "high" : "low"} $${favorableExtreme}, now $${underlyingPx})` };
      }
      // 3. Invalidation breached with no stop to have caught it. Deliberately
      // asymmetric with the target check above: this one stays on the LIVE
      // price, not the day's extreme. A one-tick wick through the level that
      // has already recovered (seen live: a $228.465 low against a $228.50
      // invalidation, price back at $230.87 within the hour) would otherwise
      // force a realized loss on a position that is currently working and
      // still has weeks to expiry. Catching a missed win is free; manufacturing
      // a loss out of a recovered wick is not.
      if (!exit && pos.invalidation != null && underlyingPx != null) {
        const hit = dir > 0 ? underlyingPx <= pos.invalidation : underlyingPx >= pos.invalidation;
        if (hit) exit = { tag: "invalidation", detail: `Breached its $${pos.invalidation} invalidation with no stop resting to catch it (underlying now $${underlyingPx})` };
      }
      // 4. Thesis reversed.
      if (!exit) {
        const latest = latestIdeaForSymbol(allIdeas, pos.symbol, pos.ideaId);
        const latestDir = latest ? DIRECTION[latest.action] : undefined;
        if (latest && latestDir && latestDir !== dir) {
          exit = { tag: "reversed", detail: `Latest read flipped to ${latest.action} — ${latest.why_plain || latest.why_pro || "no reason given"}` };
        }
      }

      if (!exit) { results.push({ symbol: pos.symbol, closed: false }); continue; }
      if (dryRun) { results.push({ symbol: pos.symbol, wouldClose: true, ...exit }); continue; }

      let exitPrice, closeResult;
      if (pos.vehicle === "OPTION") {
        exitPrice = livePremium; // already priced above for the gain check
        if (!(exitPrice > 0)) { results.push({ symbol: pos.symbol, closed: false, reason: "no live quote to close against" }); continue; }
        closeResult = await closeOption(pos, exitPrice);
      } else {
        exitPrice = underlyingPx;
        if (!(exitPrice > 0)) { results.push({ symbol: pos.symbol, closed: false, reason: "no live quote to close against" }); continue; }
        closeResult = await closeShares(pos, exitPrice);
      }

      if (!closeResult.ok) {
        // "No open position found" / "have 0, closing sell 1" means Tradier
        // has already confirmed there is nothing left to close — not a
        // failure, a fact. Almost always an orphaned journal row from the
        // duplicate-stacking bug fixed earlier (several rows pointing at one
        // real contract that was already closed once for real). Left
        // "open" it would fail this exact way forever; reconcile it closed
        // instead, with no invented fill price or P&L since none is known.
        if (/does not match an open position|No open .* position found/i.test(closeResult.error || "")) {
          try {
            journalClose(pos, {
              exitOrderId: null, exitOrderStatus: null, exitQuantity: pos.entryQuantity, exitFillPrice: null,
              exitReason: "No matching real position found on Tradier — orphaned journal row (pre-dates the duplicate-stacking fix), reconciled closed with no P&L computed.",
              exitReasonTag: "orphaned", underlyingPriceAtClose: underlyingPx,
            });
          } catch (e) { console.error("autoexit orphan reconcile failed:", e); }
          results.push({ symbol: pos.symbol, closed: true, tag: "orphaned", detail: "No real position found — reconciled closed, no P&L" });
          continue;
        }
        results.push({ symbol: pos.symbol, closed: false, ...exit, error: closeResult.error });
        continue;
      }
      try {
        journalClose(pos, {
          exitOrderId: closeResult.orderResult?.id ?? null, exitOrderStatus: closeResult.orderResult?.status ?? null,
          exitQuantity: pos.entryQuantity, exitFillPrice: exitPrice,
          exitReason: exit.detail, exitReasonTag: exit.tag,
          underlyingPriceAtClose: underlyingPx,
        });
      } catch (e) { console.error("autoexit journal write failed:", e); }

      results.push({ symbol: pos.symbol, closed: true, ...exit, exitPrice, order: closeResult.orderResult });
    }

    return NextResponse.json({ checked: open.length, closed: results.filter((r) => r.closed).length, results });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
