/* ---------- The news playbook (2026-10-14) ----------
   Trade ideas from the risk & market analyst (agentsLib.js), written into the
   idea ledger as strategy "news" and traded by the normal entry loop under
   every existing rule. The owner: "can we add additional ideas that will be
   coming from the Risk and market into Ideas tab but just in a different
   section?"

   The agent cannot write anything. It ends its report with a fenced block:
     ```ideas-json
     [{ "symbol": "NVDA", "action": "PUT", "triggerPrice": 219.5, "triggerDirection": "below",
        "invalidation": 222.4, "target": 214.8, "why": "...", "catalyst": "...", "staleMinutes": 120 }]
     ```
   and this server checks each one (validateNewsIdea, pure) and picks the
   contract itself (contractLib.js). Same-day only for now: news plays out
   inside the session, and these are flat by the close like the other
   same-day playbooks. */
import { MIN_REWARD_RISK } from "./order/entryRules.js";

export const NEWS_STRATEGY = "news";
export const MAX_NEWS_IDEAS_PER_RUN = 3;
export const MAX_TRIGGER_DISTANCE_PCT = 3;     // a same-day trigger within 3% of the price
export const DEFAULT_STALE_MIN = 120, MAX_STALE_MIN = 240;

// The ideas block from a report, or [] when there is none or it is not valid JSON.
export function parseIdeasBlock(text) {
  const m = /```ideas-json\s*([\s\S]*?)```/i.exec(String(text || ""));
  if (!m) return [];
  try { const v = JSON.parse(m[1]); return Array.isArray(v) ? v : []; } catch { return []; }
}
// The report as shown: the machine block replaced by a one-line note.
export const stripIdeasBlock = (text) => String(text || "").replace(/```ideas-json[\s\S]*?```/gi, "").trimEnd();

/* One idea, checked against the live price. Returns { ok: true, idea } with
   numbers normalised, or { ok: false, reason }. */
export function validateNewsIdea(raw, { last } = {}) {
  const r = raw || {};
  const symbol = String(r.symbol || "").toUpperCase().trim();
  if (!/^[A-Z]{1,5}$/.test(symbol)) return { ok: false, reason: `bad symbol "${r.symbol}"` };
  const action = String(r.action || "").toUpperCase();
  if (!["CALL", "PUT"].includes(action)) return { ok: false, reason: `${symbol}: action must be CALL or PUT` };
  const trigger = Number(r.triggerPrice), inv = Number(r.invalidation), target = Number(r.target);
  const dirn = String(r.triggerDirection || "").toLowerCase();
  if (![trigger, inv, target].every((x) => Number.isFinite(x) && x > 0)) return { ok: false, reason: `${symbol}: trigger, invalidation and target must be prices` };
  if (!["above", "below"].includes(dirn)) return { ok: false, reason: `${symbol}: triggerDirection must be above or below` };
  // The losing level on the losing side of the trigger, the target on the winning side.
  if (action === "CALL" ? !(inv < trigger && trigger < target) : !(target < trigger && trigger < inv)) {
    return { ok: false, reason: `${symbol} ${action}: levels on the wrong sides (invalidation ${inv}, trigger ${trigger}, target ${target})` };
  }
  const rr = Math.abs(target - trigger) / Math.abs(trigger - inv);
  if (!(rr >= MIN_REWARD_RISK)) return { ok: false, reason: `${symbol} ${action}: reward:risk ${rr.toFixed(2)}:1 from the trigger, under ${MIN_REWARD_RISK}:1` };
  if (Number(last) > 0 && (Math.abs(trigger - last) / last) * 100 > MAX_TRIGGER_DISTANCE_PCT) {
    return { ok: false, reason: `${symbol}: trigger ${trigger} is more than ${MAX_TRIGGER_DISTANCE_PCT}% from the price ${last}` };
  }
  const stale = Math.min(MAX_STALE_MIN, Math.max(15, Number(r.staleMinutes) || DEFAULT_STALE_MIN));
  return {
    ok: true,
    idea: {
      symbol, action, vehicle: "OPTION", triggerPrice: trigger, triggerDirection: dirn, invalidation: inv, target,
      staleMinutes: stale, conviction: Math.min(5, Math.max(2, Number(r.conviction) || 3)),
      catalyst: String(r.catalyst || "news").slice(0, 120),
      why_plain: String(r.why || "").slice(0, 600), why_pro: String(r.why || "").slice(0, 600),
      rewardRisk: Math.round(rr * 100) / 100,
    },
  };
}

/* Checks and records the ideas from one analyst report. Deps are passed in
   (quote, contract picker, ledger) so the route owns the I/O. Returns
   { accepted: [{ symbol, action, occ }], rejected: [reason] }. */
export async function ingestNewsIdeas(text, { quote, pickContract, appendIdea, accountSize, source }) {
  const raws = parseIdeasBlock(text).slice(0, MAX_NEWS_IDEAS_PER_RUN);
  const accepted = [], rejected = [];
  for (const raw of raws) {
    try {
      const last = await quote(String(raw?.symbol || "").toUpperCase());
      const v = validateNewsIdea(raw, { last });
      if (!v.ok) { rejected.push(v.reason); continue; }
      const c = await pickContract(v.idea.symbol, v.idea.action === "CALL" ? "call" : "put");
      if (!c) { rejected.push(`${v.idea.symbol}: no liquid 1-4 day contract fits`); continue; }
      const row = appendIdea({
        ...v.idea, strike: c.strike, expiration: c.expiration, leg: c.leg,
        entryPrice: last, entryTrigger: `${v.idea.triggerDirection} ${v.idea.triggerPrice}`, risk: "HIGH",
        sizing: { vehicle: "OPTION", contracts: 1 }, affordable: true, accountSize,
        flatByClose: true, horizon: "intraday", strategy: NEWS_STRATEGY, source, marketState: "open",
      });
      accepted.push({ symbol: v.idea.symbol, action: v.idea.action, occ: c.leg.occ, id: row?.id });
    } catch (e) { rejected.push(`${raw?.symbol ?? "?"}: ${e.message || e}`); }
  }
  return { accepted, rejected };
}
