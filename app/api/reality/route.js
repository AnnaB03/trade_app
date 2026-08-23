import { NextResponse } from "next/server";
import { fmpGet, fetchStockNews } from "../fmp";
import { dataMode } from "../tradier";
import {
  rvol, floatRotation, volumeRead, newsJustification, headlineAgeHours,
  luldBands, guessTier1, inDoubledWindow,
} from "../../lib/checks";

/* Reality check for one symbol: is the volume real, does news justify the
   move, and where are the halt bands. Cached 2 min per symbol.
   Needs FMP_API_KEY for volume/float/news; halt bands work from price alone. */

const TTL = 2 * 60 * 1000;
const cache = new Map();

export async function GET(req) {
  const symbol = new URL(req.url).searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const sym = symbol.toUpperCase();

  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json(hit.data);

  try {
    const [profRaw, floatRaw, news] = await Promise.all([
      fmpGet("profile", { symbol: sym }),
      fmpGet("shares-float", { symbol: sym }),
      fetchStockNews([sym], 1).catch(() => ({ articles: [] })),
    ]);
    const p = (Array.isArray(profRaw) ? profRaw[0] : profRaw) || null;
    const fl = (Array.isArray(floatRaw) ? floatRaw[0] : floatRaw) || null;

    if (!p) {
      return NextResponse.json({
        available: false,
        reason: process.env.FMP_API_KEY ? `no profile data for ${sym}` : "FMP_API_KEY not set",
      });
    }

    const movePct = Number(p.changePercentage);
    const r = rvol(p.volume, p.averageVolume);
    const rot = floatRotation(p.volume, fl?.floatShares);

    const headline = news?.articles?.[0] || null;
    const ageH = headline ? headlineAgeHours(headline.publishedDate) : null;

    const tier1 = guessTier1({ marketCap: p.marketCap, isEtf: p.isEtf });
    const doubled = inDoubledWindow();
    const bands = luldBands(p.price, { tier1, doubled });

    const data = {
      available: true,
      symbol: sym,
      name: p.companyName,
      price: Number(p.price),
      changePct: Number.isFinite(movePct) ? movePct : null,
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
    cache.set(sym, { at: Date.now(), data });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e.message || e) });
  }
}
