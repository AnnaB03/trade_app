/* Shared core of the reality check (volume reality, news justification, halt
   bands) — used on demand for one symbol (/api/reality) and in batch for the
   penny-stock scanner (/api/penny). Needs FMP_API_KEY for volume/float/news;
   halt bands work from price alone. */
import { fmpGet, fetchStockNews } from "./fmp";
import { dataMode, tradier } from "./tradier";
import {
  rvolTimeAdjusted, floatRotation, volumeRead, newsJustification, headlineAgeHours,
  luldBands, guessTier1, inDoubledWindow,
} from "../lib/checks";

export async function computeReality(symbol) {
  const sym = symbol.toUpperCase();
  const [profRaw, floatRaw, news] = await Promise.all([
    fmpGet("profile", { symbol: sym }),
    fmpGet("shares-float", { symbol: sym }),
    fetchStockNews([sym], 1).catch(() => ({ articles: [] })),
  ]);
  const p = (Array.isArray(profRaw) ? profRaw[0] : profRaw) || null;
  const fl = (Array.isArray(floatRaw) ? floatRaw[0] : floatRaw) || null;

  if (!p) {
    return { available: false, reason: process.env.FMP_API_KEY ? `no profile data for ${sym}` : "FMP_API_KEY not set" };
  }

  const movePct = Number(p.changePercentage);
  let sessionOpen = true;
  try { sessionOpen = (await tradier(`/markets/clock`))?.clock?.state === "open"; } catch {}
  const r = rvolTimeAdjusted(p.volume, p.averageVolume, { sessionOpen });
  const rot = floatRotation(p.volume, fl?.floatShares);

  const headline = news?.articles?.[0] || null;
  const ageH = headline ? headlineAgeHours(headline.publishedDate) : null;

  const tier1 = guessTier1({ marketCap: p.marketCap, isEtf: p.isEtf });
  const doubled = inDoubledWindow();
  const bands = luldBands(p.price, { tier1, doubled });

  return {
    available: true,
    symbol: sym,
    name: p.companyName,
    price: Number(p.price),
    changePct: Number.isFinite(movePct) ? movePct : null,
    marketCap: p.marketCap != null ? Number(p.marketCap) : null,
    dataMode: dataMode(),
    volume: {
      today: Number(p.volume) || null,
      average: Number(p.averageVolume) || null,
      rvol: r,
      floatShares: fl?.floatShares ? Number(fl.floatShares) : null,
      rotation: rot,
      read: volumeRead(r),
    },
    news: {
      headline: headline && { title: headline.title, site: headline.site, publishedDate: headline.publishedDate, url: headline.url },
      ageHours: ageH,
      verdict: newsJustification(movePct, headline, ageH),
    },
    halt: bands && {
      ...bands,
      doubled,
      tierEstimated: true,
      note: doubled
        ? "Bands are doubled during the opening (9:30–9:45) and closing (3:35–4:00) windows."
        : "Regular-session bands. LULD does not apply in pre/post-market — there, news-pending regulatory halts are the risk.",
    },
  };
}
