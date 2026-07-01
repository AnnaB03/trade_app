import { NextResponse } from "next/server";
import { Anthropic } from "@anthropic-ai/sdk";
import { tradier, asArray } from "../tradier";

const client = new Anthropic();

export async function GET(req) {
  const symbols = new URL(req.url).searchParams.get("symbols");
  if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });

  try {
    const syms = symbols.split(",").map(s => s.trim());

    // Fetch quotes for all symbols
    const quotes = await Promise.all(
      syms.map(sym =>
        tradier(`/markets/quotes?symbols=${encodeURIComponent(sym)}`)
          .then(d => ({ symbol: sym, data: asArray(d?.quotes?.quote)?.[0] || {} }))
          .catch(() => ({ symbol: sym, data: {} }))
      )
    );

    // Fetch expirations and option chains for first 3 symbols (to avoid too much data)
    const chains = await Promise.all(
      syms.slice(0, 3).map(sym =>
        tradier(`/markets/options/expirations?symbol=${encodeURIComponent(sym)}&includeAllRoots=true`)
          .then(d => {
            const exp = asArray(d?.expirations?.date)?.[0];
            if (!exp) return { symbol: sym, expirations: [] };
            return tradier(`/markets/options/chains?symbol=${encodeURIComponent(sym)}&expiration=${encodeURIComponent(exp)}&greeks=true`)
              .then(cd => ({
                symbol: sym,
                expiration: exp,
                options: asArray(cd?.options?.option)?.slice(0, 10) || []
              }))
              .catch(() => ({ symbol: sym, expirations: [] }));
          })
          .catch(() => ({ symbol: sym, expirations: [] }))
      )
    );

    // Build prompt for Claude
    const marketData = quotes
      .map(q => `${q.symbol}: Last=$${q.data.last?.toFixed(2) || "N/A"}, Change=${q.data.change?.toFixed(2) || "N/A"} (${q.data.change_percentage?.toFixed(1) || "N/A"}%), Volume=${q.data.volume?.toLocaleString() || "N/A"}`)
      .join("\n");

    const optionData = chains
      .filter(c => c.options?.length > 0)
      .map(c => {
        const atm = c.options.find(o => Math.abs(o.strike - c.options[Math.floor(c.options.length/2)].strike) < 5);
        return `${c.symbol} (expires ${c.expiration}): ATM strike ~${atm?.strike || "N/A"}, IV=${atm?.greeks?.mid_iv?.toFixed(2) || "N/A"}`;
      })
      .join("\n");

    const prompt = `You are a simple trading advisor. A beginner trader is using your app to learn. Analyze this market data and give 3-5 SIMPLE trading ideas in VERY EASY words (like Robinhood uses).

LIVE MARKET DATA:
${marketData}

OPTION CHAINS (if available):
${optionData}

REQUIREMENTS:
1. Use ONLY these simple words: BUY, SELL, CALL, PUT, expiration date, cheap, expensive, risky, safe, up, down
2. Give ideas for BOTH stocks AND options
3. For options, ALWAYS include the expiration date
4. Explain each idea in 1-2 simple sentences that a beginner understands
5. Rate risk as: LOW, MEDIUM, or HIGH
6. Include a simple emoji (📈 for bullish, 📉 for bearish, ⚡ for options)
7. NO financial jargon

Format each idea like:
[EMOJI] SYMBOL | BUY/SELL/CALL/PUT [expiration] | Risk: LOW/MEDIUM/HIGH
Why: Simple explanation in 1-2 sentences

Then add a section called "OTHER TOOLS" with 5 free/cheap tools that help traders like:
- Tool name | What it does | Free/Paid
`;

    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const suggestions = message.content[0].type === "text" ? message.content[0].text : "";

    return NextResponse.json({ suggestions, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error("Suggestions error:", e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 502 });
  }
}
