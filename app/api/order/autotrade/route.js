import { NextResponse } from "next/server";
import { vetOrder, vetEquityOrder, submitOrder } from "../common";
import { tradier, asArray } from "../../tradier";
import { isPaperSandbox } from "../../tradeClient";
import { listIdeas, listJournal } from "../../store";
import { reservedQuantities } from "../common";
import { isLegacy, readBaseline } from "../../ledgerLib";
import { journalOpen } from "../../journalLib";
import { OPTION_HARD_PCT } from "../../sizingLib";
import { markActivity } from "../../activityLib";
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

/* Conviction floor. Was 3, which excluded the single best-performing bucket
   in the ledger. Measured across every graded idea, winsorizing R at ±5 the
   way calibrationLib does for averaging:
     conviction 2: 74% directionally correct, avgR +1.24  (n=35)
     conviction 3: 50% correct,               avgR +0.16  (n=316)
     conviction 4: 53% correct,               avgR +0.53  (n=17)
   SUPERSEDED 2026-10-05. Those figures came from the `final` grade horizon,
   which was measuring market drift a median of 6.7 days out. Re-measured at
   d1, the horizon these ideas are actually built for, the buckets are flat:
     conviction 2: 51.3% / +0.34R (n=39)
     conviction 3: 55.6% / +0.50R (n=372)
     conviction 4: 52.4% / +0.60R (n=21)
   There is no 74%-vs-50% gap and no signal in conviction either way. The bar
   is left at 2 because it is inert — 91 of the last 97 directional ideas were
   conviction 3 and nothing real is being filtered — rather than removed, so
   the field stays available if it ever starts carrying information. Do not
   cite the old gap again. */
const MIN_CONVICTION = 2;
/* Reward:risk floor. Raised from 1.0 on arithmetic rather than backtest: a
   plan's breakeven win rate is 1/(1+RR), so 1.0:1 needs 50% and 1.09:1 needs
   48%. Measured directional accuracy across this whole ledger is about 50%, so
   anything under roughly 1.5:1 is a coin flip with extra steps — no edge by
   construction, before spread. 1.5:1 needs 40%, which leaves actual room.
   Chosen this way deliberately because the outcome data (2.5:1+ at +0.75R vs
   1.5-2.5:1 at -0.27R) was all recorded under the old exit logic and cannot be
   trusted to pick a threshold. Costs no supply against the current set: every
   recent actionable idea clears it on the UNDERLYING levels this gate reads —
   INTC 2.98, ROG 2.10, NOK 2.02, FEIM 1.99, MRVL 2.07. (A first draft of this
   note claimed INTC failed at 1.09:1. That came from dividing underlying
   target/invalidation distances by the option PREMIUM, which mixes units and
   is meaningless; the gate uses idea.entryPrice, the underlying, and always
   did.) */
const MIN_REWARD_RISK = 1.5;
// How far price may have slipped back below (or above, for a short) a trigger
// it crossed intraday and still count as confirmation. See the cross-check
// below for the ROG and DXST cases that set this.
const MAX_TRIGGER_SLIP_PCT = 0.5;
/* Ceiling on total cost basis committed to ONE underlying, as a fraction of
   the account. The per-position cap (10% options / 25% shares) has no notion
   of a symbol, so nothing stopped three INTC strikes reaching 28.8% together.
   The widened duplicate rule above prevents the common form of that, but this
   still catches what dedup cannot: different expirations, or a call and a put
   on the same name. */
/* 15 -> 20 with the option cap moving to 15%. A position built at exactly the
   cap (AVGO at ~$1,500 on a $10K account) sits right on a 15% ceiling, and the
   gate prices it off the mid while the order fills at the ask, so a cap-sized
   position was being refused by a few dollars. The ceiling now leaves room for
   one full position plus rounding, and still blocks stacking a second lot. */
const MAX_SYMBOL_EXPOSURE_PCT = 20;
/* Hard ceiling on capital deployed across ALL open positions, as a share of
   ACCOUNT_SIZE. Set 2026-10-06 when the working account size went from the
   $99K paper balance to $10K, the amount expected to go live. Nothing capped
   the total before: each position was limited to 10% and each symbol to 15%,
   but ten positions was simply allowed. 100% because the real account is
   limited margin — no borrowing — so deployed cost can never exceed the money.
   Rows frozen behind a resting stop are excluded from the sum: they are a
   sandbox artifact (a real broker cancels the stop and sells), and counting
   ~$2,400 of stuck cost basis would silently shrink a $10K test to $7.6K. */
