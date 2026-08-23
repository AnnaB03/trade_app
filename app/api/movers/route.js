import { NextResponse } from "next/server";
import { fmpGet } from "../fmp";
import { extendedQuotes } from "../extended";
import { tradier } from "../tradier";

/* Top movers, two views:
   - session: FMP biggest gainers/losers (updates intraday), filtered to
     tradeable names — raw FMP lists are dominated by sub-$5 micro-caps,
     SPAC rights, and 2x leveraged single-stock ETFs.
   - extended: the "Moderna at 8am" scan — take the freshest market-wide
     headlines, price each mentioned symbol via Tradier extended-session
     timesales, and rank by |pre/post-market move|. This catches news-driven
     gaps BEFORE they appear on any regular-session gainers list.
   Cached 5 min. Degrades to available:false without FMP_API_KEY. */

const TTL = 5 * 60 * 1000;
let cached = null;

const LEVERAGED = /\b(2x|3x|1\.5x|-1x|etf|etn|daily target|leverage|direxion|proshares|graniteshares|21shares|teucrium|ultra|bull|bear|acquisition corp|rights|warrants?|units?)\b/i;
const NEWS_SPAM = /(class action|lawsuit|law firm|deadline|investor(s)? (rights|counsel)|lead plaintiff|securities fraud|investigation|shareholder alert)/i;
const REAL_TICKER = /^[A-Z]{1,5}$/;

const cleanMovers = (rows) =>
  (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.symbol && REAL_TICKER.test(r.symbol) && Number(r.price) >= 5 && !LEVERAGED.test(r.name || ""))
    .slice(0, 8)
    .map((r) => ({ symbol: r.symbol, name: r.name, price: Number(r.price), changePct: Number(r.changesPercentage) }));

export async function GET() {
  if (cached && Date.now() - cached.at < TTL) return NextResponse.json(cached.data);
  if (!process.env.FMP_API_KEY) {
    return NextResponse.json({ available: false, session: { gainers: [], losers: [] }, extended: [] });
  }
  try {
    const [gainRaw, loseRaw, newsRaw] = await Promise.all([
      fmpGet("biggest-gainers"),
      fmpGet("biggest-losers"),
      fmpGet("news/stock-latest", { limit: 40 }),
    ]);

    const news = (Array.isArray(newsRaw) ? newsRaw : [])
      .filter((a) => a?.symbol && a?.title && REAL_TICKER.test(a.symbol) && !NEWS_SPAM.test(a.title))
      .map((a) => ({ symbol: a.symbol, title: a.title, site: a.site, publishedDate: a.publishedDate }));
    const headlineBySym = {};
    for (const a of news) if (!headlineBySym[a.symbol]) headlineBySym[a.symbol] = a;

    const gainers = cleanMovers(gainRaw).map((m) => ({ ...m, headline: headlineBySym[m.symbol] || null }));
    const losers = cleanMovers(loseRaw).map((m) => ({ ...m, headline: headlineBySym[m.symbol] || null }));

    // News-driven scan. Only meaningful outside the regular session: during
    // market hours the timesales window is dominated by regular-session bars,
    // so the same numbers would be "today's move" mislabelled as extended
    // hours — and FMP's gainers list already covers that live.
    let clockState = "unknown";
    try { clockState = (await tradier(`/markets/clock`))?.clock?.state || "unknown"; } catch {}
    const regularSession = clockState === "open" || clockState === "unknown";

    let extended = [];
    if (!regularSession) {
      try {
        const newsSyms = [...new Set(news.map((a) => a.symbol))];
        const ext = await extendedQuotes(newsSyms);
        extended = ext
          .filter((e) => e.extChangePct != null && Math.abs(e.extChangePct) >= 3)
          .sort((x, y) => Math.abs(y.extChangePct) - Math.abs(x.extChangePct))
          .slice(0, 8)
          .map((e) => ({ symbol: e.symbol, ext: e.ext, extChangePct: e.extChangePct, asOf: e.asOf, headline: headlineBySym[e.symbol] || null }));
      } catch {}
    }

    const data = { available: true, marketState: clockState, session: { gainers, losers }, extended };
    cached = { at: Date.now(), data };
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ available: false, session: { gainers: [], losers: [] }, extended: [], reason: String(e.message || e) });
  }
}
