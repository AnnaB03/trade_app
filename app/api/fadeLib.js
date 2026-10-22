/* Where a price sits in the day's range, and what to do about it.

   Added 2026-10-13 from the user's own read of the book: *"if Puts bought near
   the day's low and Calls bought near the day's high, those options go the
   opposite direction right away and shouldn't we treat this as an
   opportunity?"* The measurement behind it, every entry since 2026-10-09:

     calls and share buys, taken at 59-99% of the day's range: 8 trades,
       3 winners (+$107), the rest losers (GOOGL -$101, -$16, AVGO -$116,
       and two more open and red);
     puts, taken at 1-15% of the range: 3 trades, 3 winners (+$172).

   So the exhaustion is one-sided in the record so far: buying strength at the
   high fails, selling weakness at the low works. FADE_SIDES decides which
   side is flipped — "long" (the default, flip only the failing one), "both"
   (the user's idea in full), or "none".

   Two consequences at the extreme, and they belong together: the breakout
   playbooks stand down there, and the fade takes the other side. Said plainly:
   this would also have blocked Friday's three winners, which were taken at 99%
   of the range on a trending day. The sample is 11 closed trades. */

export const EXTREME_PCT = Number(process.env.FADE_EXTREME_PCT) > 0 ? Number(process.env.FADE_EXTREME_PCT) : 85;
export const FADE_SIDES = ["long", "both", "none"].includes(String(process.env.FADE_SIDES)) ? String(process.env.FADE_SIDES) : "long";
const BULLISH = new Set(["CALL", "BUY"]);

// 0 = at the day's low, 100 = at the day's high. null when there is no range.
export function rangePosition(price, low, high) {
  const p = Number(price), l = Number(low), h = Number(high);
  if (!(p > 0) || !(l > 0) || !(h > 0) || h <= l) return null;
  return Math.max(0, Math.min(100, ((p - l) / (h - l)) * 100));
}

/* Is this entry being taken at the extreme the trade needs to keep running?
   A call at the top of the range and a put at the bottom are both "extreme";
   either one has to continue immediately to pay. */
export function extremeRead({ action, price, low, high, threshold = EXTREME_PCT }) {
  const pos = rangePosition(price, low, high);
  if (pos == null) return { pos: null, atExtreme: false, side: null };
  const bullish = BULLISH.has(action);
  const atExtreme = bullish ? pos >= threshold : pos <= 100 - threshold;
  return { pos, atExtreme, side: bullish ? "long" : "short" };
}

/* Which fade trades are taken: CALLS only since 2026-10-15, the owner: "lets
   try turning off the fade puts and keep the fade calls". The record:
     fading a PUT idea in a transitioning tape (buys a call)    4 for 4, +$887
     fading a CALL idea in an uptrend (buys a put)              0 for 2, -$324
     fading a CALL breakout at the day's high (buys a put)      0 for 2, -$911
   Buying weakness has worked and selling strength has not, as with the
   model's own ideas the week before. FADE_ACTIONS=CALL,PUT restores both. */
export const FADE_ACTIONS = new Set(String(process.env.FADE_ACTIONS || "CALL").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean));
export const fadeActionAllowed = (action, allowed = FADE_ACTIONS) => allowed.has(String(action).toUpperCase());

/* A fade is not taken against a one-sided read (2026-10-22, the owner: "fades
   can be fixed"). A fade bets a move is overdone; when the model's other ideas
   from the last 30 minutes mostly point the other way, the move is usually
   real. Since the restart every big losing fade had 5-8 opposite ideas to 0-3
   on its side (GOOGL 3/8, ORCL/AMZN/NVDA 1/7, SPY/AVGO 1/6, QQQ 0/5:
   -$2,841), and the four winners did not (10/4, 10/4, 0/0, 1/2: +$887).
   Blocked when at least FADE_TAPE_MIN ideas oppose it and they outnumber its
   side. Found on the same 12 trades it is scored on; the shadow book keeps
   scoring it. recentActions: the model's CALL/PUT actions from the window. */