const MAX_TOTAL_EXPOSURE_PCT = Number(process.env.MAX_TOTAL_EXPOSURE_PCT) > 0 ? Number(process.env.MAX_TOTAL_EXPOSURE_PCT) : 100;
const ACCOUNT_SIZE = Number(process.env.ACCOUNT_SIZE) > 0 ? Number(process.env.ACCOUNT_SIZE) : 1000;
const DIRECTION_SIGN = { CALL: 1, BUY: 1, PUT: -1, SELL: -1 };
const INTRADAY_RISK_PCT = 1; // % of the account a same-day trade may lose at its stop
const LAST_FLAT_BY_CLOSE_ENTRY_MIN = 15 * 60; // ET minutes; flat-by-close contracts are not opened after this
const REENTRY_COOLDOWN_MIN = 45; // no re-entry on a just-exited symbol without a newer idea
const MAX_ENTRIES_PER_SYMBOL_DAY = 2; // churn cap; each lot clears the exposure gate on its own
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
    isFreshEnough(i, now) &&
    /* A trigger drawn before the open is not a level the session has confirmed.
       The pre-open refresh (added 2026-10-05) writes ideas while the market is
       closed, from yesterday's close and thin pre-market quotes, and they stay
       fresh for hours (staleMinutes up to 360). NVDA 2026-10-06: the 9:28 ET
       idea set a trigger of $240.10 off the $238.90 prior close; by 9:33 the
       model had raised it to $243.40, and by 10:09 to $243.37, with its own
       thesis reading "not chasing until it reclaims the intraday high". This
       lookback still returned the LOWEST trigger, $240.10, so two NVDA calls
       were bought at $241.25 and $242.18 — both below the level the model
       itself was waiting for, and NVDA never reclaimed it. Regular-session
       ideas still count, which is what the lookback was built for (a stock
       grinding up through 224.42 -> 224.95 -> 225.50 -> 227.20). If the idea
       being evaluated was itself written pre-open, its own tag matches and it
       is unaffected. */
    (idea.marketState !== "open" || i.marketState === "open")
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
  /* Options: same underlying + same expiration + same direction is the SAME
     BET, whatever the strike. Matching on OCC alone treated one dollar of
     strike difference as a genuinely different plan, and as a stock drifts up
     each hourly refresh proposes the new at-the-money strike — so INTC was
     bought three times in three hours ($118c, $119c, $120c, all 10/23) for
     $28,495, 28.8% of the account, on one thesis. Three calls on one name at
     one expiry are not diversification under any definition, and this app
     cannot place spreads, so there is no legitimate multi-strike structure
     this blocks. It does forgo pyramiding into a winner — a real strategy, but
     not one that was ever chosen here. */
  if (idea.vehicle === "OPTION") {
    if (openEntry.vehicle !== "OPTION") return false;
    const wantType = idea.action === "CALL" ? "call" : idea.action === "PUT" ? "put" : null;
    const sameExpiry = openEntry.expiration && idea.expiration && openEntry.expiration === idea.expiration;
    if (wantType && sameExpiry && openEntry.optionType === wantType) return true;
    return openEntry.occ === idea.leg?.occ;
  }
  const a = Number(idea.target), b = Number(openEntry.target);
  if (!(a > 0) && !(b > 0)) return true;
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) / Math.max(a, b) < 0.005;
}

/* The most extreme price a symbol has traded SINCE a given moment, from
   5-minute bars. A trigger checked only against the live last price is blind
   between runs: this route fires roughly every 15 minutes, so a level that is
   crossed and given back in between is never seen at all. Measured on real
   tape — NVDA touched 233.21 in exactly ONE 5-minute bar (09:40) — a level
   held for five minutes will usually be missed by a 15-minute poll.

   Deliberately anchored to the idea's creation time rather than the session
   high: NVDA's 231.60 level had already been crossed repeatedly in the
   morning, hours BEFORE the idea proposing it existed, so a whole-day high
   would "confirm" a breakout that the thesis never actually witnessed. Only
   movement after the idea was written counts as confirming it. */
/* How far back an intraday cross may count. The point is to catch a level
   crossed BETWEEN two runs of this route, so the window only needs to cover
   one cadence plus slack. Anchoring all the way back to the idea's creation
   was wrong in a way that cost a real trade: NVDA crossed $231 hours earlier,
   then sold off to $228.86, and the route bought the CALL anyway on the
   strength of a cross that had already failed. For an exit, a level touched
   at any point is a gain that really happened; for an ENTRY, a level crossed
   and then lost is a failed breakout — the opposite of a confirmation. */
