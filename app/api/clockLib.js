/* The market clock, with a memory.

   The broker's API has slow minutes: on 2026-10-08 single calls took 6-15
   seconds, several times an hour. Every one made the clock read "unknown" or
   failed the health check, and the schedule then skipped that minute's exit
   checks with a position open. The market does not open or close because one
   request was slow, so a recent good answer is reused: fresh for 30 seconds,
   and trusted for up to 10 minutes when the live call fails. Past that it
   really is unknown, and says so. */
import { tradier } from "./tradier";

let good = null; // { at, data }
const FRESH_MS = 30000, TRUST_MS = 10 * 60000;

export async function getClock() {
  if (good && Date.now() - good.at < FRESH_MS) return good.data;
  try {
    const d = await tradier("/markets/clock", { timeoutMs: 5000 });
    const c = d?.clock || {};
    if (!c.state) throw new Error("no clock state in the response");
    const data = { state: c.state, description: c.description || "", date: c.date || null, next_change: c.next_change || null, next_state: c.next_state || null };
    good = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (good && Date.now() - good.at < TRUST_MS) {
      return { ...good.data, stale: true, staleSeconds: Math.round((Date.now() - good.at) / 1000), error: String(e.message || e) };
    }
    return { state: "unknown", description: "", error: String(e.message || e) };
  }
}
