import { NextResponse } from "next/server";
import { vetOrder, vetEquityOrder, submitOrder, confirmOrderFill, confirmEntryFill, reservedQuantities } from "../common";
import { tradier, asArray } from "../../tradier";
import { tradeFetch, accountId, isPaperSandbox } from "../../tradeClient";
import { listJournal, listIdeas, updateJournalEntry } from "../../store";
import { journalClose } from "../../journalLib";
import { dailyBars } from "../../historyCache";
import { markActivity } from "../../activityLib";
import { accountSize } from "../../accountLib";
import { notifySold } from "../../notifyLib";
import { exitConfig, directionOf, heldQuantity, intrinsicAtExpiry, updatePeak, gainFigures, decideProfitExit, decideLevelExit, decideReversalExit, isExpired, carriesOvernight } from "../exitRules";

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

/* Every threshold lives in exitRules.js with the trades that set it, and
   is a function of the account size. This route only decides what to
   fetch and what to send; the rules decide what to do. */
const CFG = exitConfig(accountSize());

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
    // The bid is what a share sale realises; last can sit above it.
    const bid = Number(q?.bid) > 0 ? Number(q.bid) : null;
    return { last, high, low, bid };
  } catch {
    return null;
  }
}

async function optionQuote(occ) {
  try {
    /* The real-time feed, the only one a real account has. This used to read
       the sandbox's delayed feed so the mark matched the sandbox's fills; with
       fills simulated on real-time quotes there is one clock for everything. */
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(occ)}`);
    const q = asArray(d?.quotes?.quote)?.[0];
    const bid = Number(q?.bid), ask = Number(q?.ask);
    return {
      bid, ask, mid: bid >= 0 && ask > 0 ? (bid + ask) / 2 : null, last: Number(q?.last) || null,
      // The contract's own intraday high — lets the trail know about a spike
      // that happened between cron runs instead of only peaks it watched live.
      high: Number(q?.high) || null,
    };
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
    const intrinsic = intrinsicAtExpiry(pos.optionType, pos.strike, closePx);
    if (intrinsic == null) return null;
    return { settlePrice: intrinsic, underlyingClose: closePx };
  } catch {
    return null;
  }
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

/* How much of each symbol is already committed to a resting sell-stop.
   In the Tradier sandbox that quantity cannot be sold by any new order, and
   the stop can be neither cancelled (DELETE returns {status:"ok"} and the
   leg stays put, whether addressed by parent order id or by its own leg id)
   nor modified ("Backoffice rejected override of the order."). Submitting a
   close anyway just produces a rejected order every run, so the reservation
   is checked BEFORE attempting rather than discovered afterwards.
   Status matters: a resting stop leg reads "open" as often as "held", and
   only matching "held" missed most of the book. */


async function cancelResting(orderId) {
  if (!orderId) return;
  try { await tradeFetch(`/accounts/${await accountId()}/orders/${orderId}`, { method: "DELETE" }); } catch {}
}

const ENTRY_REST_MAX_MIN = 5; // how long an unfilled entry may rest before it is withdrawn

async function closeOption(pos, exitPrice, { duration = "day" } = {}) {
  await cancelResting(pos.entryOrderId); // the resting stop leg — about to be replaced by this close
  const body = {
    legs: [{ action: "sell", type: pos.optionType, strike: String(pos.strike), premium: String(exitPrice), qty: String(heldQuantity(pos) || 1), occ: pos.occ }],
    closing: true,
    duration,
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

async function closeShares(pos, exitPrice, { duration = "day" } = {}) {
  await cancelResting(pos.entryOrderId);
  const body = {
    equity: { symbol: pos.symbol, quantity: heldQuantity(pos), price: exitPrice },
    closing: true,
    duration,
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

async function run(req) {
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "true";
  const eod = params.get("eod") === "true";
  // An eodMin query param is IGNORED. Callers used to pass eodMin=200, a flat
  // dollar figure that only means anything at one account size; the bar now
  // always comes from the account (exitConfig in exitRules.js), so a stale
  // caller cannot quietly set a bar that is 20% of a $1,000 position.
  try {
    const open = listJournal().filter((r) => r.status === "open");
    if (!open.length) return NextResponse.json({ checked: 0, closed: 0, accountSize: CFG.account, eodBarUsd: Number(CFG.eodTakeProfitUsd.toFixed(2)), results: [] });
    /* AI ideas only, matching the entry path. autotrade already filters
       `!i.strategy` so "a sweep scan landing last must never become this
       route's latest idea for a symbol" — the reversal rule needs the same
       guard, or a sweep-detector signal can close an AI position whose entry
       path would never have considered that signal in the first place.
       Latent today: no idea in the ledger carries a strategy tag yet. It stops
       being latent the first time the sweeps detector logs one. */
    const allIdeas = listIdeas().filter((i) => !i.strategy);
    // Only the sandbox freezes quantity behind a stop; anywhere else the stop is
    // simply cancelled before the sell (see cancelResting).
    const reserved = isPaperSandbox() ? await reservedQuantities() : null;
    const results = [];

    for (let pos of open) {
      let booked = null; // the journal row as closed, when this pass closed it
      /* Establish the real entry price before anything is measured against it.
         journalReconcile stamps entryFillPrice, but it is throttled to once a
         minute and a position can open and close before it ever runs — INTC
         10/23 $125c did exactly that, so every percentage, the trail peak and
         the final P&L were all measured against the $8.48 limit while the
         broker had filled $8.45. Fixing it here rather than at each
         journalClose covers the gain math too, since entryPremium below reads
         the same field. */
      if (pos.entryFillPrice == null && pos.entryOrderId) {
        const got = await confirmEntryFill(pos.entryOrderId);
        if (got?.filled) {
          pos = { ...pos, entryFillPrice: got.price, entryFilledQuantity: got.quantity };
          if (!dryRun) {
            try { updateJournalEntry(pos.id, { entryFillPrice: got.price, entryFilledQuantity: got.quantity }); } catch {}
          }
        }
      }
      /* Still no fill: this row is a working ORDER, not a position, and no
         exit rule applies to it. Found on the first simulated-broker test: a buy
         resting below the market was read as "up 211%" against its own limit,
         and the attempt to sell it cancelled the entry order on the way. The
         sandbox filled nearly everything on arrival, so this never showed.
         An entry is priced at the ask to fill now. If the market has moved off
         it, a fill minutes later happens on a pullback rather than on the
         breakout the idea was written for, so the order is withdrawn instead. */
      if (pos.entryFillPrice == null && pos.entryOrderId) {
        const restingMin = (Date.now() - new Date(pos.entryAt || pos.createdAt).getTime()) / 60000;
        if (restingMin >= ENTRY_REST_MAX_MIN && !dryRun) {
          await cancelResting(pos.entryOrderId);
          results.push({ symbol: pos.symbol, closed: false, reason: `entry order unfilled after ${restingMin.toFixed(0)} min — cancelled rather than left to fill on a pullback` });
        } else {
          results.push({ symbol: pos.symbol, closed: false, reason: `entry order still working (${restingMin.toFixed(0)} min) — not a position yet` });
        }
        continue;
      }
      const dir = directionOf(pos);

      // 0. A close was already submitted for this row on an earlier run and
      // is not yet confirmed filled. Never re-submit (that stacks duplicate
      // sells) and never book P&L until the broker confirms a price.
      if (pos.pendingExitOrderId) {
        const outcome = await confirmOrderFill(pos.pendingExitOrderId);
        if (outcome?.filled) {
          if (dryRun) { results.push({ symbol: pos.symbol, wouldClose: true, tag: pos.pendingExitTag || "closed", detail: `Pending close filled at $${outcome.price}` }); continue; }
          try {
            booked = journalClose(pos, {
              exitOrderId: pos.pendingExitOrderId, exitOrderStatus: "filled",
              exitQuantity: outcome.quantity || pos.entryQuantity, exitFillPrice: outcome.price,
              exitReason: pos.pendingExitReason || "Auto-exit close filled",
              exitReasonTag: pos.pendingExitTag || "closed",
              underlyingPriceAtClose: await underlyingQuote(pos.symbol),
            });
          } catch (e) { console.error("autoexit pending-close write failed:", e); }
          results.push({ symbol: pos.symbol, closed: true, tag: pos.pendingExitTag || "closed", detail: `Close filled at $${outcome.price}`, exitPrice: outcome.price, pnl: booked?.pnl ?? null, instrument: pos.occ ?? pos.symbol, quantity: heldQuantity(pos) });
          continue;
        }
        if (outcome && !outcome.dead) {
          results.push({ symbol: pos.symbol, closed: false, reason: `close order ${pos.pendingExitOrderId} still ${outcome.status} — waiting on the fill, not re-submitting` });
          continue;
        }
        // Order died without filling — clear it and let the checks below
        // decide again from scratch.
        if (!dryRun) { try { updateJournalEntry(pos.id, { pendingExitOrderId: null, pendingExitTag: null, pendingExitReason: null }); } catch {} }
      }

      // 1. Already closed by its own real stop — reconcile, don't re-decide.
      const brokerStop = await checkBrokerStopFill(pos);
      if (brokerStop?.filled) {
        if (dryRun) { results.push({ symbol: pos.symbol, wouldClose: true, tag: "stop_hit", detail: "Resting stop already filled on Tradier" }); continue; }
        const underlyingPx = await underlyingQuote(pos.symbol);
        try {
          booked = journalClose(pos, {
            exitOrderId: pos.entryOrderId, exitOrderStatus: "filled",
            exitQuantity: pos.entryQuantity, exitFillPrice: brokerStop.price,
            exitReason: "Stop-loss filled on Tradier", exitReasonTag: "stop_hit",
            underlyingPriceAtClose: underlyingPx,
          });
        } catch (e) { console.error("autoexit journal write failed:", e); }
        results.push({ symbol: pos.symbol, closed: true, tag: "stop_hit", detail: `Stop filled at $${brokerStop.price}`, exitPrice: brokerStop.price, pnl: booked?.pnl ?? null, instrument: pos.occ ?? pos.symbol, quantity: heldQuantity(pos) });
        continue;
      }

      // 2. Already past expiration — settles on the underlying's close that
      // day, not on a live quote that no longer exists. Target/invalidation/
      // reversal checks below don't apply to something already resolved.
      if (pos.vehicle === "OPTION" && pos.expiration && isExpired(pos.expiration)) { // exitRules.isExpired: from 16:00 ET on the expiry date
        const settle = await expirationSettlement(pos);
        if (settle) {
          if (dryRun) { results.push({ symbol: pos.symbol, wouldClose: true, tag: "expired", detail: `Expired ${settle.settlePrice > 0 ? "in the money" : "worthless"} — underlying closed $${settle.underlyingClose} on ${pos.expiration}` }); continue; }
          try {
            booked = journalClose(pos, {
              exitOrderId: null, exitOrderStatus: null, exitQuantity: pos.entryQuantity, exitFillPrice: settle.settlePrice,
              exitReason: `Expired ${settle.settlePrice > 0 ? `in the money (intrinsic $${settle.settlePrice.toFixed(2)})` : "worthless"} — underlying closed $${settle.underlyingClose} on ${pos.expiration}`,
              exitReasonTag: "expired", underlyingPriceAtClose: settle.underlyingClose,
            });
          } catch (e) { console.error("autoexit expiration reconcile failed:", e); }
          results.push({ symbol: pos.symbol, closed: true, tag: "expired", detail: `Settled at $${settle.settlePrice.toFixed(2)} intrinsic`, exitPrice: settle.settlePrice, pnl: booked?.pnl ?? null, instrument: pos.occ ?? pos.symbol, quantity: heldQuantity(pos) });
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
      /* Value the contract at the BID: that is what selling it right now
         realises, and the sell is submitted there. This was the MID for a
         while, because the sandbox filled above the real-time bid (its fill
         feed lagged), so the bid understated a sale. That was a property of the
         simulator's lag, not of a market. On one real-time feed a marketable
         sell gets the bid, so a gain measured at the mid is money that is not
         there — and the end-of-day bar and the trail both bank "gains". */
      const livePremiumBid = oq ? (oq.bid > 0 ? oq.bid : oq.mid) : null;
      const livePremium = livePremiumBid;
      const entryPremium = Number(pos.entryFillPrice ?? pos.entryLimitPrice) || null;
      // Gain on what was actually paid, measured on the contract premium for
      // options and on the share price for shares.
      const sharesBid = range?.bid ?? underlyingPx;
      const markNow = pos.vehicle === "OPTION" ? livePremium : (dir > 0 ? sharesBid : underlyingPx);
      // Peak and gain figures — see exitRules.js for what each one means and
      // the trades (SPCX, AVGO, MRVL, the first put) that shaped them.
      const enteredAt = pos.entryFilledAt || pos.entryAt || pos.createdAt;
      const enteredToday = enteredAt && new Date(enteredAt).toDateString() === new Date().toDateString();
      const dayHigh = pos.vehicle === "OPTION" ? Number(oq?.high) : Number(range?.high);
      const spread = pos.vehicle === "OPTION" && oq?.ask > 0 && oq?.bid >= 0 ? oq.ask - oq.bid : 0;
      const peakMark = updatePeak({ previousPeak: pos.peakMark, markNow, dayHigh, spread, enteredToday });
      if (!dryRun && peakMark > (Number(pos.peakMark) || 0)) {
        try { updateJournalEntry(pos.id, { peakMark }); } catch {}
      }
      const qty = heldQuantity(pos);
      const { gainPct, gainUsd, peakGainPct, peakGainUsd } = gainFigures({ vehicle: pos.vehicle, dir, markNow, entryPremium, peakMark, qty });
      /* The loss rules are judged at the option's MID (exitRules.decideProfitExit):
         at the bid, a wide-spread contract starts most of the way to its stop. */
      const midNow = pos.vehicle === "OPTION" && oq?.bid > 0 && oq?.ask > 0 ? (oq.bid + oq.ask) / 2 : markNow;
      const lossFig = gainFigures({ vehicle: pos.vehicle, dir, markNow: midNow, entryPremium, peakMark, qty });

      /* 1a. Explicit breakeven exit, set per position (exitAtBreakeven) when
         the plan becomes "get out of this without a loss" rather than "wait
         for the thesis". Checked before every profit rule, because the point
         is to leave at the first opportunity, not to hold for more. Uses the
         MID for options (see the mark above) rather than the last trade, so
         breakeven means a price a sale would actually realise and not merely
         a stale print — while staying honest that the bid alone understates
         what this sandbox fills at. */
      /* Breakeven exits are a RESTING order, not a polled comparison. A level
         cannot be hit by checking every 15 minutes: the NVDA $230c was flagged
         to leave at $8.15, and by the time a check observed it the bid was
         $7.75 — the price was gone before anything looked. So once, for a
         flagged position, place a GTC sell limit AT the entry and let the
         market come to it. The pendingExitOrderId machinery above then does
         the rest: it confirms the real fill whenever it happens, never books
         P&L before the broker agrees, and never re-submits while the order is
         still working. Resting sells reserve the quantity in this sandbox,
         which is normally the FROZEN problem — here it is the intent, since
         the whole plan for this position is "get out at entry". */
      // Already at or above entry: take it now. Resting a limit at entry when
      // the market is already through it only invites a worse fill than the
      // one on offer.
      if (!exit && pos.exitAtBreakeven && markNow > 0 && entryPremium > 0 && markNow >= entryPremium) {
        exit = {
          tag: "breakeven",
          detail: `Mark $${markNow} (bid) is at or above the $${entryPremium} entry — closing flat-or-better now rather than resting an order`,
        };
      }

      if (!exit && pos.exitAtBreakeven && !pos.pendingExitOrderId && entryPremium > 0) {
        if (dryRun) {
          results.push({ symbol: pos.symbol, closed: false, reason: `Would rest a GTC sell at the $${entryPremium} entry (bid $${markNow})` });
          continue;
        }
        const rest = pos.vehicle === "OPTION"
          ? await closeOption(pos, entryPremium, { duration: "gtc" })
          : await closeShares(pos, entryPremium, { duration: "gtc" });
        if (rest.ok) {
          const restId = rest.orderResult?.id ?? null;
          try {
            updateJournalEntry(pos.id, {
              pendingExitOrderId: restId,
              pendingExitTag: "breakeven",
              pendingExitReason: `Resting GTC sell at the $${entryPremium} entry — exits flat the moment the market trades there`,
              exitOrderStatus: "resting",
            });
          } catch (e) { console.error("autoexit resting-breakeven write failed:", e); }
          results.push({ symbol: pos.symbol, closed: false, reason: `Resting GTC sell placed at $${entryPremium} (order ${restId}) — will fill flat if the market trades back to entry` });
        } else if (/does not match an open position|No open .* position found/i.test(rest.error || "")) {
          // No position behind the row — the entry never filled. Reconcile it
          // shut with no invented price rather than retrying a rest forever.
          try {
            booked = journalClose(pos, {
              exitOrderId: null, exitOrderStatus: null, exitQuantity: pos.entryQuantity, exitFillPrice: null,
              exitReason: "Flagged for a breakeven exit, but the broker holds no such position — the entry never filled. Reconciled closed with no P&L.",
              exitReasonTag: "orphaned", underlyingPriceAtClose: underlyingPx,
            });
          } catch (e) { console.error("autoexit breakeven orphan reconcile failed:", e); }
          results.push({ symbol: pos.symbol, closed: true, tag: "orphaned", detail: "No real position behind the row — reconciled closed, no P&L" });
        } else {
          results.push({ symbol: pos.symbol, closed: false, error: `Could not rest a breakeven sell at $${entryPremium}: ${rest.error}` });
        }
        continue;
      }

      // 1b. Max loss, end-of-day banking, the short-dated quick target, the
      // outright ceiling and the trail, in that order (exitRules.js). The
      // ceiling relabels an earlier exit on purpose, so it may replace one.
      const profitExit = decideProfitExit(CFG, {
        vehicle: pos.vehicle, closeByEod: pos.closeByEod, eod,
        gainPct, gainUsd, peakGainPct, peakGainUsd, peakMark, entryPremium, markNow,
        stopPct: pos.stopPct ?? null, lossGainPct: lossFig.gainPct, lossGainUsd: lossFig.gainUsd,
        carry: carriesOvernight(pos), // exitRules: options with 14+ days left are held overnight
      });
      if (profitExit && (!exit || profitExit.tag === "take_profit")) exit = profitExit;

      // 2-3. The plan's own target and invalidation. 4. Thesis reversed.
      if (!exit) exit = decideLevelExit({ dir, target: pos.target, invalidation: pos.invalidation, strategy: pos.strategy, underlyingPx, favorableExtreme });
      if (!exit) exit = decideReversalExit({ pos, dir, ideas: allIdeas });

      if (!exit) { results.push({ symbol: pos.symbol, closed: false }); continue; }

      // Decided to exit — but if the broker has this quantity reserved behind
      // a resting stop, no sell can be placed at all. Say so once instead of
      // firing an order that is certain to be rejected on every future run.
      const resKey = pos.vehicle === "OPTION" ? pos.occ : pos.symbol;
      const reservedQty = reserved?.get(resKey) ?? 0;
      if (reserved && reservedQty >= (heldQuantity(pos) || 1)) {
        /* Stamp `frozen` on the row the first time this is seen, so every other
           reader can take these out of its totals instead of each one
           rediscovering the reservation. Four rows (GLND x2, NVDA 10/16 x2)
           have produced an identical FROZEN line on every check for days while
           holding ~$1,000 that can never be realised — real at the broker,
           unreachable, and not a decision anyone can act on. Cleared again if
           the reservation ever lifts, since only the stop firing releases it. */
        if (!dryRun && !pos.frozen) {
          try { updateJournalEntry(pos.id, { frozen: true, frozenSince: new Date().toISOString(), frozenQty: reservedQty }); } catch {}
        }
        results.push({
          symbol: pos.symbol, closed: false, frozen: true, ...exit,
          error: `FROZEN — all ${reservedQty} held by a resting stop the sandbox will not cancel or modify, so no sell can be placed. Only that stop firing can exit it.`,
        });
        continue;
      }
      if (!dryRun && pos.frozen && !(reserved && reservedQty > 0)) {
        // Reservation lifted (the stop fired or was cleared) — the row is live again.
        try { updateJournalEntry(pos.id, { frozen: false, frozenSince: null, frozenQty: null }); } catch {}
      }

      if (dryRun) { results.push({ symbol: pos.symbol, wouldClose: true, ...exit }); continue; }

      let exitPrice, closeResult;
      if (pos.vehicle === "OPTION") {
        // A limit at the bid is the one that fills.
        exitPrice = livePremiumBid;
        if (!(exitPrice > 0)) { results.push({ symbol: pos.symbol, closed: false, reason: "no live quote to close against" }); continue; }
        closeResult = await closeOption(pos, exitPrice);
      } else {
        exitPrice = dir > 0 ? sharesBid : underlyingPx;
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
        // Inventory reserved by a resting bracket stop that the sandbox will
        // not release: the cancel returns {status:"ok"} but the stop leg
        // stays "held", and a modify is refused with "Backoffice rejected
        // override of the order." The shares/contracts genuinely exist and
        // are genuinely up, but cannot be sold — so say that plainly instead
        // of retrying forever or reconciling it away as if it were gone.
        if (/more shares than your current long position|than your current long position/i.test(closeResult.error || "")) {
          results.push({
            symbol: pos.symbol, closed: false, ...exit,
            error: "FROZEN — quantity is held by a resting bracket stop the sandbox refuses to cancel or modify, so no new sell can be placed. Only its own stop firing can exit this.",
          });
          continue;
        }
        if (/does not match an open position|No open .* position found/i.test(closeResult.error || "")) {
          try {
            booked = journalClose(pos, {
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
      // The order was ACCEPTED. That is not a fill. Confirm with the broker
      // before writing any P&L — booking the submitted limit as though it
      // were a fill is what produced $186.50 of GLND profit that never
      // existed while the shares were still sitting in the account.
      const exitOrderId = closeResult.orderResult?.id ?? null;
      const outcome = await confirmOrderFill(exitOrderId);

      if (outcome?.filled) {
        try {
          booked = journalClose(pos, {
            exitOrderId, exitOrderStatus: "filled",
            exitQuantity: outcome.quantity || pos.entryQuantity, exitFillPrice: outcome.price,
            exitReason: exit.detail, exitReasonTag: exit.tag,
            underlyingPriceAtClose: underlyingPx,
          });
        } catch (e) { console.error("autoexit journal write failed:", e); }
        results.push({ symbol: pos.symbol, closed: true, ...exit, exitPrice: outcome.price, order: closeResult.orderResult, pnl: booked?.pnl ?? null, instrument: pos.occ ?? pos.symbol, quantity: outcome.quantity || heldQuantity(pos) });
        continue;
      }

      // Submitted but not filled yet. Remember the order so the next run
      // confirms it instead of deciding again and stacking another sell.
      try {
        updateJournalEntry(pos.id, {
          pendingExitOrderId: exitOrderId,
          pendingExitTag: exit.tag,
          pendingExitReason: exit.detail,
          exitOrderStatus: outcome?.status ?? "submitted",
        });
      } catch (e) { console.error("autoexit pending-exit write failed:", e); }
      results.push({
        symbol: pos.symbol, closed: false, ...exit,
        reason: `close submitted at $${exitPrice} (order ${exitOrderId}) but not filled yet — no P&L booked until the broker confirms`,
      });
    }

    return NextResponse.json({ checked: open.length, closed: results.filter((r) => r.closed).length, accountSize: CFG.account, eodBarUsd: Number(CFG.eodTakeProfitUsd.toFixed(2)), results });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}

/* One run at a time. The Mac-side schedule and a chat-side check can fire in
   the same second, and every gate here reads the journal before either run has
   written to it — so two overlapping runs would each see "nothing open" and
   both act. Queued, the second run sees what the first one did. */
let queue = Promise.resolve();
export function GET(req) {
  const next = queue.then(async () => {
    const res = await run(req);
    if (new URL(req.url).searchParams.get("dryRun") !== "true") {
      try {
        const d = await res.clone().json();
        markActivity("exits", { ok: !d.error, error: d.error ?? null, checked: d.checked ?? 0, closed: d.closed ?? 0 });
        for (const r of d.results || []) if (r.closed && r.pnl != null) notifySold({ symbol: r.symbol, instrument: r.instrument, quantity: r.quantity, price: r.exitPrice, pnl: r.pnl, tag: r.tag }).catch(() => {});
      } catch {}
    }
    return res;
  });
  queue = next.catch(() => {});
  return next;
}