const INTRADAY_CROSS_WINDOW_MIN = 20;

async function extremeSince(symbol, sinceIso) {
  try {
    const floor = Date.now() - INTRADAY_CROSS_WINDOW_MIN * 60000;
    const start = new Date(Math.max(new Date(sinceIso).getTime(), floor));
    if (!(start.getTime() > 0)) return null;
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    // Bounded: this runs once per untriggered conditional idea inside a loop,
    // so an unbounded call lets one slow response stall the whole route past
    // its 15-minute cron window. Missing the bars costs one intraday catch;
    // stalling costs every check in that window.
    const d = await tradier(
      `/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=5min` +
      `&start=${encodeURIComponent(fmt(start))}&end=${encodeURIComponent(fmt(new Date()))}`,
      { timeoutMs: 4000 }
    );
    const bars = asArray(d?.series?.data);
    if (!bars.length) return null;
    const highs = bars.map((b) => Number(b.high)).filter((n) => n > 0);
    const lows = bars.map((b) => Number(b.low)).filter((n) => n > 0);
    if (!highs.length || !lows.length) return null;
    return { high: Math.max(...highs), low: Math.min(...lows), bars: bars.length };
  } catch {
    return null;
  }
}

async function liveAsk(symbol) {
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const q = asArray(d?.quotes?.quote)?.[0];
    return Number(q?.ask) > 0 ? Number(q.ask) : null;
  } catch {
    return null;
  }
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
// Fails CLOSED: anywhere other than the paper sandbox, stops are always
// attached regardless of the env var. The skip exists solely to dodge a
// sandbox bug (a resting stop reserves the quantity and cannot then be
// cancelled or modified, so winners freeze and only losses can be realised).
// On a real broker that workaround would just be unprotected risk.
const ATTACH_STOPS = !isPaperSandbox() || process.env.PAPER_ATTACH_STOPS === "true";

/* What a buy is priced at: the ASK. Entries used to be submitted at the mid,
   which the sandbox would fill from its lagging feed. On a real-time market a
   buy that must fill now pays the ask, so the order is priced there and every
   size and exposure gate counts that cost, not a mid nobody sells at. */
const payPrice = (leg) => (Number(leg?.ask) > 0 ? Number(leg.ask) : leg?.mid);

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
    ? buildOptionStopEstimate({ entryPremium: payPrice(leg), entryUnderlying: idea.entryPrice, invalidation: idea.invalidation, delta: leg.delta })
    : null;
  if (dryRun) {
    return { placed: false, dryRun: true, wouldPlace: { occ: leg.occ, strike: leg.strike, premium: payPrice(leg), stopEst } };
  }

  let attempt = await attemptOptionOrder({ occ: leg.occ, strike: leg.strike, action: idea.action, premium: payPrice(leg), stopEst, ideaId: idea.id, qty: contractQty });
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
      const r = await attemptOptionOrder({ occ: c.occ, strike: c.strike, action: idea.action, premium: c.ask > 0 ? c.ask : mid, stopEst: altStopEst, ideaId: idea.id, qty: contractQty });
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
      closeByEod: Boolean(idea.flatByClose),
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
  // A share buy pays the ask too; the idea's price is the last trade.
  const entry = (idea.action !== "SELL" && !dryRun ? await liveAsk(idea.symbol) : null) ?? Number(idea.entryPrice);
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

