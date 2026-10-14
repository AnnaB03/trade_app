import { NextResponse } from "next/server";
import { vetOrder, vetEquityOrder, submitOrder } from "../common";
import { tradier, asArray } from "../../tradier";
import { isPaperSandbox } from "../../tradeClient";
import { listIdeas, listJournal } from "../../store";
import { reservedQuantities, confirmEntryFill } from "../common";
import { getClock } from "../../clockLib";
import { isLegacy, readBaseline } from "../../ledgerLib";
import { journalOpen } from "../../journalLib";
import { OPTION_HARD_PCT } from "../../sizingLib";
import { HARD_LOSS_PCT } from "../exitRules";
import {
  payPrice, sizeOptionEntry, SAME_DAY, MIN_CONVICTION, MIN_REWARD_RISK, MAX_SYMBOL_EXPOSURE_PCT,
  MAX_SPREAD_SHARE_OF_LOSS, MAX_SPREAD_PCT_OF_PREMIUM, LAST_FLAT_BY_CLOSE_ENTRY_MIN, REENTRY_COOLDOWN_MIN,
  MAX_ENTRIES_PER_SYMBOL_DAY, RISK_PER_TRADE_PCT as INTRADAY_RISK_PCT, isWatchOnly, entriesAllowed,
  learningMode, lateEntryRefused, LEARNING_MAX_ENTRIES_PER_SYMBOL_DAY, setupVoid,
} from "../entryRules";
import { optionStopPct, profileFor } from "../../swingLib";
import { extremeRead, fadePlan, fadeEnabled, EXTREME_PCT, FADE_SIDES } from "../../fadeLib";
import { appendIdea } from "../../store";
import { selectionVerdict } from "../../selectionLib";
import { markActivity } from "../../activityLib";
import { recordShadowEntry } from "../../shadowLib";
import { tradingHalt } from "../../riskLib";
import { accountSize } from "../../accountLib";
import { closedTrades, playbookVerdicts, edgeRiskMultiplier } from "../../edgeLib";
import { fetchTape, ATR_USED_MAX_PCT } from "../../tapeLib";
import { notifyBought } from "../../notifyLib";
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
// MIN_CONVICTION lives in entryRules.js (pinned by tests/rules.contract.test.js).
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
// MIN_REWARD_RISK lives in entryRules.js (pinned by tests/rules.contract.test.js).
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
// MAX_SYMBOL_EXPOSURE_PCT lives in entryRules.js (pinned by tests/rules.contract.test.js).
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
const ACCOUNT_SIZE = accountSize();
const DIRECTION_SIGN = { CALL: 1, BUY: 1, PUT: -1, SELL: -1 };
// Which playbooks only record (watch-only) is decided in entryRules.isWatchOnly.
// Playbooks that open and close inside one session: sized by risk, refused
// outright when one contract is too much, and flat by the close.
// SAME_DAY lives in entryRules.js
// Playbooks that record what they would have bought and place nothing (shadowLib.js).
/* The fade (contrarian) is watch-only unless FADE_LIVE=true. It traded live for
   one day, 2026-10-13/14, and went 0 for 2 (-$324): NVDA stopped out in ten
   minutes, GOOGL in eighteen seconds — the second because its order rested at
   the mid for three minutes, missed the move it was right about (the put
   traded 2.56 -> 2.93), and filled only as the stock turned back up. */
const FADE_LIVE = process.env.FADE_LIVE === "true";
const watchOnly = (strategy) => isWatchOnly(strategy); // entryRules.js; nothing is watch-only in learning mode
const LEARN = learningMode(); // entryRules.js
const STRICT_TRIGGERS = process.env.LOOSE_TRIGGERS !== "true";
const etNowMinutes = () => {
  const [h, m] = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).split(":").map(Number);
  return (h % 24) * 60 + m;
};
// MAX_SPREAD_SHARE_OF_LOSS lives in entryRules.js (pinned by tests/rules.contract.test.js).
// MAX_SPREAD_PCT_OF_PREMIUM lives in entryRules.js; // of the entry price; the option stop is -10% // of the per-trade loss limit
// INTRADAY_RISK_PCT lives in entryRules.js (pinned by tests/rules.contract.test.js).
// LAST_FLAT_BY_CLOSE_ENTRY_MIN lives in entryRules.js (pinned by tests/rules.contract.test.js).
// REENTRY_COOLDOWN_MIN lives in entryRules.js (pinned by tests/rules.contract.test.js).
/* 2 -> 4 on 2026-10-13. At 2 it stopped the fade playbook on the one name that
   was active: NVDA had used both entries by 12:25, and the two fades derived
   after that (13:12 at $227.54 and 14:27 at $227.70, each aiming ~$0.85 lower)
   were refused as churn while NVDA went to $226.93. The 45-minute cooldown
   after an exit still applies, so this is at most one entry an hour. */
