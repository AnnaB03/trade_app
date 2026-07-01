const BASE = process.env.TRADIER_BASE || "https://sandbox.tradier.com/v1";
const TOKEN = process.env.TRADIER_TOKEN_SANDBOX || process.env.TRADIER_TOKEN;

export async function tradier(path) {
  if (!TOKEN) throw new Error("Server is missing TRADIER_TOKEN_SANDBOX or TRADIER_TOKEN — set it in your environment / Vercel project settings.");
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("Tradier rejected the token (401). Check it's a valid token for the endpoint.");
  if (!res.ok) throw new Error(`Tradier responded ${res.status}`);
  return res.json();
}
export const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
