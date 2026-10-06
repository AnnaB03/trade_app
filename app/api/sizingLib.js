/* ---------- Account-size-aware sizing ----------
   The rulebook's "risk 0.5-1% of the account per idea" only means something
   if the app knows the account. Pure functions; the suggestions route feeds
   them the account size (query param -> ACCOUNT_SIZE env -> 1000) and the
   model's own entry/invalidation, and attaches the result to every idea so
   the model, the UI, and the ledger all see the same numbers.

   For a small account the practical consequences are blunt:
   - a long option's max loss is its whole premium, so "1% risk" on a $1,000
     account is $10 — no liquid contract costs that little. We therefore cap
     a contract at a % of the account instead (preferred 5%, hard 10%) and
     treat anything above the hard cap as NOT an option trade for this
     account, whatever the thesis: shares or WAIT.
   - shares are sized off the stop: shares = riskDollars / (entry - stop),
     then capped so one position never exceeds MAX_POSITION_PCT of the
     account. Fractional shares (Robinhood) make even a $40 position real. */

export const RISK_PCT = 0.01;            // per-idea risk, fraction of account
/* One position's total cost, fraction of account. Lowered 0.25 -> 0.15 to
   match MAX_SYMBOL_EXPOSURE_PCT in autotrade, which is the gate that actually
   decides whether an order is placed. While these disagreed, share sizing
   produced positions the gate was supposed to refuse — and because that gate
   skipped new positions entirely, 25% quietly won: NOK opened at $24,948,
   25.2% of the account. Aligning them means a large share idea is sized to
   fit rather than built oversized and then thrown away by the backstop.
   Honest about the calibration: the record does NOT establish that 15% beats
   25% for shares. Closed share positions over 15% are n=4 at -$656 total
   (1 win) against n=14 at -$233 under it — both negative, neither meaningful.
   15% is chosen because it is the number with a documented rationale (three
   INTC strikes reaching 28.8% together), because it is the conservative side
   of a coin-flip with real money close, and because it is one constant to
   raise again if the data ever speaks. One row is at least suggestive: NOK at
   25.2% lost $572 to invalidation, and autotrade opened NOK at 25.2% again. */
export const MAX_POSITION_PCT = 0.15;
// Budget for a whole option POSITION (contracts × premium), not one contract.
// Raised from 5% deliberately: at 5% of a ~$99k account each idea committed
// ~$4,950 and roughly three positions open per day, so the book ran at well
// under 20% utilisation against ~$94k of option buying power. Every outcome
// scales with this number, losses included — an explicit choice to be
// aggressive in a paper account being used to learn, not a default to copy
// onto real money. MAX_CONTRACTS still backstops illiquid names.
/* 0.10 -> 0.15 on 2026-10-06, at the user's call, for the $10K working account.
   At 10% ($1,000) a contract over $1,000 is "not an option trade", which ruled
   out AVGO ($1,170-$1,500), MRVL ($1,695-$1,760) and TSLA ($1,750) — 9 of the
   25 account-sized trades since 09-29, worth +$4,290 as traded. At 15% ($1,500)
   AVGO fits; MRVL and TSLA (they need 18%) still do not. Replay at each cap,
   26 trades: 10% -> 17 tradable, +$1,667; 15% -> 23 tradable, +$2,802; 20% ->
   all 26, +$4,084. That was a rising week, so the totals say what the cap
   admits, not what it earns.
   What it costs: for a long option the worst case is the whole premium, so at
   15% one bad trade can lose $1,500, 15% of the account. That is not
   hypothetical — two QQQ calls expired worthless on 09-14, -100% each. */
export const OPTION_PREFERRED_PCT = 0.15;
export const OPTION_HARD_PCT = 0.15;      // per-contract cost above this = not an option trade for this account
// Ceiling on contract count regardless of how much budget allows. A $66
// penny-name contract against a 5% budget on a six-figure account works out
// to 75 contracts, which is a liquidity problem rather than a position —
// open interest and daily volume on those strikes are often in the hundreds.
export const MAX_CONTRACTS = 25;

export function accountLimits(account) {
  const a = Number(account) > 0 ? Number(account) : 1000;
  return {
    account: a,
    riskDollars: a * RISK_PCT,
    maxPositionDollars: a * MAX_POSITION_PCT,
    optionPreferred: a * OPTION_PREFERRED_PCT,
    optionHardCap: a * OPTION_HARD_PCT,
  };
}

// Dollar cost of one contract from a resolved leg (mid, else ask), or null.
export function contractCost(leg) {
  const px = leg?.mid ?? leg?.ask;
  return px > 0 ? px * 100 : null;
}