// MAX_ENTRIES_PER_SYMBOL_DAY lives in entryRules.js (pinned by tests/rules.contract.test.js).
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

// Last, plus the day's high and low: the fade needs to know where in the
// day's range an entry would be taken (fadeLib.js).
async function dayQuote(symbol) {
  try {
    const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const q = asArray(d?.quotes?.quote)?.[0];
    const last = q?.last != null ? Number(q.last) : null;
    return { last, high: Number(q?.high) > 0 ? Number(q.high) : null, low: Number(q?.low) > 0 ? Number(q.low) : null };
  } catch {
    return { last: null, high: null, low: null };
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
/* The limit price for a buy: the MID, not the ask.
   Entries were priced at the ask so they filled on arrival, and every position
   was therefore born down the whole spread — ORCL -$40, AVGO -$20, NVDA -$20
   on 2026-10-13 alone, against a $100 loss limit. A limit at the mid rests
   until the market comes to it, which costs some fills and keeps the rest;
   autoexit withdraws an entry that has not filled in 5 minutes. Set
   ENTRY_AT_ASK=true to go back to paying the ask. */
// payPrice lives in entryRules.js (default: the ask).

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
      stopPct: idea.stopPct ?? null,
      learningOverrides: idea.learningOverrides ?? null,
    });
  } catch (e) {
    console.error("Autotrade journal write failed (order was still placed):", e);
  }
  return {
    placed: true, order: orderResult, stopAttached: vet.computed.stop_attached, stopPrice: vet.computed.stop_price,
    fill: { instrument: usedOcc, quantity: contractQty, price: Number(vet.computed.price) },
    ...(substituted ? { substitutedStrike: usedStrike, originalStrike: leg.strike, note: `Sandbox wouldn't accept the exact $${leg.strike} strike — filled the nearest orderable one instead.` } : {}),
  };
}

async function placeShares(idea, { dryRun }) {
  // A share buy pays the ask too; the idea's price is the last trade.
  const entry = (idea.action !== "SELL" && !dryRun ? await liveAsk(idea.symbol) : null) ?? Number(idea.entryPrice);
  if (!(entry > 0)) return { placed: false, reason: "No entry price on this idea." };
  // The edge throttle scales shares the same way it scales contracts.
  const sized = idea.sizing?.vehicle === "SHARES" ? idea.sizing.shares * (Number(idea.__riskMult) || 1) : null;
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
      learningOverrides: idea.learningOverrides ?? null,
    });
  } catch (e) {
    console.error("Autotrade journal write failed (order was still placed):", e);
  }
  return { placed: true, order: orderResult, stopAttached: vet.computed.stop_attached, stopPrice: vet.computed.stop_price, fill: { instrument: idea.symbol, quantity: vet.computed.quantity, price: vet.computed.price } };
}

/* ---------- The fade playbook ----------
   Derived from the ordinary ideas, with no extra model call: when a breakout
   idea triggers at the extreme of the day's range, this writes the OPPOSITE
   trade into the idea ledger as its own idea (strategy "contrarian"), and the
   normal entry loop then takes it through every existing gate — risk sizing,
   the spread check, the per-symbol ceiling, the $100 loss limit. The levels
   come from fadeLib.js: invalidation just beyond the extreme being chased,
   target a share of the way back into the range. Short-dated and flat by the
   close, because a failed breakout resolves in minutes or not at all. */
const FADE_DTE_MIN = 1, FADE_DTE_MAX = 4, FADE_TARGET_DELTA = 0.6;

