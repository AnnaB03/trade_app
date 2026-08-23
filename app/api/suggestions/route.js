import { NextResponse } from "next/server";
import { Anthropic } from "@anthropic-ai/sdk";
import { tradier, asArray } from "../tradier";
import { fetchStockNews } from "../fmp";
import { extendedQuotes } from "../extended";
import { upcomingEarnings, macroEvents, todayET } from "../eventsLib";

const fmt = (v, dp = 2) => {
  if (v == null || v === "") return "N/A";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(dp) : "N/A";
};

export async function GET(req) {
  const symbols = new URL(req.url).searchParams.get("symbols");
  if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY — set it in your environment / Vercel project settings." },
      { status: 500 }
    );
  }
  const client = new Anthropic();

  try {
    const syms = symbols.split(",").map(s => s.trim()).filter(Boolean);

    // Fetch quotes for all symbols
    const quotes = await Promise.all(
      syms.map(sym =>
        tradier(`/markets/quotes?symbols=${encodeURIComponent(sym)}`)
          .then(d => ({ symbol: sym, data: asArray(d?.quotes?.quote)?.[0] || {} }))
          .catch(() => ({ symbol: sym, data: {} }))
      )
    );
    const lastBySym = Object.fromEntries(quotes.map(q => [q.symbol, Number(q.data.last)]));

    // Fetch expirations and option chains for every watched symbol.
    // Use the first expiration at least ~5 days out, NOT expirations[0]: the
    // nearest expiry on index products is a same-day (0DTE) contract — the
    // worst possible thing to put in front of a beginner as a suggestion.
    const minExp = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const chains = await Promise.all(
      syms.map(async (sym) => {
        try {
          const d = await tradier(`/markets/options/expirations?symbol=${encodeURIComponent(sym)}&includeAllRoots=true`);
          const exps = asArray(d?.expirations?.date);
          const exp = exps.find((x) => x >= minExp) || exps[0];
          if (!exp) return { symbol: sym, options: [] };
          const cd = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(sym)}&expiration=${encodeURIComponent(exp)}&greeks=true`);
          return { symbol: sym, expiration: exp, options: asArray(cd?.options?.option) };
        } catch {
          return { symbol: sym, options: [] };
        }
      })
    );

    // Fetch recent news headlines, if FMP_API_KEY is configured (degrades to [] otherwise)
    const { articles: newsArticles } = await fetchStockNews(syms, 2);

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

    // Outside regular hours, add today's macro releases and imminent earnings so
    // the plan accounts for scheduled events (e.g. don't buy blind ahead of CPI).
    let calendarData = "";
    if (!marketOpen && process.env.FMP_API_KEY) {
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

    // Build prompt for Claude
    const marketData = quotes
      .map(q => `${q.symbol}: Last=$${fmt(q.data.last)}, Change=${fmt(q.data.change)} (${fmt(q.data.change_percentage, 1)}%), Volume=${q.data.volume != null ? Number(q.data.volume).toLocaleString() : "N/A"}`)
      .join("\n");

    const optionData = chains
      .filter(c => c.options.length > 0)
      .map(c => {
        const spot = lastBySym[c.symbol];
        const ref = Number.isFinite(spot) ? spot : Number(c.options[Math.floor(c.options.length / 2)].strike);
        const atm = c.options.reduce((best, o) =>
          Math.abs(Number(o.strike) - ref) < Math.abs(Number(best.strike) - ref) ? o : best
        );
        return `${c.symbol} (expires ${c.expiration}): ATM strike ~${atm.strike}, IV=${fmt(atm.greeks?.mid_iv)}`;
      })
      .join("\n");

    const newsData = newsArticles
      .map(a => `${a.symbol}: "${a.title}" (${a.site}, ${a.publishedDate})`)
      .join("\n");

    const inExtended = clock.state === "premarket" || clock.state === "postmarket";
    const marketStatus = marketOpen
      ? "The market is OPEN — prices below are live."
      : inExtended
      ? `The regular session is closed but EXTENDED-HOURS trading is active (${clock.state}). MARKET DATA below shows the last regular-session close; the EXTENDED-HOURS PRICES section shows where each stock is trading RIGHT NOW — treat those as the current prices and base each idea on them, mentioning the extended-hours move when it is meaningful. Option chains do not trade in extended hours, so option quotes are stale until the open. Frame every idea as a PLAN for the next regular session open, and remind the trader once at the top, in one short sentence, that opening prices can differ.`
      : `The market is CLOSED (${clock.description || "weekend/holiday"}). Every price below is from the LAST SESSION'S CLOSE, not live. Frame every idea as a PLAN for the next market open: use wording like "plan to buy at the open" (never "buy now"), and remind the trader once at the top, in one short sentence, that prices can gap at the open so they must re-check before acting.`;

    const prompt = `You are a simple trading advisor. A beginner trader is using your app to learn. Analyze this market data and give SIMPLE trading ideas in VERY EASY words (like Robinhood uses).

MARKET STATUS: ${marketStatus}

MARKET DATA (see MARKET STATUS above for freshness):
${marketData}

OPTION CHAINS (if available):
${optionData}

RECENT NEWS (if available):
${newsData || "None available"}
${extendedData ? `
EXTENDED-HOURS PRICES (pre/post-market trades since the regular close — these show where the stock is heading BEFORE the next open; weigh them together with the news):
${extendedData}
` : ""}${calendarData ? `
SCHEDULED EVENTS (known in advance — factor the TIMING into every plan; e.g. warn against buying options right before a big report, and say when an idea depends on an event going a certain way):
${calendarData}
` : ""}

REQUIREMENTS:
1. Write in plain everyday words a beginner understands. No financial jargon — no "theta", "IV crush", "delta", "credit spread". If you must use a trading term, explain it in the same sentence.
2. Cover EVERY symbol listed in OPTION CHAINS above — never skip one, including index symbols like SPX. But do NOT manufacture a trade: if a symbol has no clear setup right now, say so for that symbol using the WAIT line format below. An honest "nothing here today" is more useful than a forced idea, and you will not be penalized for saying it.
3. This app is for OPTIONS trading — prefer a CALL or PUT idea over a plain stock BUY/SELL whenever that symbol has option chain data. For options, ALWAYS include the expiration date
4. Explain each idea in 1-2 simple sentences that a beginner understands
5. Rate risk as: LOW, MEDIUM, or HIGH. Be honest — buying short-dated options is HIGH risk even when the idea is good.
6. Include a simple emoji (📈 for bullish, 📉 for bearish, ⚡ for options, ⏸ for wait)
7. If recent news is relevant to an idea, mention it briefly in plain words (e.g. "because of good earnings news")
8. Never promise a result. Say what would have to happen for the trade to work, and say plainly what makes it lose.

Format each idea like:
[EMOJI] SYMBOL | BUY/SELL/CALL/PUT [expiration] | Risk: LOW/MEDIUM/HIGH
Why: Simple explanation in 1-2 sentences

For a symbol with no clear setup, use exactly:
⏸ SYMBOL | WAIT | Risk: —
Why: Simple reason there is no good setup right now.

Then add a section called "OTHER TOOLS" with 5 free/cheap tools that help traders like:
- Tool name | What it does | Free/Paid
`;

    // max_tokens must fit one idea per watched symbol plus the tools section —
    // at 1024 the response was silently truncated mid-idea once the watchlist
    // grew past a few symbols. Model is overridable for cost tuning; this
    // endpoint can auto-refresh every 60s while the Ideas tab is open.
    const message = await client.messages.create({
      model: process.env.SUGGESTIONS_MODEL || "claude-opus-5",
      max_tokens: 8000,
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: prompt }],
    });

    if (message.stop_reason === "refusal") {
      return NextResponse.json({ error: "The model declined to answer this request." }, { status: 502 });
    }

    const suggestions = message.content.find(b => b.type === "text")?.text || "";

    return NextResponse.json({ suggestions, market_state: clock.state, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error("Suggestions error:", e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
