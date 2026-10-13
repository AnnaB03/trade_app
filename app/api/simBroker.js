/* ---------- Simulated broker: real quotes, a cash account's rules ----------
   The paper account used to be the Tradier SANDBOX, and that taught habits a
   real account cannot have. The sandbox fills off a feed ~15 minutes behind
   the real-time one the decisions read, so the book could see the fill
   feed's future: entries filled at prices that no longer existed (PENG at
   $3.80 against a real $4.10/$4.50), and exits were timed for "when the
   sandbox catches up". With real money there is one feed and no catching up.

   This answers the same Tradier account endpoints tradeClient.js speaks —
   orders, one order, cancel, positions, balances — so every caller is
   unchanged and going live is a change of host, not of code. What differs
   is where a fill comes from: the REAL-TIME quote at the moment the order
   is looked at, on the side that costs money.

   Fill rules (pessimistic on purpose; nothing here ever invents a price):
   - buy limit:  fills when the real ask is at or below the limit — at the
                 ask if it is marketable on arrival, at the limit if it had
                 to rest and the market came to it.
   - sell limit: mirror image against the real bid.
   - sell stop:  triggers when the option's mid (shares: last) is at or
                 below the stop, then fills at the bid, as a stop-market does.
   - nothing fills while the market is closed; day orders expire at 16:00 ET.
   Resting orders are only examined when something asks about them, so a
   touch between two looks is missed rather than assumed. No partial fills.

   Account rules, modelled on the cash account this is practice for:
   - a buy must be covered by SETTLED cash; proceeds of a sale are unsettled
     until the next day, so money can be turned over once a day, not twice;
   - no short selling and no option writing;
   - options carry a per-contract fee on each side (SIM_OPTION_FEE_PER_CONTRACT,
     default $0.35 — Tradier's published standard rate, not yet checked
     against the fee schedule of the account that will actually be opened).

   State lives in data/sim.json. Starting cash is ACCOUNT_SIZE. */
import fs from "fs";
import path from "path";
import { tradier, asArray } from "./tradier.js";
import { getClock } from "./clockLib.js";
import { accountSize } from "./accountLib.js";

const FILE = path.join(process.cwd(), "data", "sim.json");
export const SIM_ACCOUNT = "SIM-CASH";
const feeEnv = process.env.SIM_OPTION_FEE_PER_CONTRACT;
export const OPTION_FEE = feeEnv != null && feeEnv !== "" && Number(feeEnv) >= 0 ? Number(feeEnv) : 0.35;
const START_CASH = accountSize();

const BUY = new Set(["buy", "buy_to_open"]);
const SELL = new Set(["sell", "sell_to_close"]);
const etDay = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etMinutes = (d) => {
  const [h, m] = new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).split(":").map(Number);
  return (h % 24) * 60 + m;
};
const multOf = (leg) => (leg.option_symbol ? 100 : 1);
const keyOf = (leg) => leg.option_symbol || leg.symbol;
const feeOf = (leg) => (leg.option_symbol ? OPTION_FEE * Number(leg.quantity) : 0);
const reject = (msg) => { throw new Error(`Simulated broker rejected the order: ${msg}`); };

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (s && Array.isArray(s.orders)) return s;
  } catch {}
  return { startCash: START_CASH, startedAt: new Date().toISOString(), nextId: 1, orders: [] };
}
function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

const allLegs = (state) => state.orders.flatMap((o) => o.legs);
const fills = (state) => allLegs(state).filter((l) => l.status === "filled").sort((a, b) => (a.transaction_date < b.transaction_date ? -1 : 1));

