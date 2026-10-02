import { NextResponse } from "next/server";
import { vetOrder, vetEquityOrder, submitOrder, confirmOrderFill, confirmEntryFill, reservedQuantities } from "../common";
import { tradier, asArray, tradierDelayed } from "../../tradier";
import { tradeFetch, accountId } from "../../tradeClient";
import { listJournal, listIdeas, updateJournalEntry } from "../../store";
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
/* Middle ground between "sell at a flat number" and "hold for target".
   A flat bar is wrong in both directions: +80% almost never triggered (the
   best position in this book has reached +32%), while a flat +50% would have
   dumped the NVDA $225c at ~$4.70 for +$157 when it went on to print $8.78.
   Instead: arm a trail once a position is meaningfully up, track its peak,
   and exit when it gives back part of that peak GAIN. Checked against the
   two real cases:
     NVDA $225c  $3.13 -> peak $8.78 -> trail exit ~$7.09  = +$396
                 (flat 50% = +$157, flat 80% = +$250)
     GLND        $2.83 -> peak $5.705 -> trail exit ~$4.84 = +$201
                 (never triggered at all under a flat 80%)
   Arming at 40% with a 30% giveback of the gain means an armed position can
   only ever exit profitable (worst case ~+28%), so this never turns a winner
   into a loser. Shares arm lower because share ideas here target +3-11%. */
/* OPTION lowered 40 -> 8 on 2026-10-02. The +40% bar was calibrated when a
   position was a few hundred dollars and a contract routinely doubled. At
   10%-of-account sizing it is simply unreachable: across the 11 closed
   account-sized option positions (cost > $7k) with a recorded peak, the peak
   gains were 4.1, 6.1, 7.9, 8.2, 8.7, 9.1, 9.4, 9.4, 10.3, 15.3 and 109.8
   percent — median 9.1%, and exactly ONE of eleven ever reached +40%. The
   trail was dead code for every position this book now opens.
   Re-simulated at a 30% giveback, arming at +8% would have turned two real
   losses into gains without capping the one runner: NVDA -$520 -> +$1,137 and
   INTC -$660 -> +$670, plus AVGO +$280 -> +$616, for +$3,348 across the set.
   The +$7,625 NVDA outlier is untouched — it peaked at 109.8% and never gave
   back 30%, so a giveback rule lets it ride. That is the whole reason this is
   an arm-and-trail change rather than a flat take-profit, which was checked
   separately and would have cost $5,625 on that single trade.
   Why 8 and not the simulation-optimal 4: the simulation assumes we sell at
   the giveback level exactly, and a 15-minute check can miss it; a 30%
   giveback off a +4% peak is a 1.2% band, which is noise and is precisely
   what made the old dollar-arm a hair-trigger. +8% gives a 2.4% band and
   keeps most of the benefit.
   SHARES deliberately UNCHANGED at 15 even though it is unreachable too
   (median share peak 3.0%, and +15% was reached only by the two DXST lots).
   Getting any benefit there needs a +2% arm, which is a 0.6% band — pure
   noise — and the whole result rests on two positions, ROG and NOK. Shares
   are covered by the $200 end-of-day dollar bar instead, which is what
   actually banked FEIM (+$156) and NOK (+$191). Revisit with more rows. */
const TRAIL_ARM_PCT = { OPTION: 8, SHARES: 15 };
/* A dollar-based arm (peak gain >= $400) lived here briefly and was removed.
   It was added for MRVL showing "+$515" that round-tripped, but the
   bid-adjustment work established that peak was really +$240 / +2.8%, so the
   motivating case was spread illusion. Meanwhile it broke the trail on large
   positions: at 13 contracts a +4.3% peak clears $400, and 30% of a 4.3% gain
   is a 1.2% band, so the trail became a hair-trigger and exited the NVDA
   $230c at $7.75 on a blip instead of managing a real move. The trail is for
   meaningful gains giving back a meaningful share; percentage is the right
   unit for that, and position size does not change it. */
