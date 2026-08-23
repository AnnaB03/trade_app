import { sandboxLockError, tradeFetch, accountId, asArray } from "../tradeClient";
import { validateLegs, gateA, gateB, gateC, buildOrderForm, netPremium } from "../../lib/orders";
import { analyze } from "../../lib/metrics";

export const MAX_LOSS_CAP = () => {
  const n = Number(process.env.MAX_LOSS_PER_TRADE);
  return Number.isFinite(n) && n > 0 ? n : 500;
};

/* Runs every server-side check shared by stage and place.
   Returns { error, status } on rejection, else { gates, computed, form, underlying }. */
export async function vetOrder(body, { preview }) {
  const lock = sandboxLockError();
  if (lock) return { error: lock, status: 403 };

  if (body?.type === "market" || body?.order_type === "market") {
    return { error: "Market orders are rejected for options — limit orders only.", status: 422 };
  }
  const legs = body?.legs;
  const legErr = validateLegs(legs);
  if (legErr) return { error: legErr, status: 422 };

  const closing = body?.closing === true;
  let gates;
  if (closing) {
    // A closing order unwinds an existing position — verify each leg against live
    // positions so a mislabeled "closing" order can't open naked risk.
    const acct = await accountId();
    const pos = asArray((await tradeFetch(`/accounts/${acct}/positions`))?.positions?.position);
    for (const l of legs) {
      const p = pos.find((x) => x.symbol === l.occ);
      const q = Number(p?.quantity) || 0;
      const okDir = l.action === "sell" ? q >= Number(l.qty) : q <= -Number(l.qty);
      if (!p || !okDir) {
        return { error: `Closing order does not match an open position for ${l.occ} (have ${q}, closing ${l.action} ${l.qty}).`, status: 422 };
      }
    }
    gates = { closing_verified: { ok: true, msg: "Legs verified against open positions" } };
  } else {
    const a = gateA(legs);
    if (!a.ok) return { error: a.msg, status: 422, gates: { a } };
    const b = gateB(legs, body?.ack_defined_large_risk);
    const c = gateC(legs, MAX_LOSS_CAP(), b);
    if (!c.ok) return { error: c.msg, status: 422, gates: { a, b, c } };
    if (!b.ok) return { error: b.msg, status: 422, gates: { a, b, c }, needs_ack: true, figure: b.figure };
    gates = { a, b, c };
  }

  const risk = analyze(legs);
  const { form, underlying, net, side_map } = buildOrderForm(legs, {
    closing, limitPrice: body?.limit_price, preview,
  });
  return {
    gates, form, underlying,
    computed: {
      net, suggested_limit: Math.abs(netPremium(legs)),
      max_loss: risk ? risk.maxL : null,
      max_profit: risk ? risk.maxP : null,
      breakevens: risk ? risk.bes : [],
      side_map,
      order_class: form.class, order_type: form.type, price: form.price ?? null,
    },
  };
}

export async function submitOrder(form) {
  const acct = await accountId();
  return tradeFetch(`/accounts/${acct}/orders`, { method: "POST", form });
}
