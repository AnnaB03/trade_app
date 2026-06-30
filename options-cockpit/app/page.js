"use client";
import { useState, useEffect, useMemo, useCallback } from "react";

/* ---------- risk math (defined-risk + uncapped-risk detection) ---------- */
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const intrinsic = (t, K, S) => (t === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0));

function analyze(legs) {
  const v = legs.filter((l) => l.strike !== "" && l.premium !== "");
  if (!v.length) return null;
  const pnl = (S) => v.reduce((s, l) => {
    const intr = intrinsic(l.type, num(l.strike), S);
    const per = l.action === "buy" ? intr - num(l.premium) : num(l.premium) - intr;
    return s + per * (num(l.qty) || 1) * 100;
  }, 0);
  const net = v.reduce((s, l) => s + (l.action === "buy" ? 1 : -1) * num(l.premium) * (num(l.qty) || 1) * 100, 0);
  const callSlope = v.reduce((s, l) => l.type === "call" ? s + (l.action === "buy" ? 1 : -1) * (num(l.qty) || 1) : s, 0);
  const unlimitedLoss = callSlope < 0, unlimitedProfit = callSlope > 0;
  const strikes = v.map((l) => num(l.strike));
  const pts = Array.from(new Set([0, ...strikes, Math.max(...strikes) * 3 + 50])).sort((a, b) => a - b);
  const samp = pts.map((S) => ({ S, p: pnl(S) }));
  let maxP = Math.max(...samp.map((d) => d.p)), maxL = Math.min(...samp.map((d) => d.p));
  if (unlimitedProfit) maxP = Infinity; if (unlimitedLoss) maxL = -Infinity;
  const bes = [];
  for (let i = 1; i < samp.length; i++) {
    const a = samp[i - 1], b = samp[i];
    if (((a.p <= 0 && b.p >= 0) || (a.p >= 0 && b.p <= 0)) && a.p !== b.p) {
      const S = a.S + (b.S - a.S) * (0 - a.p) / (b.p - a.p);
      if (S >= 0) bes.push(S);
    }
  }
  const rr = isFinite(maxP) && isFinite(maxL) && maxL !== 0 ? Math.abs(maxP / maxL) : null;
  return { net, maxP, maxL, bes, unlimitedLoss, unlimitedProfit, rr };
}
const money = (v) => v === Infinity ? "Unlimited ▲" : v === -Infinity ? "UNLIMITED" :
  (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(Math.abs(v) >= 1000 ? 0 : 2);
const pct = (v) => v == null ? "—" : (v * 100).toFixed(1) + "%";
const f2 = (v) => v == null || v === "" ? "—" : Number(v).toFixed(2);

/* ---------- data hooks ---------- */
async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

/* ---------- watchlist ---------- */
function Watchlist({ onPick }) {
  const [syms, setSyms] = useState(() => {
    if (typeof window === "undefined") return ["SPY", "QQQ", "NVDA", "TSLA", "AMD"];
    try { return JSON.parse(localStorage.getItem("cockpit_watch")) || ["SPY", "QQQ", "NVDA", "TSLA", "AMD"]; }
    catch { return ["SPY", "QQQ", "NVDA", "TSLA", "AMD"]; }
  });
  const [quotes, setQuotes] = useState([]);
  const [err, setErr] = useState("");
  const [add, setAdd] = useState("");

  useEffect(() => { try { localStorage.setItem("cockpit_watch", JSON.stringify(syms)); } catch {} }, [syms]);

  const load = useCallback(async () => {
    if (!syms.length) { setQuotes([]); return; }
    try { const d = await getJSON(`/api/quote?symbols=${syms.join(",")}`); setQuotes(d.quotes); setErr(""); }
    catch (e) { setErr(e.message); }
  }, [syms]);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}><span className="live" />Live · refreshes every 30s</span>
        <div style={{ display: "flex", gap: 6 }}>
          <input className="in" style={{ width: 90 }} placeholder="add" value={add}
            onChange={(e) => setAdd(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter" && add.trim()) { setSyms([...new Set([...syms, add.trim()])]); setAdd(""); } }} />
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      <table>
        <thead><tr>
          <th style={{ textAlign: "left" }}>Symbol</th><th>Last</th><th>Chg</th><th>Chg %</th>
          <th>Bid</th><th>Ask</th><th>Vol</th><th></th>
        </tr></thead>
        <tbody>
          {syms.map((s) => {
            const q = quotes.find((x) => x.symbol === s) || {};
            const chg = q.change, dn = chg < 0;
            return (
              <tr key={s}>
                <td style={{ textAlign: "left", fontWeight: 600, cursor: "pointer" }} onClick={() => onPick(s)}>{s}</td>
                <td>{f2(q.last)}</td>
                <td className={dn ? "down" : "up"}>{q.change != null ? (dn ? "" : "+") + f2(q.change) : "—"}</td>
                <td className={dn ? "down" : "up"}>{q.change_percentage != null ? (dn ? "" : "+") + Number(q.change_percentage).toFixed(2) + "%" : "—"}</td>
                <td className="muted">{f2(q.bid)}</td><td className="muted">{f2(q.ask)}</td>
                <td className="muted">{q.volume ? Number(q.volume).toLocaleString() : "—"}</td>
                <td><button className="chip" onClick={() => onPick(s)}>chain →</button>
                  <button className="x" onClick={() => setSyms(syms.filter((x) => x !== s))}>×</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- chain + risk builder ---------- */
function ChainRisk({ symbol, setSymbol }) {
  const [input, setInput] = useState(symbol || "");
  const [exps, setExps] = useState([]);
  const [exp, setExp] = useState("");
  const [chain, setChain] = useState([]);
  const [spot, setSpot] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [legs, setLegs] = useState([]);

  useEffect(() => { if (symbol) { setInput(symbol); loadExp(symbol); } }, [symbol]);

  async function loadExp(sym) {
    setErr(""); setChain([]); setExp("");
    try {
      const [e, q] = await Promise.all([
        getJSON(`/api/expirations?symbol=${sym}`),
        getJSON(`/api/quote?symbols=${sym}`),
      ]);
      setExps(e.expirations); setSpot(q.quotes[0]?.last ?? null);
      if (e.expirations[0]) loadChain(sym, e.expirations[0]);
    } catch (er) { setErr(er.message); }
  }
  async function loadChain(sym, expiration) {
    setExp(expiration); setLoading(true); setErr("");
    try { const d = await getJSON(`/api/chain?symbol=${sym}&expiration=${expiration}`); setChain(d.options); }
    catch (er) { setErr(er.message); } finally { setLoading(false); }
  }

  const strikes = useMemo(() => {
    const m = {};
    chain.forEach((o) => { (m[o.strike] = m[o.strike] || {})[o.type] = o; });
    return Object.keys(m).map(Number).sort((a, b) => a - b).map((k) => ({ strike: k, ...m[k] }));
  }, [chain]);

  const addLeg = (o, action) => {
    const mid = o.bid != null && o.ask != null ? ((Number(o.bid) + Number(o.ask)) / 2) : Number(o.last || 0);
    setLegs((ls) => [...ls, { action, type: o.type, strike: String(o.strike), premium: mid.toFixed(2), qty: 1 }]);
  };
  const a = useMemo(() => analyze(legs), [legs]);

  return (
    <>
      <div className="card">
        <span className="label">Symbol</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="in" placeholder="TICKER" value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && input.trim() && (setSymbol(input.trim()), loadExp(input.trim()))} />
          <button className="btn" onClick={() => input.trim() && (setSymbol(input.trim()), loadExp(input.trim()))}>Load chain</button>
          {spot != null && <span className="mono" style={{ alignSelf: "center" }}>Spot: <b>${f2(spot)}</b></span>}
        </div>
        {exps.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <span className="label">Expiration</span>
            <select className="sel" value={exp} onChange={(e) => loadChain(input, e.target.value)} style={{ width: "100%", maxWidth: 260 }}>
              {exps.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}
      </div>

      {err && <div className="err">{err}</div>}

      {a && a.unlimitedLoss && (
        <div className="danger"><b>⚠ UNCAPPED RISK — DO NOT SUBMIT BLIND</b>
          <div className="d2">More short calls than long. Loss is unlimited to the upside. Add a long call above your short strike to cap it.</div></div>
      )}
      {legs.length > 0 && a && !a.unlimitedLoss && (
        <div className="safe">✓ Defined risk — max loss capped at {money(a.maxL)}.</div>
      )}

      {legs.length > 0 && a && (
        <div className="card">
          <span className="label">Position</span>
          {legs.map((l, i) => (
            <div className="leg" key={i}>
              <span><b className={l.action === "buy" ? "up" : "down"}>{l.action.toUpperCase()}</b> {l.type} ${l.strike} @ ${l.premium} ×{l.qty}</span>
              <button className="x" onClick={() => setLegs(legs.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <div className="metrics" style={{ marginTop: 14 }}>
            <div className="metric"><div className="k">Max profit</div><div className="v" style={{ color: a.unlimitedProfit ? "var(--bull)" : "var(--ink)" }}>{money(a.maxP)}</div></div>
            <div className="metric"><div className="k">Max loss</div><div className="v" style={{ color: a.unlimitedLoss ? "var(--bear)" : "var(--ink)" }}>{money(a.maxL)}</div></div>
            <div className="metric"><div className="k">Breakeven</div><div className="v">{a.bes.length ? a.bes.map((b) => "$" + b.toFixed(2)).join(" / ") : "—"}</div></div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
            <span>{a.net >= 0 ? "Net debit: " : "Net credit: "}<b style={{ color: "var(--ink)" }}>{money(Math.abs(a.net))}</b></span>
            {a.rr && <span>Risk/reward 1 : {a.rr.toFixed(2)}</span>}
            <button className="chip" onClick={() => setLegs([])}>clear</button>
          </div>
        </div>
      )}

      {loading && <div className="card muted">Loading chain…</div>}

      {strikes.length > 0 && (
        <div className="card" style={{ overflowX: "auto" }}>
          <span className="label">Chain · {exp} · tap a price to add a leg (buy)/(sell) · IV &amp; Greeks live from Tradier/ORATS</span>
          <table>
            <thead><tr>
              <th>C Δ</th><th>C IV</th><th>C OI</th><th>C Bid×Ask</th>
              <th className="strike-col">Strike</th>
              <th>P Bid×Ask</th><th>P OI</th><th>P IV</th><th>P Δ</th>
            </tr></thead>
            <tbody>
              {strikes.map((r) => {
                const atm = spot != null && Math.abs(r.strike - spot) <= (strikes[1]?.strike - strikes[0]?.strike || 5) / 2;
                return (
                  <tr key={r.strike} className={atm ? "atm" : ""}>
                    <td>{f2(r.call?.delta)}</td><td>{pct(r.call?.iv)}</td><td className="muted">{r.call?.oi ?? "—"}</td>
                    <td>{r.call ? <span><button className="chip" style={{ padding: "2px 6px" }} onClick={() => addLeg(r.call, "buy")}>{f2(r.call.bid)}</button>×<button className="chip" style={{ padding: "2px 6px" }} onClick={() => addLeg(r.call, "sell")}>{f2(r.call.ask)}</button></span> : "—"}</td>
                    <td className="strike-col">{r.strike}</td>
                    <td>{r.put ? <span><button className="chip" style={{ padding: "2px 6px" }} onClick={() => addLeg(r.put, "buy")}>{f2(r.put.bid)}</button>×<button className="chip" style={{ padding: "2px 6px" }} onClick={() => addLeg(r.put, "sell")}>{f2(r.put.ask)}</button></span> : "—"}</td>
                    <td className="muted">{r.put?.oi ?? "—"}</td><td>{pct(r.put?.iv)}</td><td>{f2(r.put?.delta)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function Page() {
  const [tab, setTab] = useState("watch");
  const [symbol, setSymbol] = useState("");
  const pick = (s) => { setSymbol(s); setTab("chain"); };
  return (
    <div className="wrap">
      <span className="eyebrow">Options Desk · Live Cockpit</span>
      <h1>The Cockpit</h1>
      <p className="sub">Live quotes and chains from your Tradier account, with defined-risk math built in.</p>
      <div className="tabs">
        <button className={"tab" + (tab === "watch" ? " on" : "")} onClick={() => setTab("watch")}>Watchlist</button>
        <button className={"tab" + (tab === "chain" ? " on" : "")} onClick={() => setTab("chain")}>Chain &amp; Risk</button>
      </div>
      {tab === "watch" && <Watchlist onPick={pick} />}
      {tab === "chain" && <ChainRisk symbol={symbol} setSymbol={setSymbol} />}
      <div className="foot">
        Informational only — not financial advice. Real-time data requires a funded Tradier brokerage account; without one the feed is delayed.
        Risk figures assume holding to expiration and ignore commissions, assignment, and slippage — confirm in your broker before trading.
        Your token stays server-side and is never sent to the browser.
      </div>
    </div>
  );
}
