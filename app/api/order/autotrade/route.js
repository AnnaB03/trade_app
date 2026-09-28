import { NextResponse } from "next/server";
import { vetOrder, vetEquityOrder, submitOrder } from "../common";
import { tradier, asArray } from "../../tradier";
import { listIdeas, listJournal } from "../../store";
import { journalOpen } from "../../journalLib";
import { buildOptionStopEstimate } from "../../../lib/orders";

/* Paper-only autopilot: scans the most recent Ideas refresh, places the
   qualifying ones straight into the Tradier SANDBOX account (hard-locked to
   paper money in tradeClient.js — see order/common.js), and skips the rest
   with a stated reason. Built so the Cockpit's suggestions can be tested as
   REAL (simulated) fills over time — real slippage, real bracket mechanics,
   real duplicate-avoidance — instead of only the point-in-time grading in
   gradeLib.js, which never touches an actual order.

   Deliberately conservative about what it will place on its own:
   - conviction >= MIN_CONVICTION
   - blocks only an exact repeat of an already-open position — the same
     contract (options: same occ) or the same target (shares: within 0.5%)
     already open on that symbol. A genuinely different plan on a symbol
     that already has a position open — a different strike, a different
     target — is a different trade and is allowed to open alongside it.
     Only identical, no-new-information repeats get skipped.
   - only ever acts on AI-generated ideas — the separate liquidity-sweep
     detector logs into the same ledger (tagged with `strategy`) and has its
     own autopilot at /api/sweeps/autotrade; a sweep scan landing last must
     never become this route's "latest idea" for a symbol.

   NOT gated here, on purpose, because there's no real dollar cost to
   protect in a hard-locked paper account:
   - affordability cap (a $1,000-account-sized comfort limit) — this was the
     actual reason NVDA never traded for two straight days regardless of
     trigger status; every contract on it costs more than the cap, always.
     Contract cost still shows in every result for reference.
   - wide bid-ask spread acknowledgment — exists to stop a human from eating
     bad slippage with real money; auto-acknowledged here since there's
     nothing to eat.

   Trigger checking is LIVE, not batch-cached — this is the fix for a real
   gap: this route used to trust the `triggered` flag computed once, back
   when the idea was generated. Called only every couple of hours (to avoid
   paying for a full AI refresh every time), that meant a fast intraday
   breakout-and-reversal between calls was invisible — the price could cross
   the trigger and fall back before the next check ever looked, and the
   trade that should have fired never would. A conditional idea now gets its
   OWN fresh quote at call time, independent of how old the batch is, so
   calling this route often and cheaply (no LLM involved) actually closes
   the gap instead of just narrowing it. A non-conditional idea (already
   live the moment it was generated) still uses the batch-level staleness
   check below, since there's no live re-check that makes sense for "is this
   thesis still good," only for "has this price level been crossed." */

const MIN_CONVICTION = 3;
const MAX_BATCH_AGE_MIN = 20; // non-conditional ideas: reject a batch older than this
const DEFAULT_TRIGGER_STALE_MIN = 120; // conditional ideas with no staleMinutes of their own
const LOOKBACK_HOURS = 24; // how far back to search for each symbol's own latest idea

// Each symbol's own most recent idea, independent of which overall refresh
// produced it — NOT "the single most recent batch across every symbol."
// That used to be the same thing by assumption, until it wasn't: any
// suggestions call with a narrower symbol list (the user's own browser
// refresh, using their personal watchlist, is the common real case) becomes
// "the latest batch" the instant it lands, silently pushing every symbol it
// doesn't mention out of view — including a still-fresh, already-triggered
// idea from minutes earlier. Confirmed live: RKLB triggered and ran to
// +2.5%, but a same-minute browser refresh for a 7-symbol personal
// watchlist (no RKLB) meant the next autotrade check saw no RKLB idea to
// act on at all. Staleness is still enforced per-idea below (isFreshEnough
// / MAX_BATCH_AGE_MIN) — this only changes WHICH ideas are candidates, not
// how old one is allowed to be.
function latestPerSymbol(ideas) {
  const cutoff = Date.now() - LOOKBACK_HOURS * 3600000;
  const bySym = new Map();
  for (const i of ideas) {
    if (new Date(i.createdAt).getTime() < cutoff) continue;
    const existing = bySym.get(i.symbol);
    if (!existing || new Date(i.createdAt) > new Date(existing.createdAt)) bySym.set(i.symbol, i);
  }
  return [...bySym.values()];
}

