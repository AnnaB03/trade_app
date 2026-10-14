/* ---------- Exit rules: the pure half of autoexit ----------
   Every decision autoexit/route.js makes about an open position is here,
   with no I/O: given the marks the route fetched, which rule fires, if any.
   The route owns the broker calls (quotes, cancels, sells, journal writes)
   and asks this module what to do with what it fetched.

   Split out so the rules can be tested against the trades that set them —
   the worked examples in the comments below are the test cases in
   tests/exitRules.test.js. Change a threshold here and the test tells you
   what it does to NVDA, SPCX, AVGO and the rest before the market does.

   Thresholds are a function of the account size (exitConfig), never read
   from the environment inside a rule, so a test can run the same rule at
   $10K and $99K without touching process.env. */

export const DIRECTION = { CALL: 1, BUY: 1, PUT: -1, SELL: -1 };

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
   In principle an armed position exits above entry, since it leaves after
   surrendering only a share of its gain. In practice it does not always: the
   check runs every minute and price can fall through the whole band
   between looks. SPCX peaked +8%, was -5% at the next check and closed -$550.
   (Historical note: this was first written for a 40% arm / 30% giveback) — so
   treat the trail as limiting givebacks, not as a guarantee against turning
   a winner into a loser. Shares arm lower because share ideas here target +3-11%. */
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
   SHARES deliberately UNCHANGED at 15 even though it is unreachable too
   (median share peak 3.0%, and +15% was reached only by the two DXST lots).
   Getting any benefit there needs a +2% arm, which is a 0.6% band — pure
   noise — and the whole result rests on two positions, ROG and NOK. Shares
   are covered by the end-of-day dollar bar instead, which is what actually
   banked FEIM (+$156) and NOK (+$191). Revisit with more rows. */
/* 8 -> 5 and giveback 30 -> 25 on 2026-10-05, from replaying exit rules along
   the real 5-minute price path of all 23 account-sized trades (09-29..10-05),
   checks every 15 minutes, flat by the close, -8% premium stop as a proxy for
   invalidation. Same-day totals: arm 3-5% / give 20-25% +$9.1-9.3k; arm 6-10% /
   give 30-35% +$6.4k (the previous setting); arm 12%+ +$3.1k; the original 40%
   +$2.7k; holding to the close with no rule -$891. The ordering is the same
   with the best day (10-05) removed: +$3.0k / +$0.2k / -$3.1k. Why lower works:
   the day's peak arrives a median 35 minutes after entry and winners were
   giving back half of it — median capture was 49% of the same-day peak.
   Five trading days in one rising week; a direction to keep measuring, not a
   settled optimum. Fixed limit targets and half-off scale-outs were tested on
   the same paths and were worse than a plain trail. */
export const TRAIL_ARM_PCT = { OPTION: 5, SHARES: 15 };
/* A dollar-based arm (peak gain >= $400) lived here briefly and was removed.
   It was added for MRVL showing "+$515" that round-tripped, but the
   bid-adjustment work established that peak was really +$240 / +2.8%, so the
   motivating case was spread illusion. Meanwhile it broke the trail on large
   positions: at 13 contracts a +4.3% peak clears $400, and 30% of a 4.3% gain
   is a 1.2% band, so the trail became a hair-trigger and exited the NVDA
   $230c at $7.75 on a blip instead of managing a real move. The trail is for
   meaningful gains giving back a meaningful share; percentage is the right
   unit for that, and position size does not change it. */
export const TRAIL_GIVEBACK_PCT = 25;
/* ...but 25% of a very large gain is a lot of money to risk finding out.
   The NVDA 10/07 $232.50c (25 contracts, $3.05 entry) reached +100% / +$7,625
   and the trail tolerated a fall back to +70% before firing — a $2,288
   giveback. Nothing else in this book has ever been close: across 44 closed
   trades the median win is $500 and the second-best win ever is $975, so a
   gain past ~$2,000 is a different animal from the gains the band was
   calibrated on, and this book's winners round-trip hard (INTC +$670 to
   -$1,690). Above TRAIL_TIGHTEN_USD the band halves.
   Note what this deliberately is NOT: a flat dollar take-profit. Checked
   against the record, a $2,000 ceiling would have fired on exactly one trade
   in 44 — that same NVDA — and banked $2,000 instead of $7,625. Capping the
   giveback keeps the whole upside of a position that is still climbing and
   only tightens what it may hand back. */
