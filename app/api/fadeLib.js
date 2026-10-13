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
export function fadePlan({ action, price, low, high, beyondPct = 10, rewardMult = FADE_REWARD_MULT, force = false }) {
  const read = extremeRead({ action, price, low, high });
  if (read.pos == null) return null;
  if (!force && (!read.atExtreme || !fadeEnabled(read.side))) return null;
  const span = Number(high) - Number(low);
  if (!(span > 0)) return null;
  const long = read.side === "long";
  const buffer = span * (beyondPct / 100);
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