// Net long quantity and average-cost basis per instrument, from the fills.
function positionMap(state) {
  const map = new Map();
  for (const l of fills(state)) {
    const k = keyOf(l), qty = Number(l.exec_quantity), px = Number(l.avg_fill_price);
    const p = map.get(k) || { symbol: k, quantity: 0, cost_basis: 0, date_acquired: l.transaction_date };
    if (BUY.has(l.side)) {
      if (p.quantity === 0) p.date_acquired = l.transaction_date;
      p.quantity += qty; p.cost_basis += px * qty * multOf(l);
    } else {
      const avg = p.quantity > 0 ? p.cost_basis / p.quantity : 0;
      p.quantity -= qty; p.cost_basis -= avg * qty;
    }
    map.set(k, p);
  }
  for (const [k, p] of map) if (!(p.quantity > 0)) map.delete(k);
  return map;
}

// Quantity already promised to a working sell order. Unlike the sandbox,
// cancelling the order releases it — which is how a real broker behaves.
const committedToSells = (state, key) =>
  allLegs(state).filter((l) => l.status === "open" && SELL.has(l.side) && keyOf(l) === key).reduce((s, l) => s + Number(l.quantity), 0);

export function cashState(state = load(), now = new Date()) {
  const today = etDay(now);
  /* Money added to the account after it was opened (state.deposits). A deposit
     is settled cash from the moment it lands, and it is NOT profit: the
     ledger's realized figure is built from trades and never sees it. */
  const funded = state.startCash + (state.deposits || []).reduce((s, d) => s + (Number(d.amount) || 0), 0);
  let settled = funded, unsettled = 0, fees = 0;
  for (const l of fills(state)) {
    const gross = Number(l.avg_fill_price) * Number(l.exec_quantity) * multOf(l);
    const fee = Number(l.commission) || 0;
    fees += fee;
    if (BUY.has(l.side)) settled -= gross + fee;
    else if (etDay(l.transaction_date) < today) settled += gross - fee;
    else unsettled += gross - fee;
  }
  const committed = allLegs(state)
    .filter((l) => l.status === "open" && BUY.has(l.side))
    .reduce((s, l) => s + Number(l.price) * Number(l.quantity) * multOf(l) + feeOf(l), 0);
  return { startCash: funded, openedWith: state.startCash, settled, unsettled, committedToOpenBuys: committed, available: settled - committed, totalCash: settled + unsettled, feesPaid: fees };
}

// Shares the app's clock, including its tolerance for a slow broker call.
// "unknown" is treated as closed: no fill is ever assumed.
async function marketOpen() {
  return (await getClock()).state === "open";
}

function fill(leg, price, now) {
  leg.status = "filled";
  leg.exec_quantity = Number(leg.quantity);
  leg.avg_fill_price = Number(Number(price).toFixed(4));
  leg.last_fill_price = leg.avg_fill_price;
  leg.commission = feeOf(leg);
  leg.transaction_date = now.toISOString();
}

/* Look at every working order against the real market, once. `arrivedId` is
   the order that was submitted on this very call: only that one can take
   the touch price, because only it is hitting a quote it has just seen. */
