import { NextResponse } from "next/server";
import { Anthropic } from "@anthropic-ai/sdk";
import { tradier, asArray } from "../tradier";
import { fetchStockNews } from "../fmp";
import { extendedQuotes } from "../extended";
import { upcomingEarnings, macroEvents, todayET } from "../eventsLib";
import { getMovers } from "../moversLib";
import { computeReality } from "../realityLib";
import { dailyBars } from "../historyCache";
import { marketRegime, regimeText } from "../regimeLib";
import { calendarEffects, calendarEffectsText } from "../calendarRulesLib";
import { classifyCatalyst, headlineAgeHours, ageRead, rvolTimeAdjusted } from "../../lib/checks";
import { toRows, expectedMove, ivSnapshot, oiWalls, realizedVol, ivHvRead, optMid } from "../../lib/metrics";
import { listIdeas, appendIdea } from "../store";
import { computeCalibration, calibrationText } from "../calibrationLib";
import { accountLimits, accountText, sizeIdea } from "../sizingLib";
import { affordableCandidates } from "../affordableLib";

// How many news-driven top movers (beyond the watchlist) to analyze per refresh.
// Capped to keep the Claude call and the option-chain fan-out bounded. Kept
// small on purpose — each one adds a full quote+expirations+chains fan-out
// (see EXP_TIERS below), and every extra symbol here was the direct cause of
// a slow Ideas refresh (each is a handful of Tradier round trips, and they
// all fire in parallel on top of whatever's on the watchlist).
const TRENDING_CAP = 2;
// Penny candidates ($0.10-$5) get their own small cap — each one costs an
// extra FMP profile/float/news round trip (computeReality), and a handful of
// well-checked candidates beats a long list of raw, unverified movers.
const PENNY_CAP = 2;
// Cheaper, liquid, optionable names added for a small account — the default
// watchlist is all $200+ underlyings whose contracts cost most of a ~$1k
// account. Bounded like TRENDING_CAP: each one is a full chain fan-out.
const AFFORDABLE_CAP = 2;

const fmt = (v, dp = 2) => {
  if (v == null || v === "") return "N/A";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(dp) : "N/A";
};

// Nearest listed contract of `type` to `strike` in a raw Tradier option list —
// used to turn the model's chosen strike into a real, quotable OCC symbol.
function nearestContract(options, type, strike) {
  const pool = options.filter((o) => o.option_type === type);
  if (!pool.length || strike == null) return null;
  return pool.reduce((best, o) =>
    Math.abs(Number(o.strike) - strike) < Math.abs(Number(best.strike) - strike) ? o : best
  );
}

