// FMP stock news, shared by /api/news and /api/suggestions. Requires FMP Starter plan or higher.
// Fetches per symbol (not one combined call) — FMP's `limit` caps the whole combined
// response, so a noisy ticker (e.g. NVDA) would otherwise crowd out quieter ones.
export async function fetchStockNews(symbols, perSymbolLimit = 2) {
  const key = process.env.FMP_API_KEY;
  if (!key) return { available: false, reason: "FMP_API_KEY not set", articles: [] };

  const results = await Promise.all(
    symbols.map(async (sym) => {
      try {
        const url = `https://financialmodelingprep.com/stable/news/stock?symbols=${encodeURIComponent(sym)}&limit=${encodeURIComponent(perSymbolLimit)}&apikey=${key}`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) return [];
        const d = await r.json();
        return (Array.isArray(d) ? d : []).map(a => ({
          symbol: a.symbol,
          title: a.title,
          site: a.site,
          publishedDate: a.publishedDate,
          url: a.url,
        }));
      } catch {
        return [];
      }
    })
  );

  return { available: true, articles: results.flat() };
}
