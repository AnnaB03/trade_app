import { fmpGet } from "./fmp";
import { extendedQuotes } from "./extended";
import { tradier } from "./tradier";

/* Top movers, three views, all sliced from the SAME two FMP gainers/losers
   fetches — a stock only ever lands in one of "session" or "penny":
   - session: filtered to non-penny tradeable names (>= $5) — raw FMP lists
     are dominated by sub-$5 micro-caps, SPAC rights, and 2x leveraged
     single-stock ETFs.
   - penny: the SEC's own definition, priced $0.10-$5 (below ~$0.10 is
     usually pink-sheet/OTC junk not worth surfacing even here). This is a
     different risk category, not just "cheaper stocks" — thin float,
     promotion/pump-and-dump patterns, and dilution are the dominant risks,
     more than direction. See /api/penny, which runs the full reality check
     (RVOL, catalyst classification, halt bands) against these candidates
     before anything reaches the Ideas prompt.
   - extended: the "Moderna at 8am" scan — take the freshest market-wide
     headlines, price each mentioned symbol via Tradier extended-session
     timesales, and rank by |pre/post-market move|. This catches news-driven
     gaps BEFORE they appear on any regular-session gainers list.
   Shared by /api/movers (which caches this 5 min for the movers card) and
   /api/suggestions (which calls it uncached for a true fresh pull per click). */

const LEVERAGED = /\b(2x|3x|1\.5x|-1x|etf|etn|daily target|leverage|direxion|proshares|graniteshares|21shares|teucrium|ultra|bull|bear|acquisition corp|rights|warrants?|units?)\b/i;
const NEWS_SPAM = /(class action|lawsuit|law firm|deadline|investor(s)? (rights|counsel)|lead plaintiff|securities fraud|investigation|shareholder alert)/i;
const REAL_TICKER = /^[A-Z]{1,5}$/;
const PENNY_MIN = 0.10, PENNY_MAX = 5;

const filterMovers = (rows, priceOk) =>
  (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.symbol && REAL_TICKER.test(r.symbol) && priceOk(Number(r.price)) && !LEVERAGED.test(r.name || ""))
    .slice(0, 8)
    .map((r) => ({ symbol: r.symbol, name: r.name, price: Number(r.price), changePct: Number(r.changesPercentage) }));

const cleanMovers = (rows) => filterMovers(rows, (p) => p >= 5);
const cleanPennyMovers = (rows) => filterMovers(rows, (p) => p >= PENNY_MIN && p < PENNY_MAX);

export async function getMovers() {
  if (!process.env.FMP_API_KEY) {
    return { available: false, session: { gainers: [], losers: [] }, extended: [], penny: [] };
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

    const pennyGainers = cleanPennyMovers(gainRaw).map((m) => ({ ...m, headline: headlineBySym[m.symbol] || null }));
    const pennyLosers = cleanPennyMovers(loseRaw).map((m) => ({ ...m, headline: headlineBySym[m.symbol] || null }));
    const penny = [...pennyGainers, ...pennyLosers].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

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

    return { available: true, marketState: clockState, session: { gainers, losers }, extended, penny };
  } catch (e) {
    return { available: false, session: { gainers: [], losers: [] }, extended: [], penny: [], reason: String(e.message || e) };
  }
}
