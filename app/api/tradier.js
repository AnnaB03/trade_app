/* Market DATA client (quotes, chains, expirations, history).
   Data prefers PRODUCTION Tradier — a funded-account token gives real-time quotes;
   the sandbox is 15-min delayed. Order routes never use this client: they go
   through tradeClient.js, which is hard-locked to the sandbox (paper trading).

   Token/base resolution:
   - TRADIER_TOKEN set        → production base, real-time data
   - only TRADIER_TOKEN_SANDBOX → sandbox base, delayed data
   - TRADIER_BASE overrides the base explicitly (rarely needed now) */
const PROD = "https://api.tradier.com/v1";
const SANDBOX = "https://sandbox.tradier.com/v1";

const prodToken = process.env.TRADIER_TOKEN;
const sandboxToken = process.env.TRADIER_TOKEN_SANDBOX;
const BASE = process.env.TRADIER_BASE || (prodToken ? PROD : SANDBOX);
const isSandbox = BASE.includes("sandbox");
const TOKEN = isSandbox ? (sandboxToken || prodToken) : (prodToken || sandboxToken);

// "realtime" only when we're on the production host with a production token
export const dataMode = () => (!isSandbox && prodToken ? "realtime" : "delayed");

// timeoutMs bounds a single call. Callers that loop over many symbols need
// this: without it one slow response stalls a whole route, and autotrade runs
// on a 15-minute cron that must finish well inside its own window.
export async function tradier(path, { timeoutMs } = {}) {
  if (!TOKEN) throw new Error("Server is missing TRADIER_TOKEN (production, real-time) or TRADIER_TOKEN_SANDBOX — set it in your environment / Vercel project settings.");
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    cache: "no-store",
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (res.status === 401) throw new Error(`Tradier rejected the token (401) for ${isSandbox ? "sandbox" : "production"} data. Production needs TRADIER_TOKEN from a funded brokerage account; sandbox needs TRADIER_TOKEN_SANDBOX.`);
  if (!res.ok) throw new Error(`Tradier responded ${res.status}`);
  return res.json();
}
export const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
/* Same call, but deliberately against the SANDBOX host — delayed data, on
   purpose. Real-time is the right clock for an ENTRY decision: a trigger has to
   be judged on where price is now. It is the wrong clock for valuing a PAPER
   position, for two reasons that both point the same way:
     1. The sandbox order engine prices fills off its own delayed feed, so the
        delayed quote is what a sale here would actually realise.
     2. It is what the user sees on the sandbox UI, so any other source makes
        our numbers disagree with theirs.
   Measured 2026-10-02 on SPCX 10/23 $157.50c, 14 contracts at $6.65 entry, the
   same instant: production bid/ask/last 6.65/6.80/7.00 (so +$70 to +$490) while
   the sandbox read 6.60/6.75/6.64 — the sandbox last of 6.64 is -$14, and the
   user's screen said -$28. Reporting +$385 off production was simply the wrong
   feed. The reverse happened on AVGO, where the user's figure was HIGHER than
   mine: that asymmetry is the signature of a clock difference, not of a
   bid-versus-mid convention.
   Falls back to the normal client when no sandbox token exists. */
export async function tradierDelayed(path, { timeoutMs } = {}) {
  if (!sandboxToken) return tradier(path, { timeoutMs });
  const res = await fetch(`${SANDBOX}${path}`, {
    headers: { Authorization: `Bearer ${sandboxToken}`, Accept: "application/json" },
    cache: "no-store",
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!res.ok) throw new Error(`Tradier sandbox data responded ${res.status}`);
  return res.json();
}