async function evaluate(state, { arrivedId = null } = {}) {
  const now = new Date();
  const today = etDay(now), mins = etMinutes(now);
  let changed = false;

  for (const o of state.orders) {
    for (const l of o.legs) {
      if ((l.status === "open" || l.status === "pending") && l.duration === "day") {
        const made = etDay(l.create_date);
        if (made < today || (made === today && mins >= 16 * 60)) { l.status = "expired"; l.transaction_date = now.toISOString(); changed = true; }
      }
    }
    // An OTO stop whose entry died never becomes live.
    if (o.class === "oto" && ["expired", "canceled", "rejected"].includes(o.legs[0].status) && o.legs[1]?.status === "pending") {
      o.legs[1].status = "canceled"; changed = true;
    }
  }

  const working = allLegs(state).filter((l) => l.status === "open");
  if (working.length && (await marketOpen())) {
    const keys = [...new Set(working.map(keyOf))];
    let quotes = [];
    try {
      const d = await tradier(`/markets/quotes?symbols=${encodeURIComponent(keys.join(","))}`, { timeoutMs: 8000 });
      quotes = asArray(d?.quotes?.quote);
    } catch {}
    const bySym = new Map(quotes.map((q) => [q.symbol, q]));
    for (const o of state.orders) {
      for (const l of o.legs) {
        if (l.status !== "open") continue;
        const q = bySym.get(keyOf(l));
        const bid = Number(q?.bid), ask = Number(q?.ask);
        if (!(bid > 0) || !(ask > 0) || ask < bid) continue; // no two-sided market, no fill
        const arrived = o.id === arrivedId;
        if (BUY.has(l.side) && l.type === "limit" && ask <= Number(l.price)) {
          fill(l, arrived ? ask : Number(l.price), now); changed = true;
          if (o.class === "oto" && o.legs[1]?.status === "pending") o.legs[1].status = "open";
        } else if (SELL.has(l.side) && l.type === "limit" && bid >= Number(l.price)) {
          fill(l, arrived ? bid : Number(l.price), now); changed = true;
        } else if (SELL.has(l.side) && l.type === "stop") {
          const ref = l.option_symbol ? (bid + ask) / 2 : (Number(q?.last) > 0 ? Number(q.last) : bid);
          if (ref <= Number(l.stop_price)) { fill(l, bid, now); changed = true; }
        }
      }
    }
  }

  // A sell that no longer has anything behind it (the position was closed by
  // another order) is cancelled, as a broker would on the position going flat.
  const pos = positionMap(state);
  for (const l of allLegs(state)) {
    if (l.status === "open" && SELL.has(l.side) && !pos.has(keyOf(l))) { l.status = "canceled"; changed = true; }
  }
  for (const o of state.orders) o.status = orderStatus(o);
  if (changed) save(state);
  return state;
}

function orderStatus(o) {
  if (o.class !== "oto") return o.legs[0].status;
  const s = o.legs.map((l) => l.status);
  if (s.every((x) => x === "filled")) return "filled";
  if (s.some((x) => x === "open" || x === "pending")) return "open";
  return s[0] === "filled" ? "filled" : s[0];
}

// Tradier's response shape: a single order is flat, an OTO carries `leg`.
function render(o) {
  if (o.class !== "oto") return { ...o.legs[0], id: o.id, class: o.class, status: o.legs[0].status };
  return { id: o.id, class: "oto", status: o.status, create_date: o.create_date, leg: o.legs.map((l) => ({ ...l })) };
}

function newLeg(state, f, now) {
  return {
    id: state.nextId++, symbol: f.symbol, option_symbol: f.option_symbol || null, side: f.side,
    quantity: Number(f.quantity), type: f.type, price: f.price != null ? Number(f.price) : null,
    stop_price: f.stop != null ? Number(f.stop) : null, duration: f.duration || "day",
    status: "open", exec_quantity: 0, avg_fill_price: 0, last_fill_price: 0, commission: 0,
    create_date: now.toISOString(), transaction_date: now.toISOString(),
  };
}