// Attach { sizing, affordable } to an idea. Never throws.
export function sizeIdea(idea, account) {
  const L = accountLimits(account);
  const entry = Number(idea.entryPrice);
  const stop = Number(idea.invalidation);

  if (idea.vehicle === "OPTION") {
    const cost = contractCost(idea.leg);
    if (cost == null) return { sizing: null, affordable: null };
    const affordable = cost <= L.optionHardCap;
    // Contract COUNT scales with the account instead of being pinned at 1.
    // Pinned at 1, a six-figure account put ~$800 to work on an idea it had
    // ~$94,000 of option buying power for — 5% utilisation — so even a +127%
    // winner only returned a few hundred dollars. Budget is the preferred
    // percentage of the account, with MAX_CONTRACTS as a liquidity backstop.
    const contracts = affordable
      ? Math.max(1, Math.min(MAX_CONTRACTS, Math.floor(L.optionPreferred / cost)))
      : 0;
    const positionCost = cost * contracts;
    return {
      affordable,
      sizing: {
        vehicle: "OPTION", contracts,
        contractCost: cost,
        dollarCost: positionCost, dollarRisk: positionCost, // long option: max loss = premium
        pctOfAccount: positionCost / L.account,
        comfortable: cost <= L.optionPreferred,
        note: affordable
          ? `${contracts} contract${contracts === 1 ? "" : "s"} × $${cost.toFixed(0)} ≈ $${positionCost.toFixed(0)} (${(positionCost / L.account * 100).toFixed(1)}% of account)${contracts === MAX_CONTRACTS ? ` — capped at ${MAX_CONTRACTS} contracts for liquidity` : ""}`
          : `1 contract ≈ $${cost.toFixed(0)} — ${(cost / L.account * 100).toFixed(0)}% of a $${L.account.toFixed(0)} account, over the ${(OPTION_HARD_PCT * 100).toFixed(0)}% comfort cap. Still real and actionable — just size accordingly and know it's a bigger bet than this account's usual sizing.`,
      },
    };
  }

  if (idea.vehicle === "SHARES") {
    if (!(entry > 0)) return { sizing: null, affordable: true };
    let shares;
    if (stop > 0 && Math.abs(entry - stop) > 0) {
      shares = L.riskDollars / Math.abs(entry - stop);
    } else {
      shares = L.maxPositionDollars / entry; // no stop given: fall back to the position cap
    }
    shares = Math.min(shares, L.maxPositionDollars / entry);
    // Round to a sensible unit: whole shares if the position is at least ~$100
    // at whole-share granularity, else allow fractional (2 dp) — Robinhood
    // supports fractional shares; the Tradier sandbox needs whole ones.
    const whole = Math.floor(shares);
    const useFractional = whole < 1 || whole * entry < 100;
    const qty = useFractional ? Math.max(0.01, Math.round(shares * 100) / 100) : whole;
    const dollarCost = qty * entry;
    const dollarRisk = stop > 0 ? qty * Math.abs(entry - stop) : null;
    return {
      affordable: true,
      sizing: {
        vehicle: "SHARES", shares: qty, fractional: useFractional, dollarCost, dollarRisk,
        pctOfAccount: dollarCost / L.account,
        note: `${useFractional ? qty.toFixed(2) : qty} sh ≈ $${dollarCost.toFixed(0)}${dollarRisk != null ? `, risking ≈ $${dollarRisk.toFixed(0)} to the stop` : ""}${useFractional ? " (fractional — fine on Robinhood; the paper sandbox needs whole shares)" : ""}`,
      },
    };
  }

  return { sizing: null, affordable: null };
}

// One short block for the prompt.
export function accountText(account) {
  const L = accountLimits(account);
  // The "this is SMALL, size is the binding constraint" framing used to be
  // unconditional. On a six-figure account that is simply false, and it
  // actively suppressed ideas: contract cost stopped being a real limit while
  // the prompt kept implying it was, pushing good setups on expensive names
  // toward WAIT for no reason. Say which regime the account is actually in.
  const small = L.account < 25000;
  const header = small
    ? `ACCOUNT SIZE: $${L.account.toFixed(0)}. This is SMALL — size, not thesis quality, is the binding constraint.`
    : `ACCOUNT SIZE: $${L.account.toFixed(0)}. Contract cost is NOT the binding constraint here — nearly any liquid contract fits. Thesis quality and risk control are what matter, so do not pass on a good setup because the premium looks expensive in absolute dollars.`;
  const optionLine = small
    ? `OPTION contract cost limits: comfortable ≤ $${L.optionPreferred.toFixed(0)} (${(OPTION_PREFERRED_PCT * 100).toFixed(0)}%), hard cap $${L.optionHardCap.toFixed(0)} (${(OPTION_HARD_PCT * 100).toFixed(0)}%). A contract costing more than the hard cap is NOT an option trade for this account no matter how good the setup — use SHARES (sized to the risk budget) or WAIT.`
    : `OPTION sizing: position budget ≈ $${L.optionPreferred.toFixed(0)} (${(OPTION_PREFERRED_PCT * 100).toFixed(0)}% of account), spread across up to ${MAX_CONTRACTS} contracts, with a per-contract hard cap of $${L.optionHardCap.toFixed(0)} (${(OPTION_HARD_PCT * 100).toFixed(0)}%). Judge the setup, not the sticker price of one contract.`;
  return [
    header,
    `Per-idea risk budget: $${L.riskDollars.toFixed(0)} (1%). Max cost of any one position: $${L.maxPositionDollars.toFixed(0)} (${(MAX_POSITION_PCT * 100).toFixed(0)}%).`,
    optionLine,
  ].join("\n");
}
