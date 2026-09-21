/* ---------- Affordable underlyings for a small account ----------
   The default watchlist is SPY/SPX/QQQ/NVDA/TSLA/AMD — all $200-$7,600
   names whose 3-6 week ATM contracts cost $600-$1,000+, i.e. most or all of
   a ~$1,000 account in one trade. This scan finds liquid, optionable,
   CHEAPER names (roughly $5-$30 for a $1k account; the band scales with
   account size) so the Ideas engine has something it can actually size.
   FMP company-screener first; a curated fallback if the key/endpoint is
   unavailable. Final affordability is still judged on the real contract
   price the suggestions route fetches — this is just the candidate pool. */
import { fmpGet } from "./fmp";

const REAL_TICKER = /^[A-Z]{1,5}$/;

// Liquid, optionable, historically cheap names — only used when the
// screener is unavailable. Prices drift; the route re-checks every one.
const FALLBACK = ["F", "NOK", "PFE", "T", "NU", "VALE", "SOFI", "SNAP", "INTC", "BAC", "CCL", "AAL", "RIVN", "PLUG", "KVUE", "WBD", "GRAB", "SIRI", "CMCSA", "MARA"];

export function affordableBand(account) {
  const a = Number(account) > 0 ? Number(account) : 1000;
  // ~3% of the account as the max share price keeps a 3-6 week ATM contract
  // (typically ~3-6% of the share price × 100) near the 10% hard cap.
  const maxPrice = Math.max(12, Math.min(200, a * 0.03));
  return { minPrice: 5, maxPrice };
}

export async function affordableCandidates({ account, exclude = [], cap = 4 } = {}) {
  const { minPrice, maxPrice } = affordableBand(account);
  const skip = new Set(exclude.map((s) => s.toUpperCase()));
  let rows = null;
  if (process.env.FMP_API_KEY) {
    rows = await fmpGet("company-screener", {
      priceMoreThan: String(minPrice), priceLowerThan: String(maxPrice),
      volumeMoreThan: "3000000", exchange: "NASDAQ,NYSE", isActivelyTrading: "true", isEtf: "false", limit: "60",
    });
  }
  let picks;
  if (Array.isArray(rows) && rows.length) {
    picks = rows
      .filter((r) => r?.symbol && REAL_TICKER.test(r.symbol) && !skip.has(r.symbol) && Number(r.price) >= minPrice && Number(r.price) <= maxPrice)
      .sort((a, b) => Number(b.avgVolume || b.volume || 0) - Number(a.avgVolume || a.volume || 0))
      .slice(0, cap)
      .map((r) => ({ symbol: r.symbol, name: r.companyName, price: Number(r.price), avgVolume: Number(r.avgVolume || r.volume || 0), source: "screener" }));
  } else {
    picks = FALLBACK.filter((s) => !skip.has(s)).slice(0, cap).map((s) => ({ symbol: s, name: null, price: null, avgVolume: null, source: "fallback" }));
  }
  return { band: { minPrice, maxPrice }, candidates: picks };
}