export const TRAIL_GIVEBACK_PCT_LARGE = 15;
// Absolute ceiling, separate from the trail: a position up this much is
// banked outright rather than risking a gap on the way back down.
export const HARD_TAKE_PROFIT_PCT = { OPTION: 150, SHARES: 60 };
export const MAX_LOSS_PCT = 1; // % of the account one trade may lose before it is sold
/* The loser is cut at the same scale the winners are banked. Set 2026-10-14
   at the user's call ("lets implement option 1"). The profit rules take a
   5-7% move in the option; the loss side was the account rule above, 1% of
   the account, and the model's invalidation, which on a $500 contract is a
   40-50% move. The honest ledger then read: 23 trades, winners average +$43,
   losers average -$120 — a ratio that needs a 74% win rate to break even.
   An OPTION is now sold once its bid is HARD_LOSS_PCT below the entry price,
   so a loss is $40-60 on one contract, the size of a typical win. Shares are
   not held to this: 10% of a stock is a different kind of move, and their
   stop is the idea's own level. Entry spreads are capped in autotrade so a
   position is not born halfway to this stop. */
export const HARD_LOSS_PCT = { OPTION: 10, SHARES: null };
/* Playbooks that open and close inside one session: the same-day target, the
   live-price target reference, and no thesis-reversed rule. "contrarian" (the
   fade, app/api/fadeLib.js) is one of them, and it is BUILT against the
   multi-day read on its symbol, so the reversal rule would close it the moment
   it opened. */
export const SAME_DAY_STRATEGIES = new Set(["intraday", "contrarian"]);
export const SHORT_DATED_TARGET_PCT = 7; // sell a closeByEod contract outright at this gain
export const EOD_FLAT_FROM_ET_MIN = 15 * 60 + 45; // closeByEod positions leave from 15:45 ET
/* Dollar thresholds were tuned on the $99K paper account, where one position
   is ~$9,900 and $200 is about 2% of it. They are kept as a SHARE of the
   account so they mean the same thing at any size: at $10K a position is
   ~$1,000 and the equivalent bar is ~$20, not $200 — which would be a 20%
   gain and would never fire. */
export const REFERENCE_ACCOUNT = 99000;
export const TRAIL_TIGHTEN_USD_AT_REFERENCE = 2000;
/* End-of-day profit taking, applied only on the pre-close sweep (?eod=true).
   A gain that survives to the close is not a gain until it is realised: INTC
   closed +$670 across two call lots and reopened the next session at -$1,690,
   a $2,360 swing for the privilege of carrying it. MRVL did +$587 to +$25 and
   ROG +$587 to -$657 the same week — three round trips, no overnight carry
   that paid. The trail cannot catch these when the gains are large in dollars
   and small in percent, which is what account-sized positions produce.
   Dollar-denominated on purpose, since "a good daily profit" is a dollar
   question, not a ratio one. */
export const EOD_TAKE_PROFIT_USD_AT_REFERENCE = 200;

export function exitConfig(accountSize) {
  const account = Number(accountSize) > 0 ? Number(accountSize) : REFERENCE_ACCOUNT;
  const scale = account / REFERENCE_ACCOUNT;
  return {
    account,
    trailTightenUsd: TRAIL_TIGHTEN_USD_AT_REFERENCE * scale,
    eodTakeProfitUsd: EOD_TAKE_PROFIT_USD_AT_REFERENCE * scale,
    maxLossUsd: (account * MAX_LOSS_PCT) / 100,
  };
}

// Minutes since midnight in New York, for the clock-gated rules.
export function etMinutes(date = new Date()) {
  const [h, m] = new Date(date).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).split(":").map(Number);
  return (h % 24) * 60 + m;
}

// Which way the UNDERLYING has to move for this position to win.
export function directionOf(pos) {
  return pos.vehicle === "OPTION"
    ? (pos.optionType === "call" ? 1 : -1)
    : (pos.side === "sell_short" ? -1 : 1);
}

/* The quantity actually HELD, which is what a sell order and any P&L must be
   based on. entryQuantity is what was ORDERED; journalReconcile writes
   entryFilledQuantity from the broker's exec_quantity. They are equal on a
   clean fill, but on a partial fill the ordered number is both too large to
   sell and wrong for the gain. */