const TRAIL_GIVEBACK_PCT = 30;
/* ...but 30% of a very large gain is a lot of money to risk finding out.
   The NVDA 10/07 $232.50c (25 contracts, $3.05 entry) reached +100% / +$7,625
   and the trail tolerated a fall back to +70% before firing — a $2,288
   giveback. Nothing else in this book has ever been close: across 44 closed
   trades the median win is $500 and the second-best win ever is $975, so a
   gain past ~$2,000 is a different animal from the gains the 30% band was
   calibrated on, and this book's winners round-trip hard (INTC +$670 to
   -$1,690). Above TRAIL_TIGHTEN_USD the band halves.
   Note what this deliberately is NOT: a flat dollar take-profit. Checked
   against the record, a $2,000 ceiling would have fired on exactly one trade
   in 44 — that same NVDA — and banked $2,000 instead of $7,625. Capping the
   giveback keeps the whole upside of a position that is still climbing and
   only tightens what it may hand back. */
const TRAIL_TIGHTEN_USD = 2000;
const TRAIL_GIVEBACK_PCT_LARGE = 15;

// Absolute ceiling, separate from the trail: a position up this much is
// banked outright rather than risking a gap on the way back down.
const HARD_TAKE_PROFIT_PCT = { OPTION: 150, SHARES: 60 };

/* End-of-day profit taking, applied only when autoexit is called with
   ?eod=true (the 15:56 pre-close sweep). A gain that survives to the close is
   not a gain until it is realised: INTC closed +$670 across two call lots and
   reopened the next session at -$1,690, a $2,360 swing for the privilege of
   carrying it. MRVL did +$587 to +$25 and ROG +$587 to -$657 the same week —
   three round trips, no overnight carry that paid. The trail cannot catch
   these because it arms at +40% and none of them got near that in percentage
   terms; the gains were large in dollars and small in percent, which is what
   10%-of-account sizing produces. Dollar-denominated on purpose, since "a
   good daily profit" is a dollar question, not a ratio one. */
const EOD_TAKE_PROFIT_USD = 300;
/* ...but the caller can lower it. The 15:xx jobs pass eodMin=200, because the
   single 15:56 look at $300 was demonstrably too coarse: FEIM, a $24,325 share
   position, touched +$667 intraday and sat at +$180 late in the day, and every
   percentage rule read a 2.74% move on a quarter of the account as noise. A
   lower bar in the last hour banks the kind of gain that is real in dollars
   while still being invisible as a ratio. */

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
    /* SANDBOX feed on purpose — this values a PAPER position, so the right
       clock is the one the fill engine and the user's screen both use. See
       tradierDelayed in tradier.js for the measurement that settled it. */
    const d = await tradierDelayed(`/markets/quotes?symbols=${encodeURIComponent(occ)}`);
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
    if (!(closePx > 0)) return null;
    const intrinsic = pos.optionType === "call" ? Math.max(0, closePx - Number(pos.strike)) : Math.max(0, Number(pos.strike) - closePx);
    return { settlePrice: intrinsic, underlyingClose: closePx };
  } catch {
    return null;
  }
}

/* How old a read may be and still count as a REVERSAL of a live thesis.
   This used to be unbounded, and that was a real bug: the filter drops WAIT
   ideas and the position's own idea, then took the newest of whatever was
   left — which on a symbol with no other recent directional read is whatever
   is oldest in the ledger. The SPY 10/23 $772c was bought at 14:05 on a 13:46
   CALL; the 14:14 refresh returned WAIT (filtered out), so the "latest read"
   became a PUT from 2026-09-15 and the position was closed as "thesis
   reversed" on a SEVENTEEN-DAY-OLD read, 15 minutes after being opened.
   It fires precisely on fresh autotrade entries — the position's own idea has
   to be the newest directional one for the symbol — and 7 symbols were primed
   for it, NVDA, SPY, TSLA, QQQ, AAL, AMD and VEEA, each with an old opposite
   idea sitting in the ledger. NVDA is the one that matters most: a 2026-09-15
   PUT was ready to instantly close any new NVDA call, and NVDA calls are what
   this book actually makes money on.
   Two bounds now, and the first is the airtight one: a reversal must POSTDATE
   the thesis it contradicts. An older read is not a change of mind, it is just
   an older read. */
const REVERSAL_MAX_AGE_MIN = 120;

