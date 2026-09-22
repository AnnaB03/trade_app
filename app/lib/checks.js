/* ---------- Reality checks on a moving stock ----------
   Three questions a trader asks before touching a mover:
     1. Is the volume real?      → relative volume + float rotation
     2. Does news justify it?    → catalyst type, freshness, presence
     3. Where can it halt?       → LULD bands
   Pure functions; the route supplies live data. */

/* ---------- 1. Volume ---------- */

// RVOL = today's volume / average daily volume. The single best tell for
// whether a move has real participation behind it.
export function rvol(volume, averageVolume) {
  const v = Number(volume), a = Number(averageVolume);
  if (!(v >= 0) || !(a > 0)) return null;
  return v / a;
}

// Minutes elapsed since the 9:30 ET open, clamped to the 390-minute regular
// session. Used to time-adjust RVOL — comparing today's PARTIAL volume to a
// FULL prior-day average understates RVOL all morning (it reads ~0.2x at
// 10:00 on a perfectly ordinary day, which looks like "thin, fake move" when
// it is nothing of the sort).
export function elapsedSessionMinutes(now = new Date()) {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes() - 9 * 60 - 30;
  return Math.max(1, Math.min(390, mins));
}

// RVOL adjusted for how much of the session has elapsed. Outside the regular
// session (or when the state is unknown) the adjustment isn't meaningful, so
// callers should pass sessionOpen=false and get the plain ratio back.
export function rvolTimeAdjusted(volume, averageVolume, { sessionOpen = true, now = new Date() } = {}) {
  const v = Number(volume), a = Number(averageVolume);
  if (!(v >= 0) || !(a > 0)) return null;
  if (!sessionOpen) return v / a;
  const frac = elapsedSessionMinutes(now) / 390;
  return v / (a * frac);
}

// Share of the tradeable float that changed hands. >1 means the entire float
// turned over — the hallmark of a genuine squeeze.
export function floatRotation(volume, floatShares) {
  const v = Number(volume), f = Number(floatShares);
  if (!(v >= 0) || !(f > 0)) return null;
  return v / f;
}

export function volumeRead(r) {
  if (r == null) return { tone: "muted", text: "volume data unavailable" };
  if (r >= 5) return { tone: "strong", text: `${r.toFixed(1)}× normal volume — heavy real participation` };
  if (r >= 2) return { tone: "strong", text: `${r.toFixed(1)}× normal volume — elevated, real interest` };
  if (r >= 1) return { tone: "flat", text: `${r.toFixed(1)}× normal volume — ordinary participation` };
  return { tone: "weak", text: `${r.toFixed(2)}× normal volume — BELOW average; thin book, moves are easy to fake and hard to exit` };
}

/* ---------- 2. News ---------- */

// Catalyst taxonomy. `weight` = how much price movement the catalyst class
// typically justifies: "high" can explain a large gap on its own, "low" cannot.
/* Patterns use a leading \b only: many entries are stems (acquir, dilut,
   therap) and a trailing \b would stop them matching their own inflections
   ("acquire", "dilution", "therapeutics"). Analyst actions are tested before
   M&A so a rating change "to buy" is not read as a takeover. */
const CATALYSTS = [
  { kind: "dilution", weight: "bearish", re: /\b(public offering|pricing of|registered direct|convertible note|shelf registration|at-the-market|atm program|dilut|secondary offering|private placement)/i },
  { kind: "analyst action", weight: "low", re: /\b(upgrade|downgrade|price target|initiated coverage|reiterat|raises target|cuts target|analyst)/i },
  { kind: "clinical/FDA", weight: "high", re: /\b(fda|phase [123]|clinical|trial|breakthrough|efficacy|endpoint|vaccine|therap|drug|indication|orphan|pdufa|approval for)/i },
  { kind: "M&A", weight: "high", re: /\b(acquir|merger|merge|takeover|buyout|stake in|tender offer|bid for|going private|letter of intent|non-binding|definitive agreement|strategic transaction|interest in the|% interest in|joint venture)/i },
  { kind: "earnings/guidance", weight: "high", re: /\b(earnings|quarterly results|q[1-4] (results|earnings)|beats|misses|revenue|guidance|outlook|forecast|profit warning)/i },
  { kind: "contract/partnership", weight: "medium", re: /\b(contract|partnership|collaborat|agreement|awarded|order worth|supply deal|licens)/i },
  { kind: "leadership/restructuring", weight: "medium", re: /\b(ceo|cfo|resign|steps down|appoint|layoff|restructur|bankrupt|chapter 11)/i },
];

export function classifyCatalyst(title) {
  if (!title) return null;
  for (const c of CATALYSTS) if (c.re.test(title)) return { kind: c.kind, weight: c.weight };
  return { kind: "general news", weight: "unknown" };
}

// US/Eastern UTC offset (ms) at a given instant — +4h in EDT, +5h in EST.
// Derived via Intl so it is correct year-round and independent of server TZ.
function easternOffsetMs(instant) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
  const wallAsUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return instant.getTime() - wallAsUTC;
}

// Age of a headline in hours. FMP timestamps are US/Eastern wall-clock with no
// zone marker, so the offset must be resolved for that date — a fixed -04:00
// is an hour wrong for roughly half the year (EST).
export function headlineAgeHours(publishedDate, now = new Date()) {
  if (!publishedDate) return null;
  const naive = Date.parse(String(publishedDate).trim().replace(" ", "T") + "Z");
  if (isNaN(naive)) return null;
  const t = naive + easternOffsetMs(new Date(naive));
  const h = (now.getTime() - t) / 3600000;
  return h >= 0 ? h : 0;
}