export const heldQuantity = (pos) => Number(pos.entryFilledQuantity ?? pos.entryQuantity) || 0;

// An option past expiry is worth exactly its intrinsic value at the close.
export function intrinsicAtExpiry(optionType, strike, closePx) {
  const s = Number(strike), c = Number(closePx);
  if (!(c > 0) || !(s >= 0)) return null;
  return optionType === "call" ? Math.max(0, c - s) : Math.max(0, s - c);
}

/* The best mark this position has shown, for the trail to measure giveback
   against. Persisted on the row (pos.peakMark) because each run is a fresh
   process with no memory of the last one.
   Seeded from the instrument's own day high ONLY for a position entered
   before today. For a position entered today it usually was not held when
   the day high printed: SPCX 10/30 $167.50c was bought at $7.75 at 12:03 on a
   day the contract had already traded $8.775, and AVGO at $14.60 against an
   earlier $15.335. Seeded with those, the trail read "peaked +13%, gave it
   all back" and sold both three minutes after entry for -$60 each.
   The day high is a LAST-TRADE price while the mark is the BID, so for
   options the current spread is subtracted from it: MRVL 265c showed a
   $17.98 high against a $17.00/$17.55 market, a "peak" no seller could have
   got, and every giveback measured against it was overstated by ~3%. */
export function updatePeak({ previousPeak, markNow, dayHigh, spread = 0, enteredToday }) {
  const rawHigh = enteredToday ? null : Number(dayHigh);
  const adjustedHigh = rawHigh > 0 ? Math.max(0, rawHigh - (Number(spread) || 0)) : null;
  let peak = Math.max(Number(previousPeak) || 0, Number(adjustedHigh) || 0);
  if (markNow > 0 && markNow > peak) peak = markNow;
  return peak;
}

/* Gain on what was actually paid: contract premium for options, share price
   for shares. An OPTION position is always LONG premium, so it gains when
   its own premium rises whether it is a call or a put (a put's `dir` is -1,
   which describes the underlying, not the premium — this used to require
   dir > 0 and so never armed the trail on a put). Short SHARES return null
   gains: their peak would be a LOW, which this does not track, so they stay
   unmanaged by the trail rather than mismanaged by it. */
export function gainFigures({ vehicle, dir, markNow, entryPremium, peakMark, qty }) {
  const mult = vehicle === "OPTION" ? 100 : 1;
  const longPremium = vehicle === "OPTION" || dir > 0;
  const gainPct = markNow > 0 && entryPremium > 0 && longPremium ? ((markNow - entryPremium) / entryPremium) * 100 : null;
  const gainUsd = markNow > 0 && entryPremium > 0 ? (markNow - entryPremium) * qty * mult : null;
  const peakGainPct = peakMark > 0 && entryPremium > 0 ? ((peakMark - entryPremium) / entryPremium) * 100 : null;
  const peakGainUsd = peakMark > 0 && entryPremium > 0 ? (peakMark - entryPremium) * qty * mult : null;
  return { gainPct, gainUsd, peakGainPct, peakGainUsd, mult };
}

/* The profit-and-loss rules, in the order the route applies them. The first
   that fires wins, with one deliberate exception: the outright ceiling
   (take_profit) is checked without an `!exit` guard and so relabels anything
   before it — a position up 150%+ is banked as take_profit whatever else was
   true. Returns { tag, detail } or null.
   Inputs are figures, not a position, so a test can state them directly. */
