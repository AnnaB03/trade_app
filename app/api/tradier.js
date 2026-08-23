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

export async function tradier(path) {
  if (!TOKEN) throw new Error("Server is missing TRADIER_TOKEN (production, real-time) or TRADIER_TOKEN_SANDBOX — set it in your environment / Vercel project settings.");
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error(`Tradier rejected the token (401) for ${isSandbox ? "sandbox" : "production"} data. Production needs TRADIER_TOKEN from a funded brokerage account; sandbox needs TRADIER_TOKEN_SANDBOX.`);
  if (!res.ok) throw new Error(`Tradier responded ${res.status}`);
  return res.json();
}
export const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