export const ageRead = (h) =>
  h == null ? "unknown age"
  : h < 1 ? `${Math.round(h * 60)} min ago`
  : h < 48 ? `${h.toFixed(1)} h ago`
  : `${Math.round(h / 24)} days ago`;

/* Does the news justify the move? Deliberately characterizes rather than
   scores — the judgment stays with the trader. The valuable output is the
   mismatch: a large move with no fresh news, or explained only by a weak
   catalyst, is the classic trap. */
export function newsJustification(movePct, headline, ageH) {
  const move = Math.abs(Number(movePct) || 0);
  const big = move >= 10, notable = move >= 4;
  if (!headline) {
    return big
      ? { tone: "warn", text: `${move.toFixed(1)}% move with NO news found — unexplained moves on no catalyst are the most common trap (thin book, promotion, or data error). Find the reason before trading it.` }
      : { tone: "muted", text: "no recent headline found" };
  }
  const cat = classifyCatalyst(headline.title);
  const stale = ageH != null && ageH > 24;
  const bits = [`catalyst: ${cat.kind}`, ageRead(ageH)];
  if (cat.weight === "bearish") {
    return { tone: "warn", text: `${bits.join(" · ")} — share issuance DILUTES existing holders and usually caps or reverses a rally. Read the filing before buying strength.`, cat };
  }
  if (big && (cat.weight === "low" || stale)) {
    return { tone: "warn", text: `${bits.join(" · ")} — a ${move.toFixed(1)}% move is large for this catalyst${stale ? " and the headline is stale" : ""}. The news may not fully explain the move; something else may be driving it.`, cat };
  }
  if (notable && cat.weight === "high" && !stale) {
    return { tone: "ok", text: `${bits.join(" · ")} — a material catalyst consistent with a move of this size.`, cat };
  }
  return { tone: "muted", text: bits.join(" · "), cat };
}

/* ---------- 3. Halt levels (LULD) ---------- */

/* Limit Up-Limit Down bands, per the NMS plan for extraordinary volatility:
     Tier 1 (S&P 500 / Russell 1000 / select ETPs), ref > $3.00 → ±5%
     Tier 2 (everything else),                      ref > $3.00 → ±10%
     any tier, ref $0.75–$3.00                                  → ±20%
     any tier, ref < $0.75                          → lesser of $0.15 or 75%
   Bands DOUBLE 9:30–9:45am and 3:35–4:00pm ET.
   Two honest caveats, surfaced in the UI:
   - the real reference price is a rolling 5-minute mean, not the last trade,
     so these levels are indicative;
   - LULD applies only in the regular session — there are no LULD halts in
     pre/post-market, where regulatory (news-pending) halts are the risk. */
export function luldBands(price, { tier1 = false, doubled = false } = {}) {
  const p = Number(price);
  if (!(p > 0)) return null;
  let pct;
  if (p >= 3) pct = tier1 ? 0.05 : 0.10;
  else if (p >= 0.75) pct = 0.20;
  else pct = Math.min(0.15 / p, 0.75);
  if (doubled) pct *= 2;
  return { pct, up: p * (1 + pct), down: p * (1 - pct), tier: tier1 ? 1 : 2 };
}

// Tier membership is index-based and not exposed by our data sources; market
// cap is a documented approximation only (S&P 500 / Russell 1000 members are
// overwhelmingly large caps). ETPs are treated as Tier 1.
export const guessTier1 = ({ marketCap, isEtf } = {}) =>
  Boolean(isEtf) || Number(marketCap) >= 3e9;

// Bands double in the first 15 and last 25 minutes of the regular session.
export function inDoubledWindow(now = new Date()) {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  return (mins >= 570 && mins < 585) || (mins >= 935 && mins <= 960);
}

/* ---------- 4. Opening drive (9:30-10:00 ET) ----------
   Two rounds of analysis (see docs/opening-drive-plan.md) found no signal in
   "yesterday predicts today's open/gap", but did find a modest one in
   "the first 30 minutes predicts the rest of the session" (pooled
   correlation ~0.25 across NVDA/AAPL/TSLA, 228 sessions). This is the pure,
   unit-testable half of that read — turning a raw % move into a labeled
   strength, given the symbol's own typical first-30-minute size. Fetching
   the actual bars and the historical baseline lives in openingDriveLib.js;
   kept separate so the thresholds here can be tested with no network. */

// strength = how many "typical first-30-minute moves" today's move is.
// Below 0.5x is noise-level for this symbol; at/above 1x is a real push.
export function classifyDrive(drivePct, typical) {
  if (drivePct == null || !Number.isFinite(drivePct)) return { strength: null, state: "n/a" };
  const t = typical > 0 ? typical : 0.6; // flat fallback: ~median first-30 move across liquid large caps
  const strength = Math.abs(drivePct) / t;
  if (strength < 0.5) return { strength, state: "flat" };
  if (drivePct > 0) return { strength, state: strength >= 1 ? "strong up" : "mild up" };
  return { strength, state: strength >= 1 ? "strong down" : "mild down" };
}

// Does a proposed idea's direction agree with the symbol's opening drive?
// actionDirection: +1 (CALL/BUY), -1 (PUT/SELL), 0/null (WAIT) — see gradeLib.directionOf.
// drive: the object classifyDrive/openingDrive produces, or null.
// Returns "with" | "against" | "flat" | null (null = no opinion: drive not
// resolved yet, unavailable, or the idea has no direction).
export function driveAlignment(actionDirection, drive) {
  if (!drive || drive.state === "n/a" || drive.state === "pending") return null;
  if (drive.state === "flat") return "flat";
  if (!actionDirection || drive.drivePct == null) return null;
  const driveSign = drive.drivePct > 0 ? 1 : drive.drivePct < 0 ? -1 : 0;
  if (!driveSign) return "flat";
  return actionDirection === driveSign ? "with" : "against";
}