function latestIdeaForSymbol(ideas, symbol, excludeIdeaId, sinceMs) {
  const floor = Math.max(Date.now() - REVERSAL_MAX_AGE_MIN * 60000, Number(sinceMs) || 0);
  const rows = ideas.filter((i) =>
    i.symbol === symbol &&
    i.id !== excludeIdeaId &&
    ["CALL", "PUT", "BUY", "SELL"].includes(i.action) &&
    new Date(i.createdAt).getTime() > floor
  );
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

/* The quantity actually HELD, which is what a sell order and any P&L must be
   based on. entryQuantity is what was ORDERED; journalReconcile writes
   entryFilledQuantity from the broker's exec_quantity. They are equal on a
   clean fill and no row in the ledger has ever differed, but on a partial fill
   the ordered number is both too large to sell (the broker rejects a sell for
   more than the position) and wrong for the gain, which would be overstated by
   the unfilled remainder. Share orders here now run to thousands of shares, so
   a partial is a question of when, not whether. */
const heldQuantity = (pos) => Number(pos.entryFilledQuantity ?? pos.entryQuantity) || 0;

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

export async function GET(req) {
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "true";
  const eod = params.get("eod") === "true";
  const eodMin = Number(params.get("eodMin")) > 0 ? Number(params.get("eodMin")) : EOD_TAKE_PROFIT_USD;
  try {
    const open = listJournal().filter((r) => r.status === "open");
    if (!open.length) return NextResponse.json({ checked: 0, closed: 0, results: [] });
    /* AI ideas only, matching the entry path. autotrade already filters
       `!i.strategy` so "a sweep scan landing last must never become this
       route's latest idea for a symbol" — the reversal rule needs the same
       guard, or a sweep-detector signal can close an AI position whose entry
       path would never have considered that signal in the first place.
       Latent today: no idea in the ledger carries a strategy tag yet. It stops
       being latent the first time the sweeps detector logs one. */
    const allIdeas = listIdeas().filter((i) => !i.strategy);
    const reserved = await reservedQuantities();
    const results = [];

    for (let pos of open) {
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
      const dir = pos.vehicle === "OPTION"
        ? (pos.optionType === "call" ? 1 : -1)
        : (pos.side === "sell_short" ? -1 : 1);

      // 0. A close was already submitted for this row on an earlier run and
      // is not yet confirmed filled. Never re-submit (that stacks duplicate
      // sells) and never book P&L until the broker confirms a price.
      if (pos.pendingExitOrderId) {
        const outcome = await confirmOrderFill(pos.pendingExitOrderId);
        if (outcome?.filled) {
          if (dryRun) { results.push({ symbol: pos.symbol, wouldClose: true, tag: pos.pendingExitTag || "closed", detail: `Pending close filled at $${outcome.price}` }); continue; }
          try {
            journalClose(pos, {
              exitOrderId: pos.pendingExitOrderId, exitOrderStatus: "filled",
              exitQuantity: outcome.quantity || pos.entryQuantity, exitFillPrice: outcome.price,
              exitReason: pos.pendingExitReason || "Auto-exit close filled",
              exitReasonTag: pos.pendingExitTag || "closed",
              underlyingPriceAtClose: await underlyingQuote(pos.symbol),
            });
          } catch (e) { console.error("autoexit pending-close write failed:", e); }
          results.push({ symbol: pos.symbol, closed: true, tag: pos.pendingExitTag || "closed", detail: `Close filled at $${outcome.price}`, exitPrice: outcome.price });
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
      /* Value the contract at the MID, not the bid, for every exit DECISION.
         The bid systematically understates what a sale here realises, because
         the sandbox order engine prices off ~15-minute-delayed data and fills
         above the real-time bid. Measured on the AVGO 10/23 $355c: bid 12.30,
         ask 12.65, mid 12.475, actual fill 12.45 — the mid predicted the fill
         to 2.5 cents while the bid was off by 15 cents, which is $120 on 8
         contracts. Every option sold today filled at or above a limit set at
         the bid. At the bid that position read +$160 and would NOT have
         cleared the $200 end-of-day bar; it sold for +$280.
         The sell is still SUBMITTED at the bid (exitPrice = livePremiumBid
         below), so the fill stays assured — only the measurement moves.
         Tension worth naming: the peak seeding just below deliberately
         subtracts the spread from the day's high, decided after an MRVL
         "+$515" turned out to be ~+$240 once bid-adjusted. That was about not
         inventing a peak from a stale last-trade print, which still holds —
         so both now use the same mid convention (half the spread) and are
         measured consistently, rather than a bid-adjusted peak being compared
         against a mid-based current, which would flatter every giveback. */
      const livePremiumBid = oq ? (oq.bid > 0 ? oq.bid : oq.mid) : null;
      const livePremium = oq
        ? (oq.bid > 0 && oq.ask > 0 ? (oq.bid + oq.ask) / 2 : (oq.bid > 0 ? oq.bid : oq.mid))
        : null;
      const entryPremium = Number(pos.entryFillPrice ?? pos.entryLimitPrice) || null;
      // Gain on what was actually paid, measured on the contract premium for
      // options and on the share price for shares.
      const markNow = pos.vehicle === "OPTION" ? livePremium : underlyingPx;
      const gainPct = markNow > 0 && entryPremium > 0 && dir > 0
        ? ((markNow - entryPremium) / entryPremium) * 100
        : null;

      // Track the best mark this position has ever shown, so the trail has
      // a peak to measure the giveback against. Persisted on the row because
      // each cron run is a fresh process with no memory of the last one.
      // Seed from the instrument's own intraday high as well as the live
      // mark, so a spike that happened between two 15-minute runs still
      // counts. Without this the trail only ever knows the peaks it watched
      // live and would have been blind to the NVDA contract printing $8.78.
      /* The peak has to be measured in the same currency as the exit, and for
         options it was not. markNow is the BID (what we can actually sell at)
         while the seeded high came from oq.high, a LAST-TRADE price. On a wide
         contract that gap is the whole spread: MRVL 265c showed a $17.98 high
         against a $17.00/$17.55 market, so a "peak" was recorded at a price no
         seller could have got, and every giveback measured against it was
         overstated by ~3% of premium — enough to trip the trail early. Subtract
         the current spread to approximate what the bid was up there. Shares need
         no adjustment; their spreads are pennies. */
      const rawHigh = pos.vehicle === "OPTION" ? Number(oq?.high) : Number(range?.high);
      const spread = pos.vehicle === "OPTION" && oq?.ask > 0 && oq?.bid >= 0 ? oq.ask - oq.bid : 0;
      // Half the spread, matching the mid the current mark now uses.
      const todayHigh = rawHigh > 0 ? Math.max(0, rawHigh - spread / 2) : null;
      let peakMark = Math.max(Number(pos.peakMark) || 0, Number(todayHigh) || 0);
      if (markNow > 0 && markNow > peakMark) peakMark = markNow;
      if (!dryRun && peakMark > (Number(pos.peakMark) || 0)) {
        try { updateJournalEntry(pos.id, { peakMark }); } catch {}
      }
      const peakGainPct = peakMark > 0 && entryPremium > 0
        ? ((peakMark - entryPremium) / entryPremium) * 100
        : null;
      const armBar = TRAIL_ARM_PCT[pos.vehicle] ?? TRAIL_ARM_PCT.OPTION;
      // Dollar gain at the peak, which is what actually matters once positions
      // are sized to the account rather than to one contract.
      const mult = pos.vehicle === "OPTION" ? 100 : 1;
      const qty = heldQuantity(pos);
      const hardBar = HARD_TAKE_PROFIT_PCT[pos.vehicle] ?? HARD_TAKE_PROFIT_PCT.OPTION;

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
          detail: `Mark $${markNow} (mid) is at or above the $${entryPremium} entry — closing flat-or-better now rather than resting an order`,
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
            journalClose(pos, {
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

      // 1a-eod. Last look of the day: bank a real dollar gain rather than
      // carry it overnight. Deliberately ahead of the trail and the target,
      // because at 15:56 the question is no longer "is there more in this?"
      const gainUsd = markNow > 0 && entryPremium > 0 ? (markNow - entryPremium) * qty * mult : null;
      if (!exit && eod && gainUsd != null && gainUsd >= eodMin) {
        exit = {
          tag: "eod_take_profit",
          detail: `Up $${gainUsd.toFixed(0)} into the close (${gainPct != null ? gainPct.toFixed(1) + "%" : "?"}) — past the $${eodMin} late-session bar, banking it rather than carrying overnight gap risk`,
        };
      }

      // 1b. Outright ceiling — big enough that it goes in the book now.
      if (gainPct != null && gainPct >= hardBar) {
        exit = {
          tag: "take_profit",
          detail: `Up ${gainPct.toFixed(0)}% ($${entryPremium} to $${markNow}) — past the ${hardBar}% ceiling, banking it outright`,
        };
      }

      // 1c. Trailing take-profit: armed once the position has been up at
      // least armBar at some point, then exits on a giveback of that peak
      // gain. Compares against the PEAK, not the entry, so a winner that
      // rolls over is banked near its high instead of round-tripping.
      /* Arms on percentage OR dollars. Percentage alone was calibrated when a
         position was ~$800, where +6% is $48 of noise worth ignoring. The same
         +6% on an $8,475 position is $515, and MRVL rode exactly that from
         +$515 back to +$25 without ever approaching the +40% bar. This stays a
         GIVEBACK rule rather than a profit target: it only fires once a gain
         has largely been surrendered, so a position still climbing never trips
         it — the +127% NVDA winner would have been untouched. */
      if (!exit && peakGainPct != null && peakGainPct >= armBar && gainPct != null) {
        // Peak gain in dollars, from the same peak mark the percentage uses.
        const peakGainUsd = peakMark > 0 && entryPremium > 0 ? (peakMark - entryPremium) * qty * mult : null;
        const givebackPct = peakGainUsd != null && peakGainUsd >= TRAIL_TIGHTEN_USD
          ? TRAIL_GIVEBACK_PCT_LARGE
          : TRAIL_GIVEBACK_PCT;
        const keepAtLeast = peakGainPct * (1 - givebackPct / 100);
        if (gainPct <= keepAtLeast) {
          exit = {
            tag: "trail_stop",
            detail: `Peaked at +${peakGainPct.toFixed(0)}% ($${peakMark}${peakGainUsd != null ? `, +$${peakGainUsd.toFixed(0)}` : ""}) and gave back to +${gainPct.toFixed(0)}% ($${markNow}) — trailing exit at ${givebackPct}% giveback${givebackPct === TRAIL_GIVEBACK_PCT_LARGE ? ` (tightened: peak gain cleared $${TRAIL_TIGHTEN_USD})` : ""}, banking +${gainPct.toFixed(0)}%`,
          };
        }
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
        // Anchor to when this position's OWN thesis was written, so only a
        // genuinely later read can overturn it.
        const ownIdea = pos.ideaId ? allIdeas.find((i) => i.id === pos.ideaId) : null;
        const sinceMs = new Date(ownIdea?.createdAt || pos.createdAt || 0).getTime();
        const latest = latestIdeaForSymbol(allIdeas, pos.symbol, pos.ideaId, sinceMs);
        const latestDir = latest ? DIRECTION[latest.action] : undefined;
        if (latest && latestDir && latestDir !== dir) {
          exit = { tag: "reversed", detail: `Latest read flipped to ${latest.action} — ${latest.why_plain || latest.why_pro || "no reason given"}` };
        }
      }

      if (!exit) { results.push({ symbol: pos.symbol, closed: false }); continue; }

      // Decided to exit — but if the broker has this quantity reserved behind
      // a resting stop, no sell can be placed at all. Say so once instead of
      // firing an order that is certain to be rejected on every future run.
      const resKey = pos.vehicle === "OPTION" ? pos.occ : pos.symbol;
      const reservedQty = reserved?.get(resKey) ?? 0;
      if (reserved && reservedQty >= (heldQuantity(pos) || 1)) {
        results.push({
          symbol: pos.symbol, closed: false, ...exit,
          error: `FROZEN — all ${reservedQty} held by a resting stop the sandbox will not cancel or modify, so no sell can be placed. Only that stop firing can exit it.`,
        });
        continue;
      }

      if (dryRun) { results.push({ symbol: pos.symbol, wouldClose: true, ...exit }); continue; }

      let exitPrice, closeResult;
      if (pos.vehicle === "OPTION") {
        // Decide on the mid, SELL at the bid: a limit at the bid is the one
        // that actually fills, and the sandbox has filled above it every time.
        exitPrice = livePremiumBid ?? livePremium;
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
      // The order was ACCEPTED. That is not a fill. Confirm with the broker
      // before writing any P&L — booking the submitted limit as though it
      // were a fill is what produced $186.50 of GLND profit that never
      // existed while the shares were still sitting in the account.
      const exitOrderId = closeResult.orderResult?.id ?? null;
      const outcome = await confirmOrderFill(exitOrderId);

      if (outcome?.filled) {
        try {
          journalClose(pos, {
            exitOrderId, exitOrderStatus: "filled",
            exitQuantity: outcome.quantity || pos.entryQuantity, exitFillPrice: outcome.price,
            exitReason: exit.detail, exitReasonTag: exit.tag,
            underlyingPriceAtClose: underlyingPx,
          });
        } catch (e) { console.error("autoexit journal write failed:", e); }
        results.push({ symbol: pos.symbol, closed: true, ...exit, exitPrice: outcome.price, order: closeResult.orderResult });
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

    return NextResponse.json({ checked: open.length, closed: results.filter((r) => r.closed).length, results });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
