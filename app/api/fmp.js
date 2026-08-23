// Generic FMP GET against the /stable API. Returns parsed JSON, or null when the
// key is missing or the call fails — callers degrade gracefully rather than 502.
export async function fmpGet(path, params = {}) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  const qs = new URLSearchParams({ ...params, apikey: key }).toString();
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/${path}?${qs}`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

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
