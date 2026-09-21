/* ---------- Calendar effects ----------
   Recurring, date-driven flow that has nothing to do with any single
   company's news but still moves prices: options expiration, index
   rebalance-adjacent windows, and turn-of-month flows.
   Pure date math off the ET calendar date — no API calls, no key needed.
   Trading-day precision (skipping holidays) is NOT attempted; the calendar
   here is calendar-day based and flagged as approximate in each label. */

const isFriday = (d) => d.getDay() === 5;
const isWednesday = (d) => d.getDay() === 3;

// Third Friday of the given year/month (0-indexed month).
function thirdFriday(year, month) {
  const d = new Date(year, month, 1);
  let count = 0;
  while (true) {
    if (isFriday(d)) { count++; if (count === 3) return d; }
    d.setDate(d.getDate() + 1);
  }
}

const sameDate = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

// Hardcoded US equity-market half days — update yearly. Kept short and
// explicit rather than computed, since the underlying rule (day before/after
// certain holidays, if a trading day) has enough exceptions to not be worth
// deriving generically here.
const HALF_DAYS_2026 = ["2026-07-02", "2026-11-27", "2026-12-24"];

// dateStr: "YYYY-MM-DD" (ET). Returns flags + short human labels for badges/prompt.
export function calendarEffects(dateStr) {
  const [y, m, day] = dateStr.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  const opex = thirdFriday(y, m - 1);
  const isOpexDay = sameDate(d, opex);
  const isOpexWeek = d >= new Date(opex.getFullYear(), opex.getMonth(), opex.getDate() - 4) && d <= opex;
  const quadMonths = [2, 5, 8, 11]; // Mar, Jun, Sep, Dec (0-indexed)
  const isQuadWitching = isOpexDay && quadMonths.includes(opex.getMonth());
  // Approximate — the true rule is "30 days before the FOLLOWING month's SPX
  // opex"; this flags the commonly-referenced "Wednesday of opex week" proxy,
  // which is close most months but not exact. Good enough for a heads-up,
  // not for trading VIX derivatives off of.
  const isVixExpiryApprox = isWednesday(d) && isOpexWeek;
  const dim = daysInMonth(y, m - 1);
  const isMonthEnd = day >= dim - 1; // last 2 calendar days, approximation for last trading day(s)
  const isQuarterEnd = isMonthEnd && quadMonths.includes(m - 1);
  const isFirstTwoDaysOfMonth = day <= 2;
  const isHalfDay = HALF_DAYS_2026.includes(dateStr);

  const labels = [];
  if (isQuadWitching) labels.push("Quad witching");
  else if (isOpexDay) labels.push("Monthly OPEX");
  else if (isOpexWeek) labels.push("OPEX week");
  if (isVixExpiryApprox) labels.push("~VIX expiry");
  if (isQuarterEnd) labels.push("Quarter-end");
  else if (isMonthEnd) labels.push("Month-end");
  if (isFirstTwoDaysOfMonth) labels.push("Start-of-month inflows");
  if (isHalfDay) labels.push("Half day (1pm ET close)");

  return { isOpexDay, isOpexWeek, isQuadWitching, isVixExpiryApprox, isMonthEnd, isQuarterEnd, isFirstTwoDaysOfMonth, isHalfDay, labels };
}

export function calendarEffectsText(eff) {
  if (!eff.labels.length) return "";
  return `Calendar flow today: ${eff.labels.join(", ")}. ${eff.isQuadWitching || eff.isOpexDay ? "Expect pinning toward heavy-OI strikes into the close and a possible gamma unwind next session. " : ""}${eff.isMonthEnd ? "Month/quarter-end flows can distort the last hour independent of news. " : ""}${eff.isFirstTwoDaysOfMonth ? "Systematic inflows have a mild historical upward bias early in the month. " : ""}`.trim();
}