export function decideProfitExit(cfg, {
  vehicle, closeByEod = false, eod = false, nowEtMinutes = etMinutes(),
  gainPct, gainUsd, peakGainPct, peakGainUsd, peakMark, entryPremium, markNow,
  stopPct = null,
}) {
  const armBar = TRAIL_ARM_PCT[vehicle] ?? TRAIL_ARM_PCT.OPTION;
  const hardBar = HARD_TAKE_PROFIT_PCT[vehicle] ?? HARD_TAKE_PROFIT_PCT.OPTION;
  let exit = null;

  /* The most one trade may lose: 1% of the account. The user stated this as
     the rule for every trade. On 2026-10-08 it had only been built into the
     SIZE of same-day trades, so a multi-day INTC put bought as four contracts
     sat at -$436 with nothing to sell it: its own invalidation was still $2
     away and would have cost about $650. A hard stop on the position's
     dollars, measured at the bid, whatever the idea's own levels say. Checked
     once a minute, so a fast move can overshoot it. */
  if (gainUsd != null && gainUsd <= -cfg.maxLossUsd) {
    exit = { tag: "max_loss", detail: `Down $${Math.abs(gainUsd).toFixed(0)} at the bid — at the $${cfg.maxLossUsd.toFixed(0)} most one trade may lose (${MAX_LOSS_PCT}% of the account)` };
  }
  // The position's own stop (set at entry from its stock's history), else the flat one.
  const lossBar = vehicle === "OPTION" && Number(stopPct) > 0 ? Number(stopPct) : (HARD_LOSS_PCT[vehicle] ?? null);
  if (!exit && lossBar != null && gainPct != null && gainPct <= -lossBar) {
    exit = { tag: "premium_stop", detail: `Down ${Math.abs(gainPct).toFixed(1)}% at the bid ($${entryPremium} to $${markNow}${gainUsd != null ? `, $${Math.abs(gainUsd).toFixed(0)}` : ""}) — past this contract's ${lossBar}% stop` };
  }
  /* A closeByEod position is a short-dated contract that decays ~25% of its
     price a day. The end-of-day dollar bar only ever banks GAINS, so a loser
     would be carried overnight and lose that again. These close in the last
     15 minutes whatever the P&L. */
  if (!exit && eod && closeByEod && nowEtMinutes >= EOD_FLAT_FROM_ET_MIN) {
    exit = { tag: "eod_flat", detail: `Flat by the close: short-dated contract, up/down ${gainUsd != null ? "$" + gainUsd.toFixed(0) : "?"}, not carrying overnight decay` };
  }
  /* Fixed target for the same short-dated contracts. Everywhere else a
     trailing exit beat a fixed one in the replay, but these lose about a
     quarter of their price a day and move fast: MU 10/9 $1082.50c traded
     from $19.25 to $21.10 and back inside ten minutes on 2026-10-07 and was
     never sold. A gain here is taken when it is on the table. */
  if (!exit && closeByEod && gainPct != null && gainPct >= SHORT_DATED_TARGET_PCT) {
    exit = { tag: "quick_target", detail: `Up ${gainPct.toFixed(1)}% ($${entryPremium} to $${markNow} at the bid) — at the ${SHORT_DATED_TARGET_PCT}% target for a short-dated contract, taking it` };
  }
  if (!exit && eod && gainUsd != null && gainUsd >= cfg.eodTakeProfitUsd) {
    exit = { tag: "eod_take_profit", detail: `Up $${gainUsd.toFixed(0)} into the close (${gainPct != null ? gainPct.toFixed(1) + "%" : "?"}) — past the $${cfg.eodTakeProfitUsd.toFixed(0)} late-session bar, banking it rather than carrying overnight gap risk` };
  }
  // Outright ceiling — big enough that it goes in the book now.
  if (gainPct != null && gainPct >= hardBar) {
    exit = { tag: "take_profit", detail: `Up ${gainPct.toFixed(0)}% ($${entryPremium} to $${markNow}) — past the ${hardBar}% ceiling, banking it outright` };
  }
  /* Trailing take-profit: armed once the position has been up at least
     armBar at some point, then exits on a giveback of that peak gain.
     Compares against the PEAK, not the entry, so a winner that rolls over is
     banked near its high instead of round-tripping. A GIVEBACK rule rather
     than a profit target: a position still climbing never trips it. */
  if (!exit && peakGainPct != null && peakGainPct >= armBar && gainPct != null) {
    const givebackPct = peakGainUsd != null && peakGainUsd >= cfg.trailTightenUsd ? TRAIL_GIVEBACK_PCT_LARGE : TRAIL_GIVEBACK_PCT;
    const keepAtLeast = peakGainPct * (1 - givebackPct / 100);
    if (gainPct <= keepAtLeast) {
      exit = {
        tag: "trail_stop",
        detail: `Peaked at +${peakGainPct.toFixed(0)}% ($${peakMark}${peakGainUsd != null ? `, +$${peakGainUsd.toFixed(0)}` : ""}) and gave back to +${gainPct.toFixed(0)}% ($${markNow}) — trailing exit at ${givebackPct}% giveback${givebackPct === TRAIL_GIVEBACK_PCT_LARGE ? ` (tightened: peak gain cleared $${cfg.trailTightenUsd.toFixed(0)})` : ""}, banking +${gainPct.toFixed(0)}%`,
      };
    }
  }
  return exit;
}