/* Live fades on index ETFs only (2026-10-22, the owner: "lets keep option 2").
   QQQ fades won 4 of 5 (its one loss was against a one-sided read, which
   fade_vs_tape now skips); single stocks lost all 7 (NVDA x2, ORCL, AMZN,
   AVGO, MU, GOOGL: -$2,302). An index tends to snap back after a stretch; a
   single stock moving on its own news tends to keep going. Single-stock fades
   are recorded to the shadow book (fade_single_stock), not placed; to be
   looked at again after 20+ fades. FADE_SYMBOLS overrides the list. */
export const FADE_SYMBOLS = new Set(String(process.env.FADE_SYMBOLS || "QQQ,SPY,IWM,DIA").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean));
export const fadeSymbolAllowed = (symbol, allowed = FADE_SYMBOLS) => allowed.has(String(symbol).toUpperCase());

export const FADE_TAPE_MIN = 3;
export const FADE_TAPE_WINDOW_MIN = 30;
export function fadeAgainstTape({ fadeAction, recentActions }) {
  const same = (recentActions || []).filter((a) => a === fadeAction).length;
  const opposite = (recentActions || []).filter((a) => (a === "CALL" || a === "PUT") && a !== fadeAction).length;
  return opposite >= FADE_TAPE_MIN && opposite > same
    ? `The model's ideas from the last ${FADE_TAPE_WINDOW_MIN} minutes point the other way ${opposite} to ${same}; not fading a one-sided read.`
    : null;
}

export const fadeEnabled = (side) => FADE_SIDES === "both" || (FADE_SIDES === "long" && side === "long");

/* The plan for the opposite side: the levels, in the UNDERLYING's price.

   The invalidation sits a short way BEYOND the extreme being chased — through
   there, the exhaustion read was simply wrong. The target is then set from
   that risk, so the geometry holds wherever in the range the entry is taken.
   Written the other way round first (target a fixed share of the range back)
   it came out at 1:1 for an entry at 85% of the range, which the 1.5:1 floor
   in autotrade refuses every time, so the playbook could only ever have fired
   at the exact high. */
export const FADE_REWARD_MULT = 1.8;

/* `force` builds the plan wherever the price sits in the range — used when the
   reason to fade is the regime (selectionLib.js) rather than the extreme. Away
   from the extreme the stop is further off, so the risk per contract is
   larger, and autotrade's risk sizing refuses the ones that are too far. */
/* The stop must sit outside one minute's noise. GOOGL on 2026-10-14 at 09:45:
   the day's range was $3.48 after 15 minutes, so the buffer was $0.35 and the
   whole stop $0.42 — on a stock whose 09:45 bar alone spanned $1.20. It was
   hit 18 seconds after the fill. The buffer is now at least MIN_STOP_PCT of
   the price, whatever the range says, and fades are not built in the first
   half hour, when the range is still forming. */
export const MIN_STOP_PCT = Number(process.env.FADE_MIN_STOP_PCT) > 0 ? Number(process.env.FADE_MIN_STOP_PCT) : 0.5;
export const FADE_FROM_ET_MIN = 10 * 60;

export function fadePlan({ action, price, low, high, beyondPct = 10, rewardMult = FADE_REWARD_MULT, force = false, etMinutes = null }) {
  const read = extremeRead({ action, price, low, high });
  if (read.pos == null) return null;
  if (!force && (!read.atExtreme || !fadeEnabled(read.side))) return null;
  if (etMinutes != null && etMinutes < FADE_FROM_ET_MIN) return null;
  const span = Number(high) - Number(low);
  if (!(span > 0)) return null;
  const long = read.side === "long";
  const buffer = Math.max(span * (beyondPct / 100), Number(price) * (MIN_STOP_PCT / 100));
  const invalidation = long ? Math.max(Number(high), Number(price)) + buffer : Math.min(Number(low), Number(price)) - buffer;
  const risk = Math.abs(invalidation - Number(price));
  if (!(risk > 0)) return null;
  const target = long ? Number(price) - risk * rewardMult : Number(price) + risk * rewardMult;
  return {
    action: long ? "PUT" : "CALL",
    optionType: long ? "put" : "call",
    invalidation: Number(invalidation.toFixed(2)),
    target: Number(target.toFixed(2)),
    riskUsd: Number(risk.toFixed(2)),
    rewardRisk: Number(rewardMult.toFixed(2)),
    rangePos: Number(read.pos.toFixed(0)),
    from: action,
  };
}
