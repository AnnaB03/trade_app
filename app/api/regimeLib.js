/* ---------- Market regime ----------
   The single block every rule-of-thumb desk checks before anything else:
   is the tape trending or chopping, is fear rich or cheap, are we in a
   rotation. Feeds the Ideas prompt and a banner in the UI.
   Uses only Tradier (quotes + daily history) — no extra API key needed. */
import { tradier, asArray } from "./tradier";
import { dailyCloses } from "./historyCache";
import { openingDrive, openingDriveText } from "./openingDriveLib";

const sma = (closes, n) => {
  if (closes.length < n) return null;
  const w = closes.slice(-n);
  return w.reduce((s, v) => s + v, 0) / n;
};

const trendLabel = (last, s20, s50, s200) => {
  if (last == null) return "unknown";
  const above20 = s20 != null && last > s20;
  const above50 = s50 != null && last > s50;
  const above200 = s200 != null && last > s200;
  if (s200 != null && above20 && above50 && above200) return "uptrend";
  if (s200 != null && !above20 && !above50 && !above200) return "downtrend";
  if (above50 !== above200) return "transitioning";
  return "mixed / range";
};

const vixRegime = (vix) => {
  if (vix == null) return "unknown";
  if (vix < 15) return "calm — low realized/implied vol, premium is cheap";
  if (vix < 20) return "normal";
  if (vix < 30) return "elevated — expect wider ranges and pricier options";
  return "fear — large moves likely, defined risk only";
};

async function symbolBlock(symbol) {
  const [q, closes] = await Promise.all([
    tradier(`/markets/quotes?symbols=${symbol}`).then((d) => asArray(d?.quotes?.quote)?.[0] || {}).catch(() => ({})),
    dailyCloses(symbol, 320), // ~320 calendar days to safely cover 200 trading days
  ]);
  const last = Number(q.last) || (closes.length ? closes[closes.length - 1] : null);
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  return {
    symbol, last, chgPct: q.change_percentage != null ? Number(q.change_percentage) : null,
    sma20: s20, sma50: s50, sma200: s200, trend: trendLabel(last, s20, s50, s200),
  };
}

export async function marketRegime() {
  try {
    const [spy, qqq, iwm, vixQuote, vixCloses, spyDrive] = await Promise.all([
      symbolBlock("SPY"), symbolBlock("QQQ"), symbolBlock("IWM"),
      tradier(`/markets/quotes?symbols=VIX`).then((d) => asArray(d?.quotes?.quote)?.[0] || {}).catch(() => ({})),
      dailyCloses("VIX", 10),
      openingDrive("SPY").catch(() => null),
    ]);
    const vix = Number(vixQuote.last) || (vixCloses.length ? vixCloses[vixCloses.length - 1] : null);
    const vix5dAgo = vixCloses.length >= 6 ? vixCloses[vixCloses.length - 6] : null;
    const vixChg5d = vix != null && vix5dAgo ? ((vix - vix5dAgo) / vix5dAgo) * 100 : null;
    // Cheap breadth proxy: large-cap (SPY) vs small-cap (IWM) relative strength today.
    const rotation = spy.chgPct != null && iwm.chgPct != null
      ? spy.chgPct - iwm.chgPct > 0.5 ? "large-cap leadership (risk-off within equities)"
        : iwm.chgPct - spy.chgPct > 0.5 ? "small-cap leadership (risk-on within equities)"
        : "no clear size rotation"
      : "unknown";
    return {
      available: true, asOf: new Date().toISOString(),
      spy, qqq, iwm,
      vix: { last: vix, chg5d: vixChg5d, read: vixRegime(vix) },
      rotation,
      spyDrive: spyDrive || null,
    };
  } catch (e) {
    return { available: false, reason: String(e.message || e) };
  }
}

// One-paragraph text block for the model prompt.
export function regimeText(r) {
  if (!r?.available) return "Market regime: unavailable.";
  const f = (n) => n == null ? "?" : n.toFixed(1);
  const driveTxt = openingDriveText(r.spyDrive);
  return [
    `SPY $${f(r.spy.last)} (${r.spy.chgPct >= 0 ? "+" : ""}${f(r.spy.chgPct)}% today) — ${r.spy.trend} (vs 20/50/200-day SMA).`,
    `QQQ $${f(r.qqq.last)} (${r.qqq.chgPct >= 0 ? "+" : ""}${f(r.qqq.chgPct)}% today) — ${r.qqq.trend}.`,
    `VIX ${f(r.vix.last)} (5-day chg ${r.vix.chg5d != null ? (r.vix.chg5d >= 0 ? "+" : "") + f(r.vix.chg5d) + "%" : "?"}) — ${r.vix.read}.`,
    `Size rotation: ${r.rotation}.`,
    driveTxt ? `SPY ${driveTxt} — see rule 1c and the "By opening drive" line in the track record below for whether this predicts anything yet; never use it before 10:00 ET.` : null,
  ].filter(Boolean).join(" ");
}