async function fadeContract(symbol, type, price) {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dte = (e) => Math.round((Date.parse(e + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
    const ex = await tradier(`/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true`, { timeoutMs: 8000 });
    // Later first: the same move costs less decay a few days out.
    const exps = asArray(ex?.expirations?.date).filter((e) => dte(e) >= FADE_DTE_MIN && dte(e) <= FADE_DTE_MAX).sort().reverse();
    for (const exp of exps) {
      const cd = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(exp)}&greeks=true`, { timeoutMs: 9000 });
      const fits = asArray(cd?.options?.option)
        .filter((o) => o.option_type === type)
        .map((o) => {
          const bid = Number(o.bid), ask = Number(o.ask), mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
          return { o, bid, ask, mid, delta: Math.abs(Number(o.greeks?.delta) || 0) };
        })
        .filter((c) => c.mid > 0 && c.delta >= 0.35 && c.delta <= 0.75 && ((c.ask - c.bid) / c.mid) * 100 <= 10 && c.mid * 100 <= ACCOUNT_SIZE * OPTION_HARD_PCT)
        .sort((a, b) => Math.abs(a.delta - FADE_TARGET_DELTA) - Math.abs(b.delta - FADE_TARGET_DELTA));
      if (fits.length) {
        const c = fits[0];
        return { expiration: exp, dte: dte(exp), strike: Number(c.o.strike),
          leg: { occ: c.o.symbol, strike: Number(c.o.strike), bid: c.bid, ask: c.ask, mid: c.mid, delta: c.o.greeks?.delta != null ? Number(c.o.greeks.delta) : null } };
      }
    }
  } catch {}
  return null;
}

async function deriveFades(now = Date.now()) {
  const made = [];
  try {
    const all = listIdeas();
    const already = new Set(all.filter((i) => i.fadeOf).map((i) => i.fadeOf));
    // Multi-day and same-day ideas alike: either can be the chase worth fading.
    const bases = latestPerSymbol(all.filter((i) => !i.strategy || i.strategy === "intraday"))
      .filter((i) => ["CALL", "PUT", "BUY", "SELL"].includes(i.action) && !already.has(i.id) && isFreshEnough(i, now));
    for (const base of bases) {
      const q = await dayQuote(base.symbol);
      if (!(q.last > 0)) continue;
      /* Only once the breakout it was waiting for is actually happening: the
         fade is of a chase, not of a level nobody has reached.
         FADE_REQUIRE_TRIGGER=false lifts it, which is how this path gets
         exercised outside a live breakout. */
      if (process.env.FADE_REQUIRE_TRIGGER !== "false" && base.triggerPrice != null && base.triggerDirection) {
        const through = base.triggerDirection === "above" ? q.last >= Number(base.triggerPrice) : q.last <= Number(base.triggerPrice);
        if (!through) continue;
      }
      // Two reasons to take the other side: the entry is at the extreme of the
      // day's range, or the selection rules say this kind of idea loses.
      const sv = selectionVerdict({ action: base.action, regime: base.regimeTrend, etMinutes: etNowMinutes(), catalyst: base.catalyst });
      const em = etNowMinutes();
      const plan = fadePlan({ action: base.action, price: q.last, low: q.low, high: q.high, etMinutes: em })
        || (sv.fade ? fadePlan({ action: base.action, price: q.last, low: q.low, high: q.high, force: true, etMinutes: em }) : null);
      if (!plan) continue;
      plan.why = sv.fade ? `a ${base.action} in a ${base.regimeTrend} tape` : `a ${base.action} at ${plan.rangePos}% of the day's range`;
      const alt = await fadeContract(base.symbol, plan.optionType, q.last);
      if (!alt) continue;
      const why = `The model wants ${plan.why} on ${base.symbol} (now $${q.last}, ${plan.rangePos}% of today's $${q.low}-$${q.high} range). Taking the other side instead: wrong ${plan.action === "PUT" ? "above" : "below"} $${plan.invalidation}, aiming for $${plan.target}.`;
      const row = appendIdea({
        symbol: base.symbol, action: plan.action, vehicle: "OPTION",
        strike: alt.strike, expiration: alt.expiration,
        entryTrigger: `fade of ${plan.why}`,
        triggerPrice: null, triggerDirection: null, triggered: true,
        invalidation: plan.invalidation, target: plan.target, staleMinutes: 15,
        conviction: 3, catalyst: sv.fade ? "regime fade" : "failed breakout", risk: "HIGH", regimeTrend: base.regimeTrend ?? null,
        why_pro: `${why} Range position ${plan.rangePos}%, reward:risk ${plan.rewardRisk}:1 on the underlying, ${alt.dte}d contract at delta ${alt.leg.delta}.`,
        why_plain: why,
        leg: alt.leg, sizing: { vehicle: "OPTION", contracts: 1 }, affordable: true, accountSize: ACCOUNT_SIZE,
        flatByClose: true, horizon: "intraday", strategy: "contrarian",
        fadeOf: base.id, entryPrice: q.last, marketState: "open",
      });
      made.push(row.id);
    }
  } catch (e) {
    console.error("deriveFades failed:", e);
  }
  return made;
}

/* ---------- The fade scan (WATCH-ONLY) ----------
   The live fade only fires when the model has a bullish idea that is
   triggering, and on a quiet afternoon the model says WAIT to 24 of 25 names,
   so the playbook has almost nothing to act on. This asks the wider question
   without the model: in an uptrend, is ANY watched name pressing the top of
   its day's range worth fading?

   The evidence for the live fade does not cover this. That evidence is about
   ideas the model chose; a stock at its high with no idea behind it is a
   different population. So this records what it would have bought
   (shadowLib.js) and places nothing. scripts/shadow-report.py scores it. */
const SCAN_RANGE_POS = 95, SCAN_MIN_RANGE_PCT = 0.8, SCAN_FROM_ET_MIN = 10 * 60, SCAN_REGIME_MAX_AGE_MIN = 60, SCAN_REPEAT_MIN = 45;

async function deriveScanFades(now = Date.now()) {
  const made = [];
  try {
    const mins = etNowMinutes();
    if (mins < SCAN_FROM_ET_MIN || mins >= LAST_FLAT_BY_CLOSE_ENTRY_MIN) return made;
    const all = listIdeas();
    const recentScan = new Set(all.filter((i) => i.strategy === "fade_scan" && now - new Date(i.createdAt).getTime() < SCAN_REPEAT_MIN * 60000).map((i) => i.symbol));
    // The regime each name was last read in, from the model's own latest row.
    const latest = latestPerSymbol(all.filter((i) => !i.strategy));
    for (const base of latest) {
      if (recentScan.has(base.symbol) || base.regimeTrend !== "uptrend") continue;
      if (now - new Date(base.createdAt).getTime() > SCAN_REGIME_MAX_AGE_MIN * 60000) continue;
      const q = await dayQuote(base.symbol);
      if (!(q.last > 0) || !(q.high > q.low)) continue;
      if (((q.high - q.low) / q.last) * 100 < SCAN_MIN_RANGE_PCT) continue; // a dead range has no "top"
      const plan = fadePlan({ action: "CALL", price: q.last, low: q.low, high: q.high, force: true, etMinutes: etNowMinutes() });
      if (!plan || plan.rangePos < SCAN_RANGE_POS) continue;
      const alt = await fadeContract(base.symbol, "put", q.last);
      if (!alt) continue;
      const why = `${base.symbol} is at ${plan.rangePos}% of today's $${q.low}-$${q.high} range in an uptrend, with no idea behind it. Does a put work here? Wrong above $${plan.invalidation}, aiming for $${plan.target}.`;
      const row = appendIdea({
        symbol: base.symbol, action: "PUT", vehicle: "OPTION", strike: alt.strike, expiration: alt.expiration,
        entryTrigger: `scan: ${plan.rangePos}% of the day's range in an uptrend`, triggerPrice: null, triggerDirection: null, triggered: true,
        invalidation: plan.invalidation, target: plan.target, staleMinutes: 15,
        conviction: 3, catalyst: "range-top scan", risk: "HIGH", regimeTrend: "uptrend",
        why_pro: why, why_plain: why, leg: alt.leg, sizing: { vehicle: "OPTION", contracts: 1 }, affordable: true, accountSize: ACCOUNT_SIZE,
        flatByClose: true, horizon: "intraday", strategy: "fade_scan", entryPrice: q.last, marketState: "open",
      });
      made.push(row.id);
    }
  } catch (e) {
    console.error("deriveScanFades failed:", e);
  }
  return made;
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
    const asked = params.get("playbook");
    const playbook = ["intraday", "contrarian", "fade_scan"].includes(asked) ? asked : null;
    const derived = playbook === "contrarian" ? await deriveFades() : playbook === "fade_scan" ? await deriveScanFades() : [];
    const all = listIdeas().filter((i) => (playbook ? i.strategy === playbook : !i.strategy));
    const batch = latestPerSymbol(all);
    /* An empty playbook is not an error: the fade only has ideas while a
       breakout is actually being chased, so most minutes it has none, and a
       404 here made its pass vanish from the merged answer. */
    if (!batch.length) {
      return playbook
        ? NextResponse.json({ playbook, derived, candidateCount: 0, placed: 0, skipped: 0, results: [] })
        : NextResponse.json({ error: "No ideas in the ledger yet — refresh the Ideas tab first." }, { status: 404 });
    }
    /* Portfolio-level stop, ahead of every per-trade gate: a manual halt, or
       today's realized loss at the daily limit, means no new entries whatever
       the ideas say. Exits are never halted (riskLib.js). Reported as a
       normal response, not an error, so the schedule logs it as a decision. */
    /* No entries outside the regular session. The schedule already checks the
       clock, but a call from anywhere else did not: at 16:46 on 2026-10-13 a
       check run from the chat "bought" an AMZN put on an after-hours quote, 46
       minutes after the close. The order expired at once, so nothing happened
       except a false line in the report. */
    if (!dryRun) {
      const clock = await getClock();
      if (!entriesAllowed(clock.state)) {
        return NextResponse.json({ dryRun, marketClosed: true, marketState: clock.state, candidateCount: 0, placed: 0, skipped: 0, results: [] });
      }
    }
    const halt = tradingHalt({ accountSize: ACCOUNT_SIZE });
    if (halt.halted) {
      return NextResponse.json({
        dryRun, halted: true, haltKind: halt.kind, haltReason: halt.reason,
        lossTodayUsd: halt.lossToday, dailyLossLimitUsd: halt.limitUsd,
        candidateCount: batch.length, placed: 0, skipped: batch.length,
        results: batch.map((i) => ({ symbol: i.symbol, action: i.action, vehicle: i.vehicle, risk: i.risk, ideaId: i.id, placed: false, reason: `Trading halted (${halt.kind}) — ${halt.reason}` })),
      });
    }
    /* Edge gate (edgeLib.js): a playbook whose last 20 closed trades lost
       money does not open new ones. Judged on the recent record, so a
       playbook that stops working stops trading, and only once it has 20
       closed trades to be judged on. EDGE_GATE=false turns it off. */
    const edgeBaseline = readBaseline();
    const verdicts = process.env.EDGE_GATE !== "false"
      ? playbookVerdicts(closedTrades(listJournal().filter((r) => !isLegacy(r, edgeBaseline))), { rUsd: ACCOUNT_SIZE * 0.01 })
      : null;
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
    const quoteBySym = Object.fromEntries(await Promise.all(conditionalSyms.map(async (s) => [s, await dayQuote(s)])));
    const liveBySym = Object.fromEntries(Object.entries(quoteBySym).map(([s, q]) => [s, q.last]));

    const results = [];
    let deployedThisRun = 0; // cost placed earlier in this same pass, which journal rows don't show yet
    for (const rawIdea of batch) {
      const tag = { symbol: rawIdea.symbol, action: rawIdea.action, vehicle: rawIdea.vehicle, risk: rawIdea.risk, ideaId: rawIdea.id };
      /* Learning mode (entryRules.learningMode): a SOFT rule that would refuse
         is recorded here and the trade goes ahead; soft() returns true when it
         did. Outside learning mode soft() returns false and the rule refuses
         exactly as before. */
      const overrides = [];
      tag.learningOverrides = overrides;
      const soft = (rule, reason) => { if (!LEARN) return false; overrides.push({ rule, reason }); return true; };
      if (!["CALL", "PUT", "BUY", "SELL"].includes(rawIdea.action)) { results.push({ ...tag, placed: false, reason: "WAIT — nothing to trade." }); continue; }
      if (Number(rawIdea.conviction) < minConviction) {
        const why = `Conviction ${rawIdea.conviction} below the ${minConviction} bar.`;
        if (!soft("conviction", why)) { results.push({ ...tag, placed: false, reason: why }); continue; }
      }
      if (verdicts) {
        const pb = rawIdea.strategy === "intraday" ? "intraday" : rawIdea.strategy === "contrarian" ? "contrarian" : "swing";
        // The edge THROTTLE (edgeLib.edgeRiskMultiplier): a losing recent record
        // cuts the size, never to zero. It used to refuse the trade outright.
        const th = edgeRiskMultiplier(verdicts[pb]);
        // Learning mode trades full size and records what the throttle wanted.
        rawIdea.__riskMult = th.mult < 1 && soft("edge_throttle", th.label) ? 1 : th.mult;
        if (th.mult < 1) tag.edgeThrottle = th.label;
      }
      /* Selection (selectionLib.js): which ideas are taken as written. The fade
         playbook is exempt — it is the other side of exactly these refusals. */
      if (rawIdea.strategy !== "contrarian" && rawIdea.strategy !== "fade_scan") {
        const sv = selectionVerdict({ action: rawIdea.action, regime: rawIdea.regimeTrend, etMinutes: etNowMinutes(), catalyst: rawIdea.catalyst });
        if (!sv.ok && !soft("selection", `${sv.rule}: ${sv.reason}`)) { results.push({ ...tag, placed: false, selection: sv.rule, reason: sv.reason }); continue; }
      }
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
          const why = `Setup is ${ageMin.toFixed(0)} min old, past its own staleness window — not acting on a trigger this late.`;
          if (!soft("stale", why)) { results.push({ ...tag, placed: false, reason: why }); continue; }
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
        /* 2026-10-13: every playbook is now held to this, not only the
           same-day one. The full entry check runs every minute (it used to be
           every 15), so a cross is seen as it happens and neither allowance is
           needed; the last entry they admitted was GOOGL on 2026-10-12, bought
           4 cents under its trigger after the push had already failed, for
           -$101. LOOSE_TRIGGERS=true restores them. */
        const intraday = STRICT_TRIGGERS || idea.strategy === "intraday";
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
        /* Stand down at the extreme. A breakout bought at the top of the day's
           range (or a breakdown at the bottom) has to keep running with no
           pause to pay, and the record says it does not: calls taken at 59-99%
           of the range are 3 winners in 8, while the fade playbook now takes
           the other side there (fadeLib.js). Honest cost: this also blocks the
           trending-day breakouts that worked on 2026-10-09. */
        if (idea.strategy !== "contrarian" && idea.strategy !== "fade_scan") {
          const q = quoteBySym[idea.symbol] || {};
          const read = extremeRead({ action: idea.action, price: live, low: q.low, high: q.high });
          if (read.atExtreme && fadeEnabled(read.side)) {
            const why = `At ${read.pos.toFixed(0)}% of the day's range ($${q.low}-$${q.high}) — the breakout is being chased, so this stands down and the fade playbook takes the other side.`;
            // In learning mode both sides trade: this idea and its fade.
            if (!soft("extreme", why)) { results.push({ ...tag, placed: false, reason: why }); continue; }
          }
        }
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
          const why = `This idea is ${ageMin.toFixed(0)} min old — too stale to trade on without a live re-check. Refresh Ideas first.`;
          if (!soft("stale", why)) { results.push({ ...tag, placed: false, reason: why }); continue; }
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
        const voidWhy = setupVoid({ dir, entry: e, target: t, invalidation: v }); // entryRules.js, hard
        if (voidWhy) { results.push({ ...tag, placed: false, reason: voidWhy }); continue; }
        if (e > 0 && t > 0 && v > 0 && risk > 0 && reward / risk < MIN_REWARD_RISK) {
          const why = `Reward:risk ${(reward / risk).toFixed(2)}:1 at the live entry $${e} is below the ${MIN_REWARD_RISK}:1 floor — risking $${risk.toFixed(2)}/share to make $${reward.toFixed(2)}.`;
          if (!soft("reward_risk", why)) { results.push({ ...tag, placed: false, reason: why }); continue; }
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
          const why = `Idea ${idea.id} already carried a ${idea.symbol} position to a close on ${String(consumed.exitAt ?? consumed.parkedAt).slice(0, 16)} (${consumed.exitReasonTag ?? "exit"}, P&L ${consumed.pnl == null ? "unbooked" : `$${Number(consumed.pnl).toFixed(0)}`}) — a played-out thesis is consumed, not re-tradeable.`;
          if (!soft("consumed", why)) { results.push({ ...tag, placed: false, reason: why }); continue; }
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
        // Learning mode: the 4/day cap is recorded; 8/day is the hard runaway guard.
        if (todayCount >= (LEARN ? LEARNING_MAX_ENTRIES_PER_SYMBOL_DAY : MAX_ENTRIES_PER_SYMBOL_DAY)) {
          results.push({ ...tag, placed: false, reason: `${idea.symbol} already has ${todayCount} entries today — at the ${LEARN ? LEARNING_MAX_ENTRIES_PER_SYMBOL_DAY : MAX_ENTRIES_PER_SYMBOL_DAY}/symbol/day cap, so this is churn rather than a new position.` });
          continue;
        }
        if (todayCount >= MAX_ENTRIES_PER_SYMBOL_DAY) soft("daily_cap", `${idea.symbol} already has ${todayCount} entries today (the ${MAX_ENTRIES_PER_SYMBOL_DAY}/day cap).`);
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
            const why = `Closed ${idea.symbol} ${minsSince.toFixed(0)} min ago (${lastExit.exitReasonTag ?? "exit"}) and this idea predates that exit — waiting ${REENTRY_COOLDOWN_MIN} min for a fresh read rather than re-buying what just played out.`;
            if (!soft("cooldown", why)) { results.push({ ...tag, placed: false, reason: why }); continue; }
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

      /* Tape gate for same-day continuation ideas (tapeLib.js): a name that
         has already used ATR_USED_MAX_PCT of a normal day's range is not
         continuing, it is finishing. Fades are the model's call, made with
         the same read in its prompt; only the continuation side is refused
         here, on live bars, at the moment of entry. */
      if (idea.strategy === "intraday" && /continuation/i.test(String(idea.catalyst || ""))) {
        const t = await fetchTape(idea.symbol, { last: idea.entryPrice });
        if (t?.rangeUsedPct != null && t.rangeUsedPct >= ATR_USED_MAX_PCT) {
          const why = `Tape gate — ${idea.symbol} has already used ${t.rangeUsedPct.toFixed(0)}% of its normal daily range ($${t.dayLow}-$${t.dayHigh} against a $${t.atr14.toFixed(2)} ATR); a continuation here buys the end of the move.`;
          if (!soft("tape", why)) { results.push({ ...tag, placed: false, reason: why }); continue; }
        }
      }

      /* A contract that must be flat by the close needs time to work. MU 10/9
         $1090c was bought at 15:33 on 2026-10-07 with a forced sale due at 15:45:
         twelve minutes in which it could only pay the spread and two fees. */
      if (idea.flatByClose) {
        const em = etNowMinutes();
        if (lateEntryRefused({ flatByClose: true, etMinutes: em, learning: LEARN })) {
          results.push({ ...tag, placed: false, reason: `Short-dated contract that is sold before the close — too late in the day to open one (no entries after ${LEARN ? "15:30" : "15:00"} ET).` });
          continue;
        }
        if (lateEntryRefused({ flatByClose: true, etMinutes: em })) soft("late_entry", "Same-day contract opened after 15:00 ET, with less than 45 minutes to the 15:45 sale.");
      }

      /* Same-day trades are sized by what they can LOSE, not by what they cost.
         The 15% position size was set for multi-day contracts. On a 1-day
         option it bought three NVDA 10/9 $232.50 calls on 2026-10-08, which
         stopped out twenty minutes later for -$257: 2.6% of the account on one
         same-day idea. Loss at the stop per contract is the option's delta
         times the distance to the idea's invalidation, plus the spread paid to
         get out. One contract is still allowed when it runs a little over the
         budget; beyond 1.5x the budget the trade is not taken. */
      /* Extended to EVERY option trade on 2026-10-08, the same afternoon: the
         user's rule is $100 per trade, not per same-day trade. A multi-day idea
         has a wider stop, so its loss at the idea's own invalidation is often
         more than the budget even for one contract; it is still allowed one
         contract, because autoexit now sells any position at -$100 (max_loss)
         before that level is reached. Only same-day trades are refused outright
         when one contract is too much. */
      if (idea.vehicle === "OPTION") {
        // entryRules.sizeOptionEntry: contracts from the stop that fires first,
        // the 15% position cap, and the spread checks. Tested on its own.
        const sz = sizeOptionEntry({
          accountSize: ACCOUNT_SIZE, leg: idea.leg, entryPrice: idea.entryPrice, invalidation: idea.invalidation,
          action: idea.action, strategy: idea.strategy, profile: profileFor(idea.symbol),
          riskMult: rawIdea.__riskMult ?? 1, learning: LEARN,
        });
        idea.stopPct = sz.stopPct;
        if (!sz.ok) { results.push({ ...tag, placed: false, reason: sz.reason }); continue; }
        overrides.push(...(sz.overrides || []));
        idea.sizing = { ...(idea.sizing || {}), contracts: sz.contracts, riskAtStop: sz.riskAtStop };
        tag.sizedByRisk = `${sz.contracts} contract${sz.contracts === 1 ? "" : "s"}, about $${sz.riskAtStop} at risk to the stop (option stop ${sz.stopPct}%)`;
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

      /* Watch-only playbooks stop here: every gate above has passed, so this is
         exactly the trade that would have been placed. It is recorded and not
         sent. See shadowLib.js. */
      if (watchOnly(idea.strategy)) {
        const contracts = Math.max(1, Number(idea.sizing?.contracts) || 1);
        const row = dryRun ? null : recordShadowEntry({
          playbook: idea.strategy, ideaId: idea.id, symbol: idea.symbol, action: idea.action,
          occ: idea.leg?.occ ?? null, strike: idea.leg?.strike ?? idea.strike ?? null, expiration: idea.expiration ?? null,
          contracts, optionBid: idea.leg?.bid ?? null, optionAsk: idea.leg?.ask ?? null, delta: idea.leg?.delta ?? null,
          underlying: idea.entryPrice ?? null, triggerPrice: idea.triggerPrice ?? null, triggerDirection: idea.triggerDirection ?? null,
          invalidation: idea.invalidation ?? null, target: idea.target ?? null, catalyst: idea.catalyst ?? null,
        });
        results.push({ ...tag, placed: false, watchOnly: true, recorded: Boolean(row), reason: `Watch-only: would have bought ${contracts} ${idea.leg?.occ ?? idea.symbol} at $${idea.leg?.ask ?? "?"} — recorded, not placed.` });
        continue;
      }

      // Written on the journal row (journalOpen), so the edge report can split
      // results by which rules were overridden.
      idea.learningOverrides = overrides.length ? overrides : null;
      let r;
      if (idea.vehicle === "OPTION") r = await placeOption(idea, { dryRun, openOccs });
      else if (idea.vehicle === "SHARES") r = await placeShares(idea, { dryRun });
      else r = { placed: false, reason: `Unhandled vehicle: ${idea.vehicle}` };
      if (r?.placed && !dryRun) deployedThisRun += Number(idea.__addingCost) || 0;
      /* Say "bought" only for an order that FILLED. Entries now rest at the mid
         (payPrice), so placed and filled are different events: the AMZN put
         placed at 15:55 on 2026-10-13 never filled, and the phone was told it
         had been bought. An order still working is reported as working. */
      if (r?.placed && !dryRun && r.fill) {
        const got = await confirmEntryFill(r.order?.id);
        if (got?.filled) {
          r.fill = { ...r.fill, price: got.price, quantity: got.quantity };
          notifyBought({ symbol: idea.symbol, ...r.fill, playbook: idea.strategy || "swing" }).catch(() => {});
        } else {
          r.working = true;
          r.note = `Order placed at $${r.fill.price} and resting — not filled yet. Withdrawn after 5 minutes if the market does not come to it.`;
          delete r.fill;
        }
      }
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
    // The other playbooks, each through the same gates as the first.
    const u = new URL(req.url);
    let out = res;
    if (u.searchParams.get("playbook") == null) {
      for (const pb of ["intraday", "contrarian", "fade_scan"]) {
        const pu = new URL(u);
        pu.searchParams.set("playbook", pb);
        try {
          const res2 = await run(new Request(pu));
          const d2 = res2.ok ? await res2.json() : null;
          if (!d2) continue;
          const d1 = out.ok ? await out.clone().json() : { results: [], placed: 0, candidateCount: 0 };
          const tagged = (d2.results || []).map((r) => ({ ...r, playbook: pb }));
          out = NextResponse.json({
            ...d2, ...d1,
            candidateCount: (d1.candidateCount || 0) + (d2.candidateCount || 0),
            placed: (d1.placed || 0) + (d2.placed || 0),
            skipped: (d1.skipped || 0) + (d2.skipped || 0),
            [`${pb}Candidates`]: d2.candidateCount || 0,
            results: [...(d1.results || []), ...tagged],
          });
        } catch (e) { console.error(`autotrade ${pb} pass failed:`, e); }
      }
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
          .map((r) => ({ symbol: r.symbol, action: r.action, playbook: r.playbook || "swing", intraday: r.playbook === "intraday", placed: Boolean(r.placed), note: r.placed ? "bought" : String(r.reason).slice(0, 160) }));
        markActivity("entries", { ok: !d.error, error: d.error ?? null, candidates: d.candidateCount ?? 0, placed: d.placed ?? 0, watching, halted: Boolean(d.halted), haltReason: d.haltReason ?? null });
      } catch {}
    }
    return out;
  });
  queue = next.catch(() => {});
  return next;
}
