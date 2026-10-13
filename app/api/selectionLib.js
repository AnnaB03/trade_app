/* Which ideas to take, which to leave, and which to take the other side of.

   Written 2026-10-13 from the idea ledger: 673 directional ideas graded on
   what the underlying did afterwards, which makes them independent of our
   fills and 45 times the size of the honest trade record. The entry gates
   were adding nothing — ideas we traded graded +0.04R, ideas we skipped
   +0.06R — so the edge has to come from WHICH ideas are taken.

   What the ledger says (h1 = one hour later, d1 = one day later):

     regime         side    h1 right  h1 avgR   d1 avgR    n
     uptrend        CALL      43%     -0.78     -1.04     240   <- worst, and biggest
     uptrend        PUT       77%     +1.60     +1.33      53
     transitioning  CALL      73%     +1.24     +1.93      33
     transitioning  PUT        2%     -1.33     -0.07      45   <- 1 right in 45
     mixed / range  either    ~42%    ~+0.15    ~+0.8     149   (works by the next day)

     calls written 14:00-16:00 ET:  147 ideas, 37% right, -0.55R (puts: +0.89R)
     clinical/FDA catalyst:          15 ideas, 40% right, -2.92R

   So two buckets are not merely skipped but FADED (the opposite side is
   taken, by the contrarian playbook in autotrade): a bullish idea in an
   uptrend, and a bearish idea in a transitioning tape.

   Read this with its limits. The "uptrend" label comes from SPY against its
   moving averages, and the ledger covers about five weeks, so those 240
   calls come from one stretch of one market, not 240 independent tries. If
   the tape changes character this can be exactly wrong, which is why every
   fade is tagged (strategy "contrarian") and judged on its own record, and
   why SELECTION_RULES=off restores the old behaviour in one line. */

const BULLISH = new Set(["CALL", "BUY"]);
const BEARISH = new Set(["PUT", "SELL"]);
export const LATE_CALL_FROM_ET_MIN = 14 * 60;
export const selectionOn = () => String(process.env.SELECTION_RULES || "").toLowerCase() !== "off";

/* { ok, fade, rule, reason }.
   ok   — the idea may be traded as written.
   fade — when not ok: the other side should be taken instead. */
export function selectionVerdict({ action, regime, etMinutes, catalyst }) {
  if (!selectionOn()) return { ok: true, fade: false };
  const bullish = BULLISH.has(action), bearish = BEARISH.has(action);
  if (!bullish && !bearish) return { ok: true, fade: false };
  if (/clinical|fda/i.test(String(catalyst || ""))) {
    return { ok: false, fade: false, rule: "catalyst", reason: "Clinical/FDA catalyst — 15 such ideas in the ledger, 40% right, -2.92R. A binary event, not a setup." };
  }
  if (bullish && regime === "uptrend") {
    return { ok: false, fade: true, rule: "regime", reason: "Bullish idea in an uptrend — the ledger's worst bucket (240 ideas, 43% right an hour later, -0.78R). The fade playbook takes the other side." };
  }
  if (bearish && regime === "transitioning") {
    return { ok: false, fade: true, rule: "regime", reason: "Bearish idea in a transitioning tape — 1 right in 45 an hour later (-1.33R). The fade playbook takes the other side." };
  }
  if (bullish && Number(etMinutes) >= LATE_CALL_FROM_ET_MIN) {
    return { ok: false, fade: false, rule: "late_call", reason: "Bullish idea after 14:00 ET — 147 such ideas, 37% right, -0.55R. Puts in the same window are +0.89R and stay allowed." };
  }
  return { ok: true, fade: false };
}