async function run(req) {
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "true";
  const minConviction = Number(params.get("minConviction")) || MIN_CONVICTION;

  try {
    // AI ideas only — the separate liquidity-sweep detector logs into the
    // same ledger (tagged `strategy`) and has its own autopilot at
    // /api/sweeps/autotrade; a sweep scan landing last must never become
    // this route's "latest idea" for a symbol.
    // Two playbooks share this route and never read each other's ideas: the
    // multi-day AI ideas (no strategy tag) and the intraday ones.
    const playbook = params.get("playbook") === "intraday" ? "intraday" : null;
    const all = listIdeas().filter((i) => (playbook ? i.strategy === playbook : !i.strategy));
    const batch = latestPerSymbol(all);
    if (!batch.length) return NextResponse.json({ error: "No ideas in the ledger yet — refresh the Ideas tab first." }, { status: 404 });
    const openJournal = listJournal().filter((r) => r.status === "open");
    const openOccs = new Set(openJournal.filter((r) => r.occ).map((r) => r.occ));

    /* Quantity the broker already has reserved behind a resting sell-stop.
       Buying into a reservation produces a position that can never be sold:
       the sandbox rejects any new sell for that instrument, and the resting
       leg cannot be cancelled or modified. Found two live orphans while
       auditing — a VKTX stop for 4 shares at $37.20 and an NVDA 10/23 $235c
       stop at $5.22, both left behind by positions that no longer exist — so
       an entry into either would have been born un-exitable, and autoexit
       could only ever have reported FROZEN on it.
       A failed lookup returns null and is treated as "unknown": entries are
       allowed through, since one broker hiccup should not halt all trading. */
    const reserved = isPaperSandbox() ? await reservedQuantities() : null; // a sandbox-only defect

    // Conditional ideas (have a triggerPrice) get a fresh quote right now,
    // independent of batch age — see the file header for why. Fetched once
    // per unique symbol, not per idea.
    const conditionalSyms = [...new Set(
      batch.filter((i) => ["CALL", "PUT", "BUY", "SELL"].includes(i.action) && i.triggerPrice != null && i.triggerDirection).map((i) => i.symbol)
    )];
    const liveBySym = Object.fromEntries(await Promise.all(conditionalSyms.map(async (s) => [s, await liveQuote(s)])));

    const results = [];
    let deployedThisRun = 0; // cost placed earlier in this same pass, which journal rows don't show yet
    for (const rawIdea of batch) {
      const tag = { symbol: rawIdea.symbol, action: rawIdea.action, vehicle: rawIdea.vehicle, risk: rawIdea.risk, ideaId: rawIdea.id };
      if (!["CALL", "PUT", "BUY", "SELL"].includes(rawIdea.action)) { results.push({ ...tag, placed: false, reason: "WAIT — nothing to trade." }); continue; }
      if (Number(rawIdea.conviction) < minConviction) { results.push({ ...tag, placed: false, reason: `Conviction ${rawIdea.conviction} below the ${minConviction} bar.` }); continue; }
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
        /* A same-day idea is taken at ITS OWN trigger, with price beyond it right
           now. The two allowances below were built for the 15-minute check,
           where a cross can happen unseen between looks: borrowing the easiest
           trigger from an earlier refresh, and counting a level "crossed
           earlier and still within 0.5%". Same-day ideas are checked every
           minute, so neither is needed, and together they bought the wrong side
           of the level on 4 of the 5 entries of 2026-10-08:
             NVDA call  trigger 237.10 (borrowed 237.05), bought at 236.77 —
                        the session high of 237.07 the thesis needed never broke;
             ORCL put   trigger 135.50, bought at 136.31 after a bounce off 135.33;
             INTC put   trigger 105.35, bought at 105.77 after a bounce off 105.24;
             GOOGL put  trigger 349.30, bought at 349.42 (the one that worked).
           A 0.5% band on a same-day trade is most of its stop: NVDA's stop was
           $1.45 away and the band allowed $1.18 of slip. Buying a breakout that
           has already come back is buying the failure. */
        const intraday = idea.strategy === "intraday";
        const effectiveTrigger = intraday ? Number(idea.triggerPrice) : easiestTrigger(all, idea, now);
        const above = idea.triggerDirection === "above";
        let nowTriggered = above ? live >= effectiveTrigger : live <= effectiveTrigger;

        // Not triggered on the live tick — but it may have been crossed and
        // given back since this idea was written, between two runs of this
        // route. That is a real confirmation the poll simply didn't witness.
        let crossedAt = null;
        let skipThisIdea = false;
        if (!nowTriggered && !intraday) {
          const ext = await extremeSince(idea.symbol, idea.createdAt);
          const reached = above ? ext?.high : ext?.low;
          if (reached != null && (above ? reached >= effectiveTrigger : reached <= effectiveTrigger)) {
            /* The level was crossed since the idea was written — but only count
               it if price is still NEAR that level. A cross that has been given
               back is a failed breakout, not a confirmation, and buying the
               fade means taking the wrong end of the range.
               Settled by ROG: trigger $162.46, ran to $165.94, bought at
               $161.53 on the way back down (0.57% below), then kept falling to
               $156.51 against a $138.70 day low. The "cheaper retest entry"
               reading was wrong. DXST failed the same way earlier. Two real
               losses from this mechanism, no wins.
               The band is small on purpose: it still admits a genuine
               consolidation just under the level, which is the case worth
               keeping, while refusing a slide. */
            const slipPct = above
              ? ((effectiveTrigger - live) / effectiveTrigger) * 100
              : ((live - effectiveTrigger) / effectiveTrigger) * 100;
            if (slipPct > MAX_TRIGGER_SLIP_PCT) {
              results.push({ ...tag, placed: false, reason: `Crossed $${effectiveTrigger} intraday (${above ? "high" : "low"} $${reached}) but price has slipped ${slipPct.toFixed(2)}% back to $${live} — past the ${MAX_TRIGGER_SLIP_PCT}% band, so the break failed rather than held.` });
              skipThisIdea = true;
            } else {
              nowTriggered = true;
              crossedAt = reached;
            }
          }
        }
        if (skipThisIdea) continue;
        if (!nowTriggered) { results.push({ ...tag, placed: false, reason: `Not triggered — live $${live} vs needs to go ${idea.triggerDirection} $${effectiveTrigger}${effectiveTrigger !== idea.triggerPrice ? ` (easiest of recent refreshes; latest asked for $${idea.triggerPrice})` : ""}.` }); continue; }
        if (crossedAt != null) tag.triggeredIntraday = `crossed $${effectiveTrigger} intraday (${idea.triggerDirection === "above" ? "high" : "low"} $${crossedAt} since the idea was written) though it is $${live} now`;
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

      /* Reward:risk, measured against the price we are ACTUALLY paying.
         The earlier version read rawIdea.entryPrice — the spot when the idea
         was written — so a plan could compute as acceptable while the live
         entry made it absurd. DXST slipped through exactly that way: target
         $4.85 against a $3.92 invalidation is ~0.02:1 at any entry near $4,
         yet it was bought twice. */
      {
        const e = Number(idea.entryPrice), t = Number(idea.target), v = Number(idea.invalidation);
        const risk = Math.abs(e - v), reward = Math.abs(t - e);
        const dir = DIRECTION_SIGN[idea.action] ?? 1;
        // Already through the level that voids the thesis. Checked BEFORE the
        // ratio, because once price is the wrong side of the invalidation the
        // ratio flatters the trade instead of describing it: DXST at $3.87
        // against a $3.92 invalidation scored 19.6:1 purely because the risk
        // distance had collapsed to 5 cents — a position autoexit would close
        // on its next pass for breaching the very level it was bought under.
        if (e > 0 && v > 0 && (dir > 0 ? e <= v : e >= v)) {
          results.push({ ...tag, placed: false, reason: `Live price $${e} is already ${dir > 0 ? "at or below" : "at or above"} the $${v} invalidation — the setup is void, not cheap.` });
          continue;
        }
        if (e > 0 && t > 0 && v > 0 && risk > 0 && reward / risk < MIN_REWARD_RISK) {
          results.push({ ...tag, placed: false, reason: `Reward:risk ${(reward / risk).toFixed(2)}:1 at the live entry $${e} is below the ${MIN_REWARD_RISK}:1 floor — risking $${risk.toFixed(2)}/share to make $${reward.toFixed(2)}.` });
          continue;
        }
      }

      /* An idea that already carried a position to a close is CONSUMED — it
         can never be traded again, at any price, on any strike. The cooldown
         below only blocks the first REENTRY_COOLDOWN_MIN minutes and only when
         the idea predates the exit, so once it lapsed the same ideaId was
         re-bought: on 2026-10-05, SPCX idea s3ii5g and AVGO idea 7nku2a were
         each opened, trail-stopped for -$60, then re-opened on those same two
         ids. Across 09-29..10-05 that produced 7 SPCX and 5 AVGO positions
         with 8 same-day re-entries. The thesis was already played out; buying
         it again is not a new read, it is the same read at a worse price.
         A row that never filled (unfilled / orphaned, like the BEAT order that
         found no position) does NOT consume the idea — nothing was tested. */
      {
        // "Carried to a close" means it actually held something: the row needs a
        // real entry fill. 25 journal rows are closed as orphaned/unfilled with
        // entryFillPrice null — nothing was ever tested, so those do not consume
        // the idea. BEAT's 18,929-share order found no position and is one of them.
        const consumed = listJournal().find((r) =>
          // "parked": acted on in the sandbox before practice moved off it.
          r.ideaId && r.ideaId === idea.id && (r.status === "closed" || r.status === "parked") && r.entryFillPrice != null);
        if (consumed) {
          results.push({ ...tag, placed: false, reason: `Idea ${idea.id} already carried a ${idea.symbol} position to a close on ${String(consumed.exitAt ?? consumed.parkedAt).slice(0, 16)} (${consumed.exitReasonTag ?? "exit"}, P&L ${consumed.pnl == null ? "unbooked" : `$${Number(consumed.pnl).toFixed(0)}`}) — a played-out thesis is consumed, not re-tradeable.` });
          continue;
        }
      }

      /* No more than MAX_ENTRIES_PER_SYMBOL_DAY entries per symbol per session
         day. The churn above netted +$2,444, but entirely inside one rising
         week on two names — it is the first thing that stops paying when the
         tape turns, and each lot passes the exposure gate separately so
         nothing else caps it. */
      {
        const today = new Date().toDateString();
        const baseline = readBaseline();
        const todayCount = listJournal().filter((r) => r.symbol === idea.symbol && r.createdAt && new Date(r.createdAt).toDateString() === today && !isLegacy(r, baseline)).length;
        if (todayCount >= MAX_ENTRIES_PER_SYMBOL_DAY) {
          results.push({ ...tag, placed: false, reason: `${idea.symbol} already has ${todayCount} entries today — at the ${MAX_ENTRIES_PER_SYMBOL_DAY}/symbol/day cap, so this is churn rather than a new position.` });
          continue;
        }
      }

      /* Cooldown after an exit on this symbol. Without it, taking profit frees
         the dedup check and a still-fresh idea re-buys the same name on the
         very next run. Observed live on DXST: closed at take-profit, re-bought
         immediately, trail-stopped for a loss, re-bought again — three entries
         inside two checks while the stock fell from $5.10 to $3.87. Re-entering
         a name we just exited needs a NEW idea, not the leftovers of the one
         that just played out. */
      {
        const lastExit = listJournal()
          .filter((r) => r.symbol === idea.symbol && r.exitAt)
          .reduce((a, r) => (!a || new Date(r.exitAt) > new Date(a.exitAt) ? r : a), null);
        if (lastExit) {
          const minsSince = (Date.now() - new Date(lastExit.exitAt).getTime()) / 60000;
          const ideaIsNewer = new Date(idea.createdAt).getTime() > new Date(lastExit.exitAt).getTime();
          if (minsSince < REENTRY_COOLDOWN_MIN && !ideaIsNewer) {
            results.push({ ...tag, placed: false, reason: `Closed ${idea.symbol} ${minsSince.toFixed(0)} min ago (${lastExit.exitReasonTag ?? "exit"}) and this idea predates that exit — waiting ${REENTRY_COOLDOWN_MIN} min for a fresh read rather than re-buying what just played out.` });
            continue;
          }
        }
      }

      // For SHARES this is the only dedup check. For OPTION it's a first
      // pass on the idea's own (pre-substitution) contract — placeOption
      // does the fuller check itself, since a strike-fallback substitution
      // can land on a contract this check never sees (see openOccs there).
      const dup = openJournal.find((r) => r.symbol === idea.symbol && isDuplicatePosition(idea, r));
      if (dup) { results.push({ ...tag, placed: false, reason: `Exact repeat of an already-open ${idea.symbol} position (from ${dup.createdAt}, ${dup.occ ? `contract ${dup.occ}` : `target ${dup.target ?? "none"}`}) — not stacking an identical plan.` }); continue; }

      // Don't buy an instrument the broker has reserved behind a resting stop.
      if (reserved) {
        const key = idea.vehicle === "OPTION" ? idea.leg?.occ : idea.symbol;
        const resQty = key ? (reserved.get(key) ?? 0) : 0;
        if (resQty > 0) {
          results.push({ ...tag, placed: false, reason: `${key} already has ${resQty} reserved behind a resting sell-stop — anything bought here cannot be sold (the sandbox refuses new sells and will not cancel the resting leg), so this would open an un-exitable position.` });
          continue;
        }
      }

      /* A contract that must be flat by the close needs time to work. MU 10/9
         $1090c was bought at 15:33 on 2026-10-07 with a forced sale due at 15:45:
         twelve minutes in which it could only pay the spread and two fees. */
      if (idea.flatByClose) {
        const [hh, mm] = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).split(":").map(Number);
        if ((hh % 24) * 60 + mm >= LAST_FLAT_BY_CLOSE_ENTRY_MIN) {
          results.push({ ...tag, placed: false, reason: "Short-dated contract that is sold before the close — too late in the day to open one (no entries after 15:00 ET)." });
          continue;
        }
      }

      /* Same-day trades are sized by what they can LOSE, not by what they cost.
         The 15% position size was set for multi-day contracts. On a 1-day
         option it bought three NVDA 10/9 $232.50 calls on 2026-10-08, which
         stopped out twenty minutes later for -$257: 2.6% of the account on one
         same-day idea. Loss at the stop per contract is the option's delta
         times the distance to the idea's invalidation, plus the spread paid to
         get out. One contract is still allowed when it runs a little over the
         budget; beyond 1.5x the budget the trade is not taken. */
      if (idea.strategy === "intraday" && idea.vehicle === "OPTION") {
        const delta = Math.abs(Number(idea.leg?.delta)) || 0.6;
        const stopDist = Math.abs(Number(idea.entryPrice) - Number(idea.invalidation));
        const spread = Math.max(0, (Number(idea.leg?.ask) || 0) - (Number(idea.leg?.bid) || 0));
        const riskPer = (delta * stopDist + spread) * 100;
        const budget = (ACCOUNT_SIZE * INTRADAY_RISK_PCT) / 100;
        if (!(riskPer > 0)) { results.push({ ...tag, placed: false, reason: "Cannot size this same-day trade: no usable stop distance." }); continue; }
        let n = Math.floor(budget / riskPer);
        if (n < 1) {
          if (riskPer > budget * 1.5) {
            results.push({ ...tag, placed: false, reason: `One contract would lose about $${riskPer.toFixed(0)} at the stop — over the $${(budget * 1.5).toFixed(0)} most a same-day trade may risk (${INTRADAY_RISK_PCT}% of the account, with half again of leeway).` });
            continue;
          }
          n = 1;
        }
        const perContract = (Number(payPrice(idea.leg)) || 0) * 100;
        if (perContract > 0) n = Math.max(1, Math.min(n, Math.floor((ACCOUNT_SIZE * OPTION_HARD_PCT) / perContract) || 1));
        idea.sizing = { ...(idea.sizing || {}), contracts: n, riskAtStop: Number((riskPer * n).toFixed(0)) };
        tag.sizedByRisk = `${n} contract${n === 1 ? "" : "s"}, about $${(riskPer * n).toFixed(0)} at risk to the stop`;
      }

      /* Re-check the position cap at the price actually being paid. Sizing
         happens when the idea is written; the order goes in later, at the live
         ask. MU 10/9 $1082.50c was sized at $14.27 (14.3% of the account) at
         12:29 and bought at $19.25 at 13:04 after MU ran — 19.3%, past the 15%
         cap, admitted because only the looser 20% per-symbol gate looked at the
         live price. */
      if (idea.vehicle === "OPTION") {
        const liveCost = (Number(payPrice(idea.leg)) || 0) * 100 * Math.max(1, Number(idea.sizing?.contracts) || 1);
        const cap = ACCOUNT_SIZE * OPTION_HARD_PCT;
        if (liveCost > cap) {
          results.push({ ...tag, placed: false, reason: `Costs $${liveCost.toFixed(0)} at the live ask — over the $${cap.toFixed(0)} position cap (${(OPTION_HARD_PCT * 100).toFixed(0)}% of the account). It fit when the idea was sized; the price has moved since.` });
          continue;
        }
      }

      // Per-symbol exposure backstop.
      {
        const costOf = (r) => (Number(r.entryFillPrice ?? r.entryLimitPrice) || 0) * (Number(r.entryQuantity) || 0) * (r.vehicle === "OPTION" ? 100 : 1);
        const baseline = readBaseline();
        const held = openJournal.filter((r) => r.symbol === idea.symbol && !isLegacy(r, baseline)).reduce((s2, r) => s2 + costOf(r), 0);
        const adding = idea.vehicle === "OPTION"
          ? (Number(payPrice(idea.leg)) || 0) * 100 * Math.max(1, Number(idea.sizing?.contracts) || 1)
          : (Number(idea.sizing?.dollarCost) || 0);
        const pctAfter = ((held + adding) / ACCOUNT_SIZE) * 100;
        /* No `held > 0` guard. It used to be there, and it made this gate a
           no-op for exactly the case it reads as if it covers: a brand-new
           position of any size. NOK opened at $24,948 — 25.2% of the account —
           straight past a stated 15% ceiling, because the previous NOK lot was
           closed so `held` was 0 and the check never ran. A per-symbol ceiling
           that only applies to the second position is not a ceiling. */
        if (pctAfter > MAX_SYMBOL_EXPOSURE_PCT) {
          results.push({ ...tag, placed: false, reason: `${idea.symbol} exposure would reach ${pctAfter.toFixed(1)}% of the account ($${(held + adding).toFixed(0)}${held > 0 ? ` against $${held.toFixed(0)} already held` : " as a new position"}) — over the ${MAX_SYMBOL_EXPOSURE_PCT}% per-symbol ceiling.` });
          continue;
        }
      }

      // Total capital deployed across every live position.
      {
        const costOf = (r) => (Number(r.entryFillPrice ?? r.entryLimitPrice) || 0) * (Number(r.entryQuantity) || 0) * (r.vehicle === "OPTION" ? 100 : 1);
        /* A row is marked closed the moment a sell is SUBMITTED, but the capital
           is still deployed until that sell actually fills — exitFillPrice stays
           null until then. Counting only status "open" let a resting $8.8K SPY
           sell look like free cash and would have admitted another position on
           top of it. So: live = open rows, plus filled entries whose close is
           submitted but not yet confirmed. Conservative on purpose — a stale
           unbooked close over-counts, which blocks an entry rather than
           admitting one past the ceiling. */
        const baseline = readBaseline();
        const live = listJournal().filter((r) => !r.frozen && !isLegacy(r, baseline) && (
          r.status === "open" ||
          (r.status === "closed" && r.entryFillPrice != null && r.exitOrderId && r.exitFillPrice == null)
        ));
        const deployed = live.reduce((s2, r) => s2 + costOf(r), 0) + deployedThisRun;
        const adding = idea.vehicle === "OPTION"
          ? (Number(payPrice(idea.leg)) || 0) * 100 * Math.max(1, Number(idea.sizing?.contracts) || 1)
          : (Number(idea.sizing?.dollarCost) || 0);
        const ceiling = (ACCOUNT_SIZE * MAX_TOTAL_EXPOSURE_PCT) / 100;
        if (deployed + adding > ceiling) {
          results.push({ ...tag, placed: false, reason: `Deployed capital would reach $${(deployed + adding).toFixed(0)} against a $${ceiling.toFixed(0)} ceiling (${MAX_TOTAL_EXPOSURE_PCT}% of the $${ACCOUNT_SIZE} account; $${deployed.toFixed(0)} already in live positions) — no room for another.` });
          continue;
        }
        idea.__addingCost = adding;
      }

      let r;
      if (idea.vehicle === "OPTION") r = await placeOption(idea, { dryRun, openOccs });
      else if (idea.vehicle === "SHARES") r = await placeShares(idea, { dryRun });
      else r = { placed: false, reason: `Unhandled vehicle: ${idea.vehicle}` };
      if (r?.placed && !dryRun) deployedThisRun += Number(idea.__addingCost) || 0;
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

/* One run at a time. The Mac-side schedule and a chat-side check can fire in
   the same second, and every gate here reads the journal before either run has
   written to it — so two overlapping runs would each see "nothing open" and
   both act. Queued, the second run sees what the first one did. */
let queue = Promise.resolve();
export function GET(req) {
  const next = queue.then(async () => {
    const res = await run(req);
    // Second pass: the intraday playbook, through the same gates.
    const u = new URL(req.url);
    let out = res;
    if (u.searchParams.get("playbook") == null) {
      u.searchParams.set("playbook", "intraday");
      try {
        const res2 = await run(new Request(u));
        const d2 = res2.ok ? await res2.json() : null;
        if (d2) {
          const d1 = res.ok ? await res.clone().json() : { results: [], placed: 0, candidateCount: 0 };
          const tagged = (d2.results || []).map((r) => ({ ...r, playbook: "intraday" }));
          out = NextResponse.json({
            ...d2, ...d1,
            candidateCount: (d1.candidateCount || 0) + (d2.candidateCount || 0),
            placed: (d1.placed || 0) + (d2.placed || 0),
            skipped: (d1.skipped || 0) + (d2.skipped || 0),
            intradayCandidates: d2.candidateCount || 0,
            results: [...(d1.results || []), ...tagged],
          });
        }
      } catch (e) { console.error("autotrade intraday pass failed:", e); }
    }
    // Stamped by the full two-playbook run only, so the every-minute intraday
    // pass does not overwrite the list of what is being watched.
    if (u.searchParams.get("dryRun") !== "true" && new URL(req.url).searchParams.get("playbook") == null) {
      try {
        const d = await out.clone().json();
        // The setups still waiting on their price, so the screen can show what
        // the automation is watching and how far away each one is.
        const watching = (d.results || [])
          .filter((r) => r.placed || /^Not triggered|^Crossed/.test(String(r.reason || "")))
          .map((r) => ({ symbol: r.symbol, action: r.action, intraday: r.playbook === "intraday", placed: Boolean(r.placed), note: r.placed ? "bought" : String(r.reason).slice(0, 160) }));
        markActivity("entries", { ok: !d.error, error: d.error ?? null, candidates: d.candidateCount ?? 0, placed: d.placed ?? 0, watching });
      } catch {}
    }
    return out;
  });
  queue = next.catch(() => {});
  return next;
}