function isFreshEnough(idea, now) {
  const ageMin = (now - new Date(idea.createdAt).getTime()) / 60000;
  const maxAge = Number(idea.staleMinutes) > 0 ? Number(idea.staleMinutes) : DEFAULT_TRIGGER_STALE_MIN;
  return ageMin <= maxAge;
}

// The trigger level a symbol actually needs to clear right now, not just
// whatever the newest refresh happened to set it to. Each fresh refresh
// fully replaces the prior idea for a symbol with a new trigger — normally
// fine, but when a stock is grinding steadily toward a level (see NVDA:
// 224.42 -> 224.95 -> 225.50 -> 227.20 over a few hours), the newer,
// farther trigger can supersede an older, closer one moments before price
// would have reached it. That earlier, already-close level doesn't stop
// being real just because a newer idea came along — this looks back across
// recent (still within their OWN staleness window), same-direction ideas
// for the same symbol/action/vehicle and returns the easiest one to clear:
// the lowest trigger for an "above" setup, the highest for a "below" one.
function easiestTrigger(all, idea, now) {
  const candidates = all.filter((i) =>
    i.symbol === idea.symbol && i.action === idea.action && i.vehicle === idea.vehicle &&
    i.triggerPrice != null && i.triggerDirection === idea.triggerDirection &&
    new Date(i.createdAt).getTime() <= new Date(idea.createdAt).getTime() &&
    isFreshEnough(i, now)
  );
  const prices = candidates.map((i) => Number(i.triggerPrice));
  if (!prices.length) return idea.triggerPrice;
  return idea.triggerDirection === "above" ? Math.min(...prices) : Math.max(...prices);
}

// Is `idea` an exact repeat of an already-open paper position on the same
// symbol, or a genuinely different plan that should be allowed alongside it?
// Options: same contract (occ) = repeat, any other strike/expiration = new.
// Shares: same target (within 0.5%) = repeat; a different target, or one
// side having no target set and the other having one, = new. Two targetless
// ideas on the same symbol can't be told apart, so they're treated as the
// same plan rather than stacked indefinitely.
function isDuplicatePosition(idea, openEntry) {
  if (idea.vehicle === "OPTION") return openEntry.vehicle === "OPTION" && openEntry.occ === idea.leg?.occ;
  const a = Number(idea.target), b = Number(openEntry.target);
  if (!(a > 0) && !(b > 0)) return true;
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) / Math.max(a, b) < 0.005;
}

async function liveQuote(symbol) {
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const q = asArray(d?.quotes?.quote)?.[0];
    return q?.last != null ? Number(q.last) : null;
  } catch {
    return null;
  }
}

/* Whether to attach a broker-side protective stop at entry.
   OFF, because in the Tradier sandbox a resting sell-stop permanently
   reserves the quantity: it cannot be sold by any new order, and the stop
   can be neither cancelled (DELETE returns {status:"ok"} and the leg stays
   resting, by parent id or leg id) nor modified ("Backoffice rejected
   override"). The effect is one-sided and fatal to the P&L — a losing
   position exits fine because its stop fires, while a winning position is
   frozen and can never be sold. Measured on 2026-09-28: 8 of 9 open
   positions were unsellable, +$379 of gains locked against +$50 reachable,
   which is most of the explanation for a book showing 25 losses to 3 wins.
   Exits are handled instead by autoexit, which runs every ~15 min and checks
   invalidation on the live price plus a trailing take-profit. That trades
   instant intraday protection for the ability to realize a gain at all.
   Set PAPER_ATTACH_STOPS=true to restore broker-side stops. */
const ATTACH_STOPS = process.env.PAPER_ATTACH_STOPS === "true";