async function submit(state, form) {
  const now = new Date();
  const cls = form.class;
  let specs;
  if (cls === "option" || cls === "equity") {
    specs = [{ symbol: form.symbol, option_symbol: cls === "option" ? form.option_symbol : null, side: form.side, quantity: form.quantity, type: form.type, price: form.price, stop: form.stop, duration: form.duration }];
  } else if (cls === "oto") {
    specs = [0, 1].map((i) => ({
      symbol: form[`symbol[${i}]`] || form.symbol, option_symbol: form[`option_symbol[${i}]`] || null, side: form[`side[${i}]`],
      quantity: form[`quantity[${i}]`], type: form[`type[${i}]`], price: form[`price[${i}]`], stop: form[`stop[${i}]`], duration: form[`duration[${i}]`],
    }));
  } else {
    reject(`order class "${cls}" is not supported — single-leg option and equity orders only.`);
  }
  const first = specs[0];
  if (!(Number(first.quantity) > 0) || !Number.isInteger(Number(first.quantity))) reject("quantity must be a whole number.");
  if (first.type !== "limit" || !(Number(first.price) > 0)) reject("limit orders with a positive price only.");
  if (!BUY.has(first.side) && !SELL.has(first.side)) reject(`"${first.side}" is not available in a cash account — no short selling and no option writing.`);

  const mult = first.option_symbol ? 100 : 1;
  const key = first.option_symbol || first.symbol;
  if (BUY.has(first.side)) {
    const need = Number(first.price) * Number(first.quantity) * mult + (first.option_symbol ? OPTION_FEE * Number(first.quantity) : 0);
    const cash = cashState(state, now);
    if (need > cash.available + 1e-6) {
      reject(`not enough settled cash — this needs $${need.toFixed(2)} and $${cash.available.toFixed(2)} is available${cash.unsettled > 0 ? ` ($${cash.unsettled.toFixed(2)} from today's sales settles tomorrow)` : ""}.`);
    }
  } else {
    const held = positionMap(state).get(key)?.quantity || 0;
    const free = held - committedToSells(state, key);
    if (Number(first.quantity) > free) reject(`sell of ${first.quantity} ${key} exceeds the ${free} available (holding ${held}, ${held - free} committed to other working sell orders).`);
  }
  if (form.preview === "true") return { order: { status: "ok", preview: true, class: cls, symbol: first.symbol, quantity: Number(first.quantity), cost: Number(first.price) * Number(first.quantity) * mult } };

  const order = { id: state.nextId++, class: cls, create_date: now.toISOString(), legs: specs.map((s) => newLeg(state, s, now)) };
  if (cls === "oto") order.legs[1].status = "pending"; // live only once the entry fills
  order.status = orderStatus(order);
  state.orders.push(order);
  save(state);
  await evaluate(state, { arrivedId: order.id });
  return { order: { id: order.id, status: "ok" } };
}

// One request at a time: every call reads, mutates and rewrites the same file.
let chain = Promise.resolve();
export function simFetch(pathname, opts = {}) {
  const run = chain.then(() => handle(pathname, opts));
  chain = run.catch(() => {});
  return run;
}

async function handle(pathname, { method = "GET", form } = {}) {
  const state = load();
  const p = pathname.split("?")[0];
  if (p === "/user/profile") return { profile: { account: { account_number: SIM_ACCOUNT, type: "cash" } } };
  const m = p.match(/^\/accounts\/[^/]+\/(orders|positions|balances)(?:\/([^/]+))?$/);
  if (!m) throw new Error(`Simulated broker: unsupported path ${p}`);
  const [, what, id] = m;

  if (what === "orders" && method === "POST") return submit(state, form || {});
  await evaluate(state);

  if (what === "orders" && id) {
    const o = state.orders.find((x) => String(x.id) === String(id) || x.legs.some((l) => String(l.id) === String(id)));
    if (!o) throw new Error(`Simulated broker: no order ${id}`);
    if (method === "DELETE") {
      for (const l of o.legs) {
        if ((l.status === "open" || l.status === "pending") && (String(o.id) === String(id) || String(l.id) === String(id))) {
          l.status = "canceled"; l.transaction_date = new Date().toISOString();
        }
      }
      o.status = orderStatus(o);
      save(state);
      return { order: { id: o.id, status: "ok" } };
    }
    return { order: render(o) };
  }
  if (what === "orders") return { orders: state.orders.length ? { order: state.orders.map(render) } : "null" };
  if (what === "positions") {
    const list = [...positionMap(state).values()].map((x, i) => ({ id: i + 1, symbol: x.symbol, quantity: x.quantity, cost_basis: Number(x.cost_basis.toFixed(2)), date_acquired: x.date_acquired }));
    return { positions: list.length ? { position: list } : "null" };
  }
  const c = cashState(state);
  return { balances: { account_number: SIM_ACCOUNT, account_type: "cash", total_cash: c.totalCash, cash: { cash_available: c.available, unsettled_funds: c.unsettled }, sim: c } };
}
