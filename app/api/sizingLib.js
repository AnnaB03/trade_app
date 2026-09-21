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
export const MAX_POSITION_PCT = 0.25;    // one position's total cost, fraction of account
export const OPTION_PREFERRED_PCT = 0.05; // contract cost we'd call comfortable
export const OPTION_HARD_PCT = 0.10;      // contract cost above this = not an option trade for this account

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
    return {
      affordable,
      sizing: {
        vehicle: "OPTION", contracts: affordable ? 1 : 0, dollarCost: cost, dollarRisk: cost, // long option: max loss = premium
        pctOfAccount: cost / L.account,
        comfortable: cost <= L.optionPreferred,
        note: affordable
          ? (cost <= L.optionPreferred ? `1 contract ≈ $${cost.toFixed(0)} (${(cost / L.account * 100).toFixed(0)}% of account)` : `1 contract ≈ $${cost.toFixed(0)} — ${(cost / L.account * 100).toFixed(0)}% of the account, above the ${(OPTION_PREFERRED_PCT * 100).toFixed(0)}% comfort line`)
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
  return [
    `ACCOUNT SIZE: $${L.account.toFixed(0)}. This is SMALL — size, not thesis quality, is the binding constraint.`,
    `Per-idea risk budget: $${L.riskDollars.toFixed(0)} (1%). Max cost of any one position: $${L.maxPositionDollars.toFixed(0)} (25%).`,
    `OPTION contract cost limits: comfortable ≤ $${L.optionPreferred.toFixed(0)} (5%), hard cap $${L.optionHardCap.toFixed(0)} (10%). A contract costing more than the hard cap is NOT an option trade for this account no matter how good the setup — use SHARES (sized to the risk budget) or WAIT.`,
  ].join("\n");
}