export async function GET(req) {
  const params = new URL(req.url).searchParams;
  const symbols = params.get("symbols");
  if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
  // Account size: query param (the UI's setting) -> ACCOUNT_SIZE env -> $1,000.
  // Everything downstream — which names get scanned, which vehicle fits, how
  // many shares/contracts — is sized off this. See sizingLib.js.
  const account = Number(params.get("account")) > 0 ? Number(params.get("account")) : (Number(process.env.ACCOUNT_SIZE) > 0 ? Number(process.env.ACCOUNT_SIZE) : 1000);
  const limits = accountLimits(account);
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY — set it in your environment / Vercel project settings." },
      { status: 500 }
    );
  }
  const client = new Anthropic();

  try {
    const watchSyms = symbols.split(",").map(s => s.trim()).filter(Boolean);

    // Pull a fresh news-driven top-movers scan every refresh, so ideas aren't
    // limited to the watchlist — a big mover with real news behind it gets
    // analyzed even if it was never added to the watchlist.
    const moversData = await getMovers();
    const trending = [...moversData.session.gainers, ...moversData.session.losers, ...moversData.extended]
      .filter(m => !watchSyms.includes(m.symbol))
      .sort((a, b) => Math.abs(b.changePct ?? b.extChangePct ?? 0) - Math.abs(a.changePct ?? a.extChangePct ?? 0));
    const trendingSyms = [];
    for (const m of trending) {
      if (trendingSyms.includes(m.symbol)) continue;
      trendingSyms.push(m.symbol);
      if (trendingSyms.length >= TRENDING_CAP) break;
    }
    // Cheaper, liquid, optionable names that a small account can actually
    // size — merged into the normal pipeline (quotes, chains, structure) like
    // trending symbols, so they get the full treatment. The final "does this
    // contract fit" check happens on the real chain price below.
    let affordable = { band: null, candidates: [] };
    try {
      affordable = await affordableCandidates({ account, exclude: [...watchSyms, ...trendingSyms], cap: AFFORDABLE_CAP });
    } catch {}
    const affordableSyms = affordable.candidates.map((c) => c.symbol);
    let syms = [...watchSyms, ...trendingSyms, ...affordableSyms];

    // Penny-stock candidates ($0.10-$5) — analyzed as their OWN category,
    // never merged into `syms` above: most have no usable option chain, so
    // they're handled as a SHARES-only, separately-labeled prompt section
    // instead of forcing them through the option-chain pipeline below. Each
    // one is reality-checked (RVOL, catalyst incl. dilution, halt bands)
    // first — a raw "+80% today" means almost nothing in this category
    // without that context.
    const pennyChecked = (await Promise.all(
      (moversData.penny || []).slice(0, PENNY_CAP).map((m) =>
        computeReality(m.symbol).then((r) => (r.available ? r : null)).catch(() => null)
      )
    )).filter(Boolean);
    const pennyPriceBySym = Object.fromEntries(pennyChecked.map((r) => [r.symbol, r.price]));
    const pennyChangePctBySym = Object.fromEntries(pennyChecked.map((r) => [r.symbol, r.changePct]));

    // Fetch quotes for all symbols
    const quotesRaw = await Promise.all(
      syms.map(sym =>
        tradier(`/markets/quotes?symbols=${encodeURIComponent(sym)}`)
          .then(d => ({ symbol: sym, data: asArray(d?.quotes?.quote)?.[0] || {} }))
          .catch(() => ({ symbol: sym, data: {} }))
      )
    );

    // Drop anything without a real tradable quote — mutual funds (e.g. FIFGX)
    // sometimes leak into FMP's movers lists but have no intraday price or
    // options on Tradier, so there is nothing actionable to say about them.
    const TRADABLE_TYPES = new Set(["stock", "etf", "index"]);
    const quotes = quotesRaw.filter(q => TRADABLE_TYPES.has(q.data.type) && Number.isFinite(Number(q.data.last)));
    syms = quotes.map(q => q.symbol);
    const lastBySym = Object.fromEntries(quotes.map(q => [q.symbol, Number(q.data.last)]));
    const quoteBySym = Object.fromEntries(quotes.map(q => [q.symbol, q.data]));

    // Fetch a MENU of expirations per symbol — same-day (0DTE, if it exists
    // for that symbol), near (~1wk), and mid (~3wk) — instead of forcing one
    // fixed distance every time. The model picks whichever tier actually
    // fits the idea; the prompt requires a real same-day catalyst
    // (earnings/macro/news today) before it may use the 0DTE one. Used to
    // include a ~6-7wk "far" tier too — dropped it: it's a full extra chain
    // fetch per symbol and this app trades short-dated setups almost
    // exclusively, so it was paying for a tier nothing used.
    const EXP_TIERS = [5, 21];
    const todayStr = todayET();
    const chains = await Promise.all(
      syms.map(async (sym) => {
        try {
          const d = await tradier(`/markets/options/expirations?symbol=${encodeURIComponent(sym)}&includeAllRoots=true`);
          const exps = asArray(d?.expirations?.date);
          const picked = [];
          const seen = new Set();
          if (exps.includes(todayStr)) { seen.add(todayStr); picked.push(todayStr); }
          for (const minDays of EXP_TIERS) {
            const minExp = new Date(Date.now() + minDays * 86400000).toISOString().slice(0, 10);
            const exp = exps.find((x) => x >= minExp) || exps[exps.length - 1];
            if (exp && !seen.has(exp)) { seen.add(exp); picked.push(exp); }
          }
          if (!picked.length) return { symbol: sym, expirations: [] };
          const expirations = await Promise.all(
            picked.map(async (exp) => {
              const cd = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(sym)}&expiration=${encodeURIComponent(exp)}&greeks=true`);
              return { expiration: exp, options: asArray(cd?.options?.option) };
            })
          );
          return { symbol: sym, expirations };
        } catch {
          return { symbol: sym, expirations: [] };
        }
      })
    );
    const chainsBySym = Object.fromEntries(chains.map((c) => [c.symbol, c]));

    // Fetch recent news headlines, if FMP_API_KEY is configured (degrades to [] otherwise)
    const { articles: newsArticles } = await fetchStockNews(syms, 2);
    const firstHeadlineBySym = {};
    for (const a of newsArticles) if (!firstHeadlineBySym[a.symbol]) firstHeadlineBySym[a.symbol] = a;

    // Market clock — when closed, quotes are the last session's close and ideas
    // must be framed as plans for the next open. "unknown" (clock fetch failed)
    // is treated as open rather than blocking suggestions.
    let clock = { state: "unknown", description: "" };
    try {
      const c = await tradier(`/markets/clock`);
      clock = { state: c?.clock?.state || "unknown", description: c?.clock?.description || "" };
    } catch {}
    const marketOpen = clock.state === "open" || clock.state === "unknown";

    // Outside regular hours, pull the last pre/post-market trades so overnight
    // moves are part of the analysis instead of invisible until the open.
    let extendedData = "";
    if (!marketOpen) {
      try {
        const ext = await extendedQuotes(syms);
        extendedData = ext
          .filter((e) => e.ext != null && e.extChangePct != null)
          .map((e) => `${e.symbol}: last extended-hours trade $${Number(e.ext).toFixed(2)} (${e.extChangePct >= 0 ? "+" : ""}${e.extChangePct.toFixed(2)}% vs regular close${e.asOf ? `, as of ${e.asOf}` : ""})`)
          .join("\n");
      } catch {}
    }

    // Always add today's macro releases and imminent earnings, market open or
    // not — this is what can justify a same-day (0DTE) idea while the market
    // is open, and what the "plan for the next open" framing leans on when closed.
    let calendarData = "";
    if (process.env.FMP_API_KEY) {
      try {
        const today = todayET();
        const [macroAll, ...earnLists] = await Promise.all([
          macroEvents(),
          ...syms.slice(0, 10).map((s) => upcomingEarnings(s.toUpperCase()).catch(() => [])),
        ]);
        calendarData = [
          ...macroAll.filter((m) => m.date === today).map((m) => `${m.label} today${m.timeET ? ` at ${m.timeET} ET` : ""}`),
          ...earnLists.flat().filter((e) => e.date >= today).slice(0, 6).map((e) => `${e.label} on ${e.date}`),
        ].join("\n");
      } catch {}
    }
    // Recurring calendar-driven flow that has nothing to do with any one
    // symbol's news: OPEX/quad-witching pinning, month-end flows, etc.
    const calEffects = calendarEffects(todayStr);
    const calEffectsTxt = calendarEffectsText(calEffects);
    if (calEffectsTxt) calendarData = [calendarData, calEffectsTxt].filter(Boolean).join("\n");

    // Market-wide regime — trend/VIX/rotation. Computed once per refresh,
    // not per symbol; every idea is judged against the same tape.
    const regime = await marketRegime();
    const regimeTxt = regimeText(regime);

    // Track record so far, fed back into the prompt so the model can see
    // where its own past calls have actually worked. Needs no extra fetch —
    // reads the local idea ledger (see app/api/store.js).
    const calibration = computeCalibration(listIdeas().filter((i) => !i.strategy)); // the model's own record, not the sweep detector's
    const calibTxt = calibrationText(calibration);

    // Per-symbol intraday structure: gap vs prior close, prior day's range,
    // time-of-day-adjusted RVOL, and realized vol (for IV/HV). One daily-bars
    // fetch per symbol, 60s-cached and shared with the regime read above.
    const structureBySym = {};
    await Promise.all(syms.map(async (sym) => {
      const q = quoteBySym[sym] || {};
      const bars = await dailyBars(sym, 40);
      const priorBars = bars.filter((b) => b.date < todayStr);
      const priorBar = priorBars[priorBars.length - 1];
      const prevClose = Number(q.prevclose) || (priorBar ? Number(priorBar.close) : null);
      const todayOpen = Number(q.open) || null;
      const gapPct = prevClose > 0 && todayOpen > 0 ? ((todayOpen - prevClose) / prevClose) * 100 : null;
      const rvolAdj = rvolTimeAdjusted(q.volume, q.average_volume, { sessionOpen: clock.state === "open" });
      const closes = bars.map((b) => Number(b.close)).filter((v) => v > 0);
      const hv20 = realizedVol(closes, 20);
      // TODAY's own high/low, distinct from the prior-day range above — this
      // is what tells a fading intraday breakout apart from a genuine one.
      // Without it, a stock that peaked at 10am and has been sliding since
      // still reads as pure strength (green vs yesterday, RVOL elevated)
      // right up until it turns negative on the day — the fade itself was
      // invisible to the model.
      // Symmetric: a bounce off today's LOW undermines a fresh PUT/bearish
      // continuation idea exactly the way a fade off today's HIGH undermines
      // a fresh CALL — a name that dropped, then already recovered most of
      // it, is not "still weak" just because it's still red for the day.
      const todayHigh = Number(q.high) || null;
      const todayLow = Number(q.low) || null;
      const last = Number(q.last) || null;
      const offHighPct = todayHigh > 0 && last != null ? ((last - todayHigh) / todayHigh) * 100 : null;
      const offLowPct = todayLow > 0 && last != null ? ((last - todayLow) / todayLow) * 100 : null;
      structureBySym[sym] = { prevClose, todayOpen, gapPct, priorHigh: priorBar ? Number(priorBar.high) : null, priorLow: priorBar ? Number(priorBar.low) : null, rvolAdj, hv20, todayHigh, todayLow, offHighPct, offLowPct };
    }));

    // Build prompt for Claude
    const marketData = quotes
      .map(q => {
        const s = structureBySym[q.symbol] || {};
        const bits = [`${q.symbol}: Last=$${fmt(q.data.last)}, Change=${fmt(q.data.change)} (${fmt(q.data.change_percentage, 1)}%), Volume=${q.data.volume != null ? Number(q.data.volume).toLocaleString() : "N/A"}`];
        if (s.gapPct != null) bits.push(`gap ${s.gapPct >= 0 ? "+" : ""}${s.gapPct.toFixed(1)}% vs prior close`);
        if (s.priorHigh != null && s.priorLow != null) bits.push(`prior day range $${s.priorLow.toFixed(2)}-$${s.priorHigh.toFixed(2)}`);
        if (s.todayHigh != null && s.todayLow != null) {
          const tags = [];
          if (s.offHighPct != null && s.offHighPct <= -0.15) tags.push(`${Math.abs(s.offHighPct).toFixed(1)}% OFF TODAY'S HIGH — fading, weakens a fresh CALL`);
          if (s.offLowPct != null && s.offLowPct >= 0.15) tags.push(`${s.offLowPct.toFixed(1)}% ABOVE TODAY'S LOW — already bounced, weakens a fresh PUT`);
          bits.push(`today's range $${s.todayLow.toFixed(2)}-$${s.todayHigh.toFixed(2)}${tags.length ? ", " + tags.join(" · ") : ", sitting at an extreme of today's range"}`);
        }
        if (s.rvolAdj != null) bits.push(`RVOL(time-adj) ${s.rvolAdj.toFixed(2)}x`);
        // A missing average-volume baseline (thin/obscure names) used to mean
        // this line just went silent — no RVOL, no flag, nothing. Silence
        // reads as "nothing to report," not "we can't verify this," and let
        // stale-news, thin-float names slide through on "holding near highs"
        // alone. Say it explicitly instead.
        else bits.push(`RVOL UNAVAILABLE (no average-volume baseline) — cannot confirm today's volume is real participation vs. a thin, easily-moved float`);
        // A symbol with no listed options used to just fall out of OPTION
        // CHAINS below with no trace — since coverage was scoped to that
        // section, it silently vanished from the response instead of getting
        // an explicit WAIT (this is common for names under a pending
        // merger, where exchanges pull the options while the stock keeps
        // trading). Flag it right on this line, which every symbol has, so
        // it can't be skipped.
        const hasChain = chainsBySym[q.symbol]?.expirations?.some((e) => e.options.length > 0);
        if (!hasChain) bits.push("NO OPTIONS LISTED — SHARES only for this symbol, never OPTION");
        return bits.join(" · ");
      })
      .join("\n");

    const optionData = chains
      .filter(c => c.expirations.some(e => e.options.length > 0))
      .map(c => {
        const spot = lastBySym[c.symbol];
        const hv20 = structureBySym[c.symbol]?.hv20;
        const lines = c.expirations
          .filter(e => e.options.length > 0)
          .map(({ expiration, options }) => {
            const rows = toRows(options);
            const em = expectedMove(rows, spot);
            const ivSnap = ivSnapshot(rows, spot);
            const walls = oiWalls(rows);
            const ivhv = ivSnap != null && hv20 ? ivHvRead(ivSnap, hv20) : null;
            const ref = Number.isFinite(spot) ? spot : Number(options[Math.floor(options.length / 2)].strike);
            const atmStrike = em?.atmStrike ?? options.reduce((best, o) =>
              Math.abs(Number(o.strike) - ref) < Math.abs(Number(best.strike) - ref) ? o : best
            ).strike;
            const days = Math.round((new Date(expiration) - Date.now()) / 86400000);
            const tag = expiration === todayStr ? "TODAY/0DTE" : `~${days}d out`;
            const bits = [`  expires ${expiration} (${tag}): ATM strike ${atmStrike}`];
            // Dollar cost of one ATM contract, against the account's caps —
            // the single number that decides whether OPTION is even on the
            // table for this account. Uses the call mid; the put is close.
            const atmRow = rows.find((r) => r.strike === atmStrike);
            const atmMid = atmRow ? (optMid(atmRow.call) ?? optMid(atmRow.put)) : null;
            if (atmMid != null) {
              const cost = atmMid * 100;
              const fit = cost <= limits.optionPreferred ? "FITS the account comfortably"
                : cost <= limits.optionHardCap ? `fits, but ${(cost / limits.account * 100).toFixed(0)}% of the account — big`
                : `TOO EXPENSIVE for this account (${(cost / limits.account * 100).toFixed(0)}% of it) — SHARES or WAIT, not an option`;
              bits.push(`ATM contract ≈ $${cost.toFixed(0)} → ${fit}`);
            }
            if (ivSnap != null) bits.push(`IV ${(ivSnap * 100).toFixed(0)}%`);
            if (em) bits.push(`implied move ±${(em.emPct * 100).toFixed(1)}% (±$${em.em.toFixed(2)})`);
            if (ivhv) bits.push(`IV/HV20 ${ivhv.ratio.toFixed(2)} (${ivhv.tone === "sell" ? "rich" : ivhv.tone === "buy" ? "cheap" : "fair"})`);
            if (walls?.callWall || walls?.putWall) {
              const w = [];
              if (walls.callWall) w.push(`call wall ${walls.callWall.strike}`);
              if (walls.putWall) w.push(`put wall ${walls.putWall.strike}`);
              bits.push(w.join("/"));
            }
            return bits.join(", ");
          });
        return `${c.symbol}:\n${lines.join("\n")}`;
      })
      .join("\n");

    const newsData = newsArticles
      .map(a => {
        const cat = classifyCatalyst(a.title);
        const age = headlineAgeHours(a.publishedDate);
        return `${a.symbol}: "${a.title}" (${a.site}, ${ageRead(age)}) [catalyst: ${cat?.kind || "unknown"}, weight: ${cat?.weight || "unknown"}]`;
      })
      .join("\n");

    const trendingBySym = Object.fromEntries(trending.map(m => [m.symbol, m]));
    const trendingData = trendingSyms
      .map(s => {
        const m = trendingBySym[s];
        const pct = m.changePct ?? m.extChangePct;
        const headline = m.headline?.title ? ` — "${m.headline.title}"` : "";
        return `${s}: ${pct >= 0 ? "+" : ""}${Number(pct).toFixed(1)}% today${headline}`;
      })
      .join("\n");

    const pennyData = pennyChecked
      .map((r) => {
        const bits = [`${r.symbol}: $${fmt(r.price)} (${r.changePct >= 0 ? "+" : ""}${fmt(r.changePct, 1)}% today)`, r.volume.read.text, r.news.verdict.text];
        if (r.halt) bits.push(`halt bands ~$${r.halt.down.toFixed(2)} / $${r.halt.up.toFixed(2)} (±${(r.halt.pct * 100).toFixed(0)}%)`);
        return bits.join(" · ");
      })
      .join("\n");

    const inExtended = clock.state === "premarket" || clock.state === "postmarket";
    const marketStatus = marketOpen
      ? "The market is OPEN — prices below are live."
      : inExtended
      ? `The regular session is closed but EXTENDED-HOURS trading is active (${clock.state}). MARKET DATA below shows the last regular-session close; the EXTENDED-HOURS PRICES section shows where each stock is trading RIGHT NOW — treat those as the current prices and base each idea on them, mentioning the extended-hours move when it is meaningful. Option chains do not trade in extended hours, so option quotes are stale until the open. Frame every idea as a PLAN for the next regular session open, and remind the trader once at the top, in one short sentence, that opening prices can differ.`
      : `The market is CLOSED (${clock.description || "weekend/holiday"}). Every price below is from the LAST SESSION'S CLOSE, not live. Frame every idea as a PLAN for the next market open: use wording like "plan to buy at the open" (never "buy now"), and remind the trader once at the top, in one short sentence, that prices can gap at the open so they must re-check before acting.`;

    const prompt = `You are a professional day trader with decades of screen time, deciding for your own book. A beginner is watching over your shoulder through this app, but your REASONING must be full professional quality — do not dumb down the analysis, only the way one field of the output is phrased.

${accountText(account)}
${affordableSyms.length ? `SMALL-ACCOUNT CANDIDATES: ${affordableSyms.join(", ")} — liquid, cheaper names (share price $${affordable.band.minPrice}-$${affordable.band.maxPrice.toFixed(0)}) added specifically because their contracts can fit this account. Give them the same honest treatment as any other symbol — WAIT is fine — but when two setups are comparable, prefer the one this account can actually size.` : ""}

MARKET REGIME (judge every idea against this — do not fight the tape without a specific reason called out in why_pro):
${regimeTxt}

YOUR OWN TRACK RECORD (use this to calibrate confidence — if a catalyst type or symbol has been a loser for you, say so and size conviction down; if data is thin, say so honestly):
${calibTxt}

MARKET STATUS: ${marketStatus}

MARKET DATA (see MARKET STATUS above for freshness):
${marketData}
${trendingData ? `
TRENDING TODAY (not on the watchlist — added because they're moving on real news right now; give these a genuine idea too, same as any watchlist symbol):
${trendingData}
` : ""}
OPTION CHAINS (if available — each symbol lists a MENU of expirations, near/mid/far, with IV, implied move, IV vs realized-vol, and OI walls where computable):
${optionData}
${pennyData ? `
PENNY STOCK CANDIDATES (priced $0.10-$5 — a DIFFERENT risk category, not just "cheaper stocks." Each line already includes a volume-reality read and a news-justification read; treat those as load-bearing, not decoration):
${pennyData}
` : ""}

RECENT NEWS, pre-classified by catalyst type and weight (if available):
${newsData || "None available"}
${extendedData ? `
EXTENDED-HOURS PRICES (pre/post-market trades since the regular close — these show where the stock is heading BEFORE the next open; weigh them together with the news):
${extendedData}
` : ""}${calendarData ? `
SCHEDULED / CALENDAR EVENTS (known in advance — factor the TIMING into every plan; e.g. warn against buying options right before a big report, and say when an idea depends on an event going a certain way):
${calendarData}
` : ""}

REQUIREMENTS:
1. Decide like a professional. Use the regime, the track record, IV vs realized vol, RVOL, gap, prior-day range, today's own high/low, OI walls, and catalyst weight — whichever are relevant — in your actual reasoning (why_pro). Then separately write why_plain in everyday words a beginner understands, no jargon (or explain any term you must use in the same sentence). why_pro can and should use real terms (theta, IV crush, delta, RVOL, gamma, etc.); why_plain may not.
1b. This cuts both ways — check whichever applies to the idea you're building. A symbol trading meaningfully OFF its own high for the day is showing FADING intraday momentum, not confirmed strength, even while still green versus yesterday's close with elevated RVOL: a fresh CALL/BUY needs a specific reason the fade is over (e.g. it just reclaimed a level), or should be WAIT/lower conviction. Symmetrically, a symbol trading meaningfully ABOVE its own low for the day has already BOUNCED, not confirmed weakness, even while still red versus yesterday's close: a fresh PUT/SELL betting on continued downside needs a specific reason the bounce fails (e.g. it's rolling back over from a lower high), or should be WAIT/lower conviction. Chasing a move that already happened and is reversing — in either direction — is the "buying strength (or selling weakness) after the easy part is done" trap.
2. Cover EVERY symbol listed under MARKET DATA above — never skip one, including index symbols like SPX and any symbol tagged "NO OPTIONS LISTED." Most will also appear under OPTION CHAINS; for the ones that don't (the tag says so right on their MARKET DATA line), vehicle must be "SHARES" or null — there is no chain to resolve an OPTION against, so do not propose one. But do NOT manufacture a trade: if a symbol has no clear directional setup right now, use action "WAIT" for it (vehicle null). An honest "nothing here today" is more useful than a forced idea, and you will not be penalized for saying it.
3. For an actionable idea, set "vehicle" to "OPTION" or "SHARES" based on which fits the SETUP — not the account size. Affordability is no longer a gate on whether you may give an options idea: the app itself flags and separately sorts any option whose contract costs more than this account's comfort cap, so a real, well-reasoned options idea on an expensive name should still be given in full, not suppressed or silently swapped for shares. Every expiration line above still shows "ATM contract ≈ $X → fits / too expensive" — use that as CONTEXT for conviction and for one honest line in why_pro when it's a big chunk of the account, not as a reason to withhold the idea. Choose OPTION when the setup is sharp and news/event-driven and IV is not already rich vs realized vol (IV/HV20 well under ~1.25). Prefer SHARES when: IV/HV20 is rich (options are expensive relative to how much the stock actually moves), the setup is a slower multi-day swing, or you'd want a debit/credit spread but this app cannot place multi-leg orders yet — say so in why_pro. Never propose more than ONE contract.
4. For OPTION ideas, "strike" MUST be exactly one of the ATM strikes listed for that symbol/expiration above, and "expiration" MUST be exactly one of the exact dates listed for that symbol. Pick the tier deliberately: a sharp, fast-resolving move fits near (~1wk); a slower setup fits mid (~3wk) or far (~6-7wk).
4b. A symbol may list an expiration tagged "TODAY/0DTE". Only use it when a real same-day catalyst is present in the data above — earnings released today, a major macro event today (CPI, FOMC, jobs report, etc.), or a big news-driven move already happening right now — that could still move the stock meaningfully before today's close. Never use it just because it's listed. If you use it, why_pro must name the specific same-day trigger, and risk MUST be HIGH.
5. Every actionable idea (not WAIT) needs a real plan, all in terms of the UNDERLYING stock's price (not the option's price):
   - entryTrigger: the specific price action that should happen before entering (e.g. "5-min close above $183.20 pre-market high" or "hold above VWAP after CPI").
   - triggerPrice + triggerDirection: the SAME condition as entryTrigger, but as a bare number and "above"/"below" — e.g. entryTrigger "5-min close above $212.80" pairs with triggerPrice 212.80, triggerDirection "above". This lets the app tell you plainly whether that level has already been crossed or not — required whenever entryTrigger names a specific price level (which it almost always should); null only if the trigger is genuinely not price-based (e.g. purely event-timing, like "after the CPI print regardless of level").
   - invalidation: the underlying price where the idea is simply wrong. Required.
   - target: the underlying price where you'd take profit. Required. The distance to target should be at least ~1.5-2x the distance to invalidation — do not propose a trade with worse than roughly 1.5:1 reward-to-risk.
   - staleMinutes: how many minutes from now this idea is worth acting on before it goes stale (a fast intraday trigger might be 30-90; a multi-day swing setup might be 1440+).
   - conviction: 1-5, honestly. Most days most ideas should be 2-3. Reserve 4-5 for a real confluence of catalyst + regime + flow agreeing.
   - catalyst: one short label (e.g. "earnings/guidance", "macro release", "technical breakout", "M&A", "clinical/FDA", "analyst action", "none").
6. Rate risk as LOW, MEDIUM, or HIGH — use null only for WAIT. Be honest — buying short-dated options is HIGH risk even when the idea is good.
7. Do NOT add a generic disclaimer like "it loses if the price drops or stays flat" — that's true of every option trade and isn't backed by anything. Only mention a risk if it's grounded in data given to you above. If there's no such data-backed risk for that symbol, leave the risk mention out of why_plain entirely — never invent one just to sound cautious.
8. Also cover EVERY symbol listed under PENNY STOCK CANDIDATES, as a separate category from the option-chain symbols above. For these: vehicle is ALWAYS "SHARES" or null (never "OPTION" — these do not have a usable options chain; ignore rule 3's OPTION/SHARES choice for this category). Require BOTH a real volume signal (RVOL meaningfully above 1x) AND a real, freshly-dated news catalyst before proposing anything beyond WAIT — an unexplained move on no catalyst, or a move on stale/weak news, is the single most common trap in this category and should be WAIT, said plainly in why_pro. If the news-justification read names dilution (a public offering, registered direct, ATM program, or similar), that is bearish pressure on the rally, not a reason to buy — use WAIT or a bearish idea, never a bullish one, and say why in why_plain. Conviction should rarely exceed 3 for this category even on a good setup — thin float and promotion risk cap how sure anyone can be. Size and stop matter more than usual here: invalidation should be tight (these can round-trip a large move fast), and say so.
8b. This is NOT only a penny-stock rule — it applies at ANY price. If a symbol's data says "RVOL UNAVAILABLE" (no average-volume baseline to confirm real participation) OR if your own read of the news classifies the catalyst as stale (already priced in days ago, "days to weeks old", a rehash of old coverage) — that combination is WAIT, full stop, no matter how cleanly the stock is "holding near its high." A thin, illiquid name grinding higher on old news is a stale rally that can round-trip in minutes once the last buyer is out, regardless of whether it costs $2 or $20 a share. Do not let "it's still near its high" override a volume or news-freshness problem you've already identified in your own reasoning — if your why_pro names either red flag, the action must be WAIT, not a smaller/hedged version of the same trade.

Respond with ONLY a raw JSON array, no markdown code fences, no prose before or after it, and no other commentary — one object per symbol listed under MARKET DATA or PENNY STOCK CANDIDATES above, shaped exactly like:
[{"symbol":"AAPL","emoji":"📈","action":"CALL","vehicle":"OPTION","expiration":"2026-09-20","strike":230,"entryTrigger":"...","triggerPrice":232.50,"triggerDirection":"above","invalidation":225.5,"target":238,"staleMinutes":90,"conviction":3,"catalyst":"technical breakout","risk":"MEDIUM","why_pro":"1-2 sentences, real terms ok","why_plain":"1-2 simple sentences"}]

action is one of BUY, SELL, CALL, PUT, WAIT (BUY/SELL pair with vehicle SHARES; CALL/PUT pair with vehicle OPTION). vehicle is OPTION, SHARES, or null for WAIT. strike/expiration are null unless vehicle is OPTION. emoji is a single emoji (📈 bullish, 📉 bearish, ⚡ options, ⏸ wait).`;

    // max_tokens must fit one idea per watched symbol — at 1024 the response was
    // silently truncated mid-idea once the watchlist grew past a few symbols.
    // Model is overridable for cost tuning.
    //
    // effort was "medium" and was the actual cause of the slow Ideas refresh —
    // profiling showed data fetching (quotes/chains/news/regime) takes under
    // 2s total; the model call alone was 60-65s. Dropping to "low" saved
    // ~10-15% with no visible quality loss on this task (a bounded per-symbol
    // JSON extraction, not open-ended reasoning). Switching model to Sonnet
    // at the same effort level gave no further speedup, so wall time here
    // scales with output volume (one JSON object + 2 sentences per symbol
    // analyzed), not model choice — the remaining lever is how many symbols
    // get analyzed per refresh (watchlist length + TRENDING/AFFORDABLE/PENNY
    // caps above), not this setting.
    const message = await client.messages.create({
      model: process.env.SUGGESTIONS_MODEL || "claude-opus-5",
      max_tokens: 8000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    });

    if (message.stop_reason === "refusal") {
      return NextResponse.json({ error: "The model declined to answer this request." }, { status: 502 });
    }

    const raw = message.content.find(b => b.type === "text")?.text || "";
    const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    let ideas;
    try {
      ideas = JSON.parse(jsonText);
      if (!Array.isArray(ideas)) throw new Error("not an array");
    } catch {
      return NextResponse.json({ error: "The model returned an unparseable response. Try Refresh again." }, { status: 502 });
    }

    // Spot price at generation time, for every idea — options resolve their
    // own live contract mid below, but SHARES ideas have no other price on
    // the response, and the UI needs one to prefill a limit order.
    for (const idea of ideas) {
      idea.entryPrice = lastBySym[idea.symbol] ?? pennyPriceBySym[idea.symbol] ?? null;
      // Today's % move, computed server-side from the actual quote — not
      // something the model reports about itself, so it can't be missed or
      // downplayed. This is what flags a MEDS-style outlier (a genuinely
      // extreme move, not just a routine daily swing) into its own section.
      const rawChangePct = quoteBySym[idea.symbol]?.change_percentage;
      idea.todayChangePct = rawChangePct != null ? Number(rawChangePct) : (pennyChangePctBySym[idea.symbol] ?? null);
      // Has the stated entry condition already happened, as of THIS price —
      // or is this still a watch-for-it plan? Without this a repeated
      // conditional idea ("buy IF it reclaims $213") reads exactly like a
      // repeated buy signal, even on a refresh where the condition never
      // actually fired.
      idea.triggered = (idea.triggerPrice != null && idea.triggerDirection && idea.entryPrice != null)
        ? (idea.triggerDirection === "above" ? idea.entryPrice >= idea.triggerPrice : idea.entryPrice <= idea.triggerPrice)
        : null;
    }

    // Resolve each OPTION idea's chosen strike/expiration to a real, quotable
    // contract (OCC symbol + live bid/ask) from the chain already fetched —
    // this is what a "Stage this idea" button in the UI submits directly.
    for (const idea of ideas) {
      if (idea.vehicle === "OPTION" && (idea.action === "CALL" || idea.action === "PUT")) {
        const symChain = chainsBySym[idea.symbol];
        const expBlock = symChain?.expirations.find((e) => e.expiration === idea.expiration);
        const type = idea.action === "CALL" ? "call" : "put";
        const contract = expBlock ? nearestContract(expBlock.options, type, Number(idea.strike)) : null;
        if (contract) {
          const bid = Number(contract.bid), ask = Number(contract.ask);
          const mid = bid >= 0 && ask > 0 ? (bid + ask) / 2 : (Number(contract.last) || null);
          const delta = contract.greeks?.delta != null ? Number(contract.greeks.delta) : null;
          idea.leg = { occ: contract.symbol, strike: Number(contract.strike), bid, ask, mid, delta };
        }
      }
    }

    // Size every idea for THIS account, deterministically, server-side: the
    // model proposes direction/levels, the math decides how many shares (off
    // the stop and the risk budget) or whether one contract even fits. The
    // prompt already forbids unaffordable options; this is the safety net
    // that flags one if it slips through, so the UI can say so and offer
    // the shares alternative instead of a Stage button.
    for (const idea of ideas) {
      const { sizing, affordable: fits } = sizeIdea(idea, account);
      idea.sizing = sizing;
      idea.affordable = fits;
    }

    const RISK_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    ideas.sort((a, b) => (RISK_ORDER[a.risk] ?? 3) - (RISK_ORDER[b.risk] ?? 3));

    // Persist every idea to the ledger (best-effort — see app/api/store.js
    // for the read-only-filesystem caveat) so it can be graded later and
    // folded into the calibration block above on future refreshes.
    for (const idea of ideas) {
      const row = appendIdea({
        symbol: idea.symbol, action: idea.action, vehicle: idea.vehicle ?? null,
        strike: idea.strike ?? null, expiration: idea.expiration ?? null,
        entryTrigger: idea.entryTrigger ?? null, triggerPrice: idea.triggerPrice ?? null, triggerDirection: idea.triggerDirection ?? null, triggered: idea.triggered ?? null,
        invalidation: idea.invalidation ?? null,
        target: idea.target ?? null, staleMinutes: idea.staleMinutes ?? null,
        conviction: idea.conviction ?? null, catalyst: idea.catalyst ?? null,
        risk: idea.risk ?? null, why_pro: idea.why_pro ?? null, why_plain: idea.why_plain ?? idea.why ?? null,
        leg: idea.leg ?? null,
        sizing: idea.sizing ?? null, affordable: idea.affordable ?? null, accountSize: account,
        todayChangePct: idea.todayChangePct ?? null,
        entryPrice: lastBySym[idea.symbol] ?? pennyPriceBySym[idea.symbol] ?? null,
        regimeTrend: regime?.available ? regime.spy.trend : null,
        marketState: clock.state,
      });
      // Client-visible so a "Send to Tradier" click can link the resulting
      // journal entry straight back to this idea's full context — see
      // app/api/journalLib.js.
      idea.id = row.id;
    }

    return NextResponse.json({ ideas, market_state: clock.state, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error("Suggestions error:", e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