/* The plan's own levels. Target is judged on the day's favorable extreme
   (high for a long, low for a short) so a spike that touched it and pulled
   back still counts — except for an intraday position, whose target sits
   inside today's range by design and would read as hit the minute it opened,
   so that one uses the live price. Invalidation is deliberately asymmetric:
   LIVE price only, never the adverse extreme. A one-tick wick through the
   level that has already recovered (a $228.465 low against a $228.50
   invalidation, price back at $230.87 within the hour) would otherwise force
   a realized loss on a position that is currently working. */
export function decideLevelExit({ dir, target, invalidation, strategy, underlyingPx, favorableExtreme }) {
  const targetRef = SAME_DAY_STRATEGIES.has(strategy) ? underlyingPx : favorableExtreme;
  if (target != null && targetRef != null) {
    const hit = dir > 0 ? targetRef >= target : targetRef <= target;
    if (hit) {
      return {
        tag: "target",
        detail: SAME_DAY_STRATEGIES.has(strategy)
          ? `Reached its $${target} same-day target (now $${underlyingPx})`
          : `Hit its $${target} target intraday (day's ${dir > 0 ? "high" : "low"} $${favorableExtreme}, now $${underlyingPx})`,
      };
    }
  }
  if (invalidation != null && underlyingPx != null) {
    const hit = dir > 0 ? underlyingPx <= invalidation : underlyingPx >= invalidation;
    if (hit) return { tag: "invalidation", detail: `Breached its $${invalidation} invalidation with no stop resting to catch it (underlying now $${underlyingPx})` };
  }
  return null;
}

/* How old a read may be and still count as a REVERSAL of a live thesis.
   This used to be unbounded, and that was a real bug: the filter drops WAIT
   ideas and the position's own idea, then took the newest of whatever was
   left — which on a symbol with no other recent directional read is whatever
   is oldest in the ledger. The SPY 10/23 $772c was bought at 14:05 on a 13:46
   CALL; the 14:14 refresh returned WAIT (filtered out), so the "latest read"
   became a PUT from 2026-09-15 and the position was closed as "thesis
   reversed" on a SEVENTEEN-DAY-OLD read, 15 minutes after being opened.
   Two bounds now, and the first is the airtight one: a reversal must POSTDATE
   the thesis it contradicts. An older read is not a change of mind, it is
   just an older read. */
export const REVERSAL_MAX_AGE_MIN = 120;

export function latestIdeaForSymbol(ideas, symbol, excludeIdeaId, sinceMs, now = Date.now()) {
  const floor = Math.max(now - REVERSAL_MAX_AGE_MIN * 60000, Number(sinceMs) || 0);
  const rows = ideas.filter((i) =>
    i.symbol === symbol &&
    i.id !== excludeIdeaId &&
    ["CALL", "PUT", "BUY", "SELL"].includes(i.action) &&
    new Date(i.createdAt).getTime() > floor
  );
  if (!rows.length) return null;
  return rows.reduce((a, b) => (new Date(a.createdAt) > new Date(b.createdAt) ? a : b));
}

/* Thesis reversed: the latest directional read on the symbol, written after
   this position's own idea, points the other way. Not for intraday
   positions — the multi-day read may point the other way from a same-day
   fade by design. */
export function decideReversalExit({ pos, dir, ideas, now = Date.now() }) {
  if (SAME_DAY_STRATEGIES.has(pos.strategy)) return null;
  const ownIdea = pos.ideaId ? ideas.find((i) => i.id === pos.ideaId) : null;
  const sinceMs = new Date(ownIdea?.createdAt || pos.createdAt || 0).getTime();
  const latest = latestIdeaForSymbol(ideas, pos.symbol, pos.ideaId, sinceMs, now);
  const latestDir = latest ? DIRECTION[latest.action] : undefined;
  if (latest && latestDir && latestDir !== dir) {
    return { tag: "reversed", detail: `Latest read flipped to ${latest.action} — ${latest.why_plain || latest.why_pro || "no reason given"}` };
  }
  return null;
}