// Attempt one specific contract. Returns { ok: true, orderResult, vet } or
// { ok: false, error } — never throws, so the caller can try alternates.
async function attemptOptionOrder({ occ, strike, action, premium, stopEst, ideaId, qty = 1 }) {
  const body = {
    legs: [{ action: "buy", type: action === "CALL" ? "call" : "put", strike: String(strike), premium: String(premium ?? 0), qty, occ }],
    closing: false,
    ideaId,
    ...(ATTACH_STOPS && stopEst > 0 ? { stop: { price: stopEst } } : {}),
  };
  // Wide-spread and big-defined-risk acks exist to make a human pause before
  // eating real slippage/loss — nothing to protect in a paper account, so
  // try clean first and auto-acknowledge on retry rather than skip.
  let vet = await vetOrder(body, { preview: false });
  if (vet.error && (vet.needs_ack || vet.needs_spread_ack)) {
    vet = await vetOrder({ ...body, ack_defined_large_risk: true, ack_wide_spread: true }, { preview: false });
  }
  if (vet.error) return { ok: false, error: vet.error };
  try {
    const orderResult = (await submitOrder(vet.form))?.order ?? null;
    return { ok: true, orderResult, vet };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Contracts near a target strike, sorted by proximity, from the real chain —
// used as fallbacks when the model's exact chosen strike isn't orderable.
async function nearbyStrikes(symbol, expiration, type, targetStrike) {
  try {
    const d = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(expiration)}&greeks=false`);
    const opts = asArray(d?.options?.option).filter((o) => o.option_type === type);
    return opts
      .map((o) => ({ occ: o.symbol, strike: Number(o.strike), bid: Number(o.bid), ask: Number(o.ask) }))
      .sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike));
  } catch {
    return [];
  }
}

const MAX_STRIKE_FALLBACKS = 6;

async function placeOption(idea, { dryRun, openOccs }) {
  const leg = idea.leg;
  if (!leg?.occ) return { placed: false, reason: "No resolved contract (leg.occ) for this idea." };
  // The strike-fallback below can land on a DIFFERENT contract than the
  // idea's own leg.occ — dedup upstream only ever compares against that
  // original occ, so a substituted fill was invisible to it and kept
  // getting re-bought every 15-minute check. Checking the realized contract
  // here, before ever submitting it, is what actually stops the stack.
  if (openOccs?.has(leg.occ)) return { placed: false, reason: `Already have an open position in ${leg.occ} — not stacking another.` };
  // Contract count comes from the idea's own account-aware sizing (see
  // sizingLib). Pinned at 1 it left a six-figure account putting ~$800 to
  // work per idea, so even a +127% winner returned a few hundred dollars.
  const contractQty = Math.max(1, Number(idea.sizing?.contracts) || 1);
  const stopEst = idea.invalidation != null && leg.delta != null
    ? buildOptionStopEstimate({ entryPremium: leg.mid ?? leg.ask, entryUnderlying: idea.entryPrice, invalidation: idea.invalidation, delta: leg.delta })
    : null;
  if (dryRun) {
    return { placed: false, dryRun: true, wouldPlace: { occ: leg.occ, strike: leg.strike, premium: leg.mid ?? leg.ask, stopEst } };
  }

  let attempt = await attemptOptionOrder({ occ: leg.occ, strike: leg.strike, action: idea.action, premium: leg.mid ?? leg.ask, stopEst, ideaId: idea.id, qty: contractQty });
  let usedOcc = leg.occ, usedStrike = leg.strike, substituted = false;

  // Tradier's sandbox order book recognizes only a narrower set of strikes
  // than its own market-data chain quotes — confirmed live: on NVDA, whole
  // $5-increment strikes (220, 225, 230) placed fine while the finer
  // strikes real trading actually uses ($227.50, $226, $224 — all quoted,
  // all real) came back "Undefined symbol." Rather than give up on a good
  // thesis over a sandbox quirk, fall back to nearby strikes on the SAME
  // expiration, closest first, until one is actually accepted. The realized
  // strike is reported back so this is never silently different from the
  // idea's stated plan.
  if (!attempt.ok && /undefined symbol/i.test(attempt.error || "")) {
    const type = idea.action === "CALL" ? "call" : "put";
    const candidates = (await nearbyStrikes(idea.symbol, idea.expiration, type, leg.strike))
      .filter((c) => c.occ !== leg.occ && !openOccs?.has(c.occ))
      .slice(0, MAX_STRIKE_FALLBACKS);
    for (const c of candidates) {
      const mid = c.bid >= 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : null;
      const altStopEst = idea.invalidation != null && leg.delta != null && mid != null
        ? buildOptionStopEstimate({ entryPremium: mid, entryUnderlying: idea.entryPrice, invalidation: idea.invalidation, delta: leg.delta })
        : null;
      const r = await attemptOptionOrder({ occ: c.occ, strike: c.strike, action: idea.action, premium: mid ?? c.ask, stopEst: altStopEst, ideaId: idea.id, qty: contractQty });
      if (r.ok) { attempt = r; usedOcc = c.occ; usedStrike = c.strike; substituted = true; break; }
    }
  }

  if (!attempt.ok) return { placed: false, reason: attempt.error };
  const { orderResult, vet } = attempt;
  try {
    journalOpen({
      ideaId: idea.id, thesis: null, vehicle: "OPTION", symbol: idea.symbol,
      occ: usedOcc, strike: usedStrike, optionType: idea.action === "CALL" ? "call" : "put",
      expiration: idea.expiration, side: "buy", quantity: contractQty, limitPrice: Number(vet.computed.price), order: orderResult,
    });
  } catch (e) {
    console.error("Autotrade journal write failed (order was still placed):", e);
  }
  return {
    placed: true, order: orderResult, stopAttached: vet.computed.stop_attached, stopPrice: vet.computed.stop_price,
    ...(substituted ? { substitutedStrike: usedStrike, originalStrike: leg.strike, note: `Sandbox wouldn't accept the exact $${leg.strike} strike — filled the nearest orderable one instead.` } : {}),
  };
}

async function placeShares(idea, { dryRun }) {
  const entry = Number(idea.entryPrice);
  if (!(entry > 0)) return { placed: false, reason: "No entry price on this idea." };
  const sized = idea.sizing?.vehicle === "SHARES" ? idea.sizing.shares : null;
  // Sandbox needs whole shares — fractional sizing (fine on real Robinhood)
  // rounds up to 1 rather than being skipped, so a cheap, well-sized idea
  // still gets a real paper fill instead of silently doing nothing. No
  // position-size cap here either — see the file header on affordability.
  const qty = Math.max(1, Math.round(sized > 0 ? sized : 250 / entry));
  const body = {
    equity: {
      symbol: idea.symbol, side: idea.action === "SELL" ? "sell" : "buy", quantity: qty, price: entry,
      stop: ATTACH_STOPS ? (idea.invalidation ?? undefined) : undefined, attachStop: ATTACH_STOPS && idea.invalidation != null,
    },
    closing: false,
    ideaId: idea.id,
  };
  if (dryRun) return { placed: false, dryRun: true, wouldPlace: body };

  const vet = await vetEquityOrder(body, { preview: false });
  if (vet.error) return { placed: false, reason: vet.error };
  let orderResult;
  try {
    orderResult = (await submitOrder(vet.form))?.order ?? null;
  } catch (e) {
    return { placed: false, reason: e.message };
  }
  try {
    journalOpen({
      ideaId: idea.id, thesis: null, vehicle: "SHARES", symbol: idea.symbol,
      side: vet.computed.side, quantity: vet.computed.quantity, limitPrice: vet.computed.price, order: orderResult,
    });
  } catch (e) {
    console.error("Autotrade journal write failed (order was still placed):", e);
  }
  return { placed: true, order: orderResult, stopAttached: vet.computed.stop_attached, stopPrice: vet.computed.stop_price };
}

export async function GET(req) {
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "true";
  const minConviction = Number(params.get("minConviction")) || MIN_CONVICTION;

  try {
    // AI ideas only — the separate liquidity-sweep detector logs into the
    // same ledger (tagged `strategy`) and has its own autopilot at
    // /api/sweeps/autotrade; a sweep scan landing last must never become
    // this route's "latest idea" for a symbol.
    const all = listIdeas().filter((i) => !i.strategy);
    const batch = latestPerSymbol(all);
    if (!batch.length) return NextResponse.json({ error: "No ideas in the ledger yet — refresh the Ideas tab first." }, { status: 404 });
    const openJournal = listJournal().filter((r) => r.status === "open");
    const openOccs = new Set(openJournal.filter((r) => r.occ).map((r) => r.occ));

    // Conditional ideas (have a triggerPrice) get a fresh quote right now,
    // independent of batch age — see the file header for why. Fetched once
    // per unique symbol, not per idea.
    const conditionalSyms = [...new Set(
      batch.filter((i) => ["CALL", "PUT", "BUY", "SELL"].includes(i.action) && i.triggerPrice != null && i.triggerDirection).map((i) => i.symbol)
    )];
    const liveBySym = Object.fromEntries(await Promise.all(conditionalSyms.map(async (s) => [s, await liveQuote(s)])));

    const results = [];
    for (const rawIdea of batch) {
      const tag = { symbol: rawIdea.symbol, action: rawIdea.action, vehicle: rawIdea.vehicle, risk: rawIdea.risk, ideaId: rawIdea.id };
      if (!["CALL", "PUT", "BUY", "SELL"].includes(rawIdea.action)) { results.push({ ...tag, placed: false, reason: "WAIT — nothing to trade." }); continue; }
      if (Number(rawIdea.conviction) < minConviction) { results.push({ ...tag, placed: false, reason: `Conviction ${rawIdea.conviction} below the ${minConviction} bar.` }); continue; }
      // No risk-rating filter: HIGH is 78% of every actionable idea ever
      // logged (90% of options specifically) — the rulebook calls a
      // short-dated option HIGH structurally, regardless of setup quality,
      // so excluding it here meant almost nothing but shares ever traded.
      // That's a real dollar-risk gate with nothing to protect in a paper
      // account; risk still shows in every result/journal entry to review.

      let idea = rawIdea;
      const now = Date.now();
      const hasTrigger = idea.triggerPrice != null && idea.triggerDirection;
      if (hasTrigger) {
        // Own staleness window (the model's own "good for N minutes" call on
        // this specific setup) — falls back to a flat default if it didn't
        // set one. A trigger firing on a setup this old is a coincidence,
        // not a confirmation of anything still true about the thesis.
        if (!isFreshEnough(idea, now)) {
          const ageMin = (now - new Date(idea.createdAt).getTime()) / 60000;
          results.push({ ...tag, placed: false, reason: `Setup is ${ageMin.toFixed(0)} min old, past its own staleness window — not acting on a trigger this late.` });
          continue;
        }
        const live = liveBySym[idea.symbol];
        if (live == null) { results.push({ ...tag, placed: false, reason: "Couldn't get a live quote to check the trigger." }); continue; }
        const effectiveTrigger = easiestTrigger(all, idea, now);
        const nowTriggered = idea.triggerDirection === "above" ? live >= effectiveTrigger : live <= effectiveTrigger;
        if (!nowTriggered) { results.push({ ...tag, placed: false, reason: `Not triggered — live $${live} vs needs to go ${idea.triggerDirection} $${effectiveTrigger}${effectiveTrigger !== idea.triggerPrice ? ` (easiest of recent refreshes; latest asked for $${idea.triggerPrice})` : ""}.` }); continue; }
        // Trade off the live price, not the stale one from generation time —
        // that's what actually crossed the trigger just now.
        idea = { ...idea, entryPrice: live };
        // The contract's own premium drifts too over a multi-hour gap
        // between checks — re-quote it rather than submit a limit order at
        // whatever it cost when the idea was first generated.
        if (idea.vehicle === "OPTION" && idea.leg?.occ) {
          const legQuote = await tradier(`/markets/quotes?symbols=${encodeURIComponent(idea.leg.occ)}`).catch(() => null);
          const q = asArray(legQuote?.quotes?.quote)?.[0];
          const bid = Number(q?.bid), ask = Number(q?.ask);
          const mid = bid >= 0 && ask > 0 ? (bid + ask) / 2 : (Number(q?.last) || null);
          if (mid > 0) idea = { ...idea, leg: { ...idea.leg, bid, ask, mid } };
        }
      } else {
        // No trigger to re-check live — this is already a "buy now" idea, so
        // staleness is about THIS idea's own age, not a shared batch's.
        const ageMin = (Date.now() - new Date(idea.createdAt).getTime()) / 60000;
        if (ageMin > MAX_BATCH_AGE_MIN) {
          results.push({ ...tag, placed: false, reason: `This idea is ${ageMin.toFixed(0)} min old — too stale to trade on without a live re-check. Refresh Ideas first.` });
          continue;
        }
      }

      // For SHARES this is the only dedup check. For OPTION it's a first
      // pass on the idea's own (pre-substitution) contract — placeOption
      // does the fuller check itself, since a strike-fallback substitution
      // can land on a contract this check never sees (see openOccs there).
      const dup = openJournal.find((r) => r.symbol === idea.symbol && isDuplicatePosition(idea, r));
      if (dup) { results.push({ ...tag, placed: false, reason: `Exact repeat of an already-open ${idea.symbol} position (from ${dup.createdAt}, ${dup.occ ? `contract ${dup.occ}` : `target ${dup.target ?? "none"}`}) — not stacking an identical plan.` }); continue; }

      let r;
      if (idea.vehicle === "OPTION") r = await placeOption(idea, { dryRun, openOccs });
      else if (idea.vehicle === "SHARES") r = await placeShares(idea, { dryRun });
      else r = { placed: false, reason: `Unhandled vehicle: ${idea.vehicle}` };
      results.push({ ...tag, ...r });
    }

    // No single shared timestamp anymore — each symbol carries its own (see
    // latestPerSymbol) — so report the range instead of one misleading "as
    // of" value.
    const createdAts = batch.map((i) => new Date(i.createdAt).getTime());
    return NextResponse.json({
      dryRun, candidateCount: batch.length,
      oldestIdea: new Date(Math.min(...createdAts)).toISOString(),
      newestIdea: new Date(Math.max(...createdAts)).toISOString(),
      placed: results.filter((r) => r.placed).length,
      skipped: results.filter((r) => !r.placed).length,
      results,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
