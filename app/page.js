"use client";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  analyze, toRows, expectedMove, moveVerdict, ivSnapshot, ivRank, ivRankRead, nearestMonthly,
  oiWalls, todayStr, daysUntil, eventsHeldThrough,
  spreadPct, spreadFlag, spreadRead, realizedVol, ivHvRead,
} from "./lib/metrics";
import Divergence from "./components/Divergence";
import Journal from "./components/Journal";

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
const DEFAULT_SYMS = ["SPY", "SPX", "QQQ", "NVDA", "TSLA", "AMD"];
// Symbols added to DEFAULT_SYMS after launch, tagged with the version that introduced
// them. Each is merged into an already-saved watchlist exactly once, so new defaults
// reach existing users without resurrecting symbols they deliberately deleted.
// When adding another, append it here and bump WATCH_VERSION to match.
const WATCH_VERSION = 1;
const ADDED_SYMS = [{ v: 1, sym: "SPX" }];

function Watchlist({ onPick }) {
  const [syms, setSyms] = useState(DEFAULT_SYMS);
  const [quotes, setQuotes] = useState([]);
  const [err, setErr] = useState("");
  const [add, setAdd] = useState("");
  const hydrated = useRef(false);

  // Restore the saved list after mount so server and client render the same initial HTML.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cockpit_watch"));
      if (Array.isArray(saved) && saved.length) {
        const seen = Number(localStorage.getItem("cockpit_watch_v")) || 0;
        const merged = [...saved];
        for (const { v, sym } of ADDED_SYMS) {
          if (v > seen && !merged.includes(sym)) merged.push(sym);
        }
        setSyms(merged);
      }
      localStorage.setItem("cockpit_watch_v", String(WATCH_VERSION));
    } catch {}
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try { localStorage.setItem("cockpit_watch", JSON.stringify(syms)); } catch {}
  }, [syms]);

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
            const chgCls = chg == null ? "muted" : dn ? "down" : "up";
            return (
              <tr key={s}>
                <td style={{ textAlign: "left", fontWeight: 600, cursor: "pointer" }} onClick={() => onPick(s)}>{s}</td>
                <td>{f2(q.last)}</td>
                <td className={chgCls}>{q.change != null ? (dn ? "" : "+") + f2(q.change) : "—"}</td>
                <td className={chgCls}>{q.change_percentage != null ? (dn ? "" : "+") + Number(q.change_percentage).toFixed(2) + "%" : "—"}</td>
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
// Bid×Ask pair with a liquidity underline: dotted = spread >4% of mid, solid = >8% or no bid
function SpreadCell({ o, onBuy, onSell }) {
  const p = spreadPct(o);
  const flag = spreadFlag(p);
  const cls = flag === "bad" ? "sp-bad" : flag === "wide" ? "sp-wide" : "";
  const tip = p != null ? `spread ${(p * 100).toFixed(1)}% of mid — ${spreadRead(flag)}` : `no bid — ${spreadRead(flag)}`;
  return (
    <span className={cls} title={flag === "ok" ? undefined : tip}>
      <button className="chip" style={{ padding: "2px 6px" }} onClick={onBuy}>{f2(o.bid)}</button>
      ×
      <button className="chip" style={{ padding: "2px 6px" }} onClick={onSell}>{f2(o.ask)}</button>
    </span>
  );
}

function ChainRisk({ symbol, setSymbol }) {
  const [input, setInput] = useState(symbol || "");
  const [loadedSym, setLoadedSym] = useState("");
  const [exps, setExps] = useState([]);
  const [exp, setExp] = useState("");
  const [chain, setChain] = useState([]);
  const [spot, setSpot] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [legs, setLegs] = useState([]);
  const [userMove, setUserMove] = useState("");
  const [ivInfo, setIvInfo] = useState(null);
  const [hv, setHv] = useState(null);          // { hv20, hv60 } realized vol
  const [autoEvents, setAutoEvents] = useState([]); // earnings + macro from FMP
  const [street, setStreet] = useState(null);  // analyst target consensus
  const [events, setEvents] = useState({});
  const [evLabel, setEvLabel] = useState("");
  const [evDate, setEvDate] = useState("");
  const evHydrated = useRef(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cockpit_events"));
      if (saved && typeof saved === "object") setEvents(saved);
    } catch {}
    evHydrated.current = true;
  }, []);
  useEffect(() => {
    if (!evHydrated.current) return;
    try { localStorage.setItem("cockpit_events", JSON.stringify(events)); } catch {}
  }, [events]);

  useEffect(() => {
    if (symbol && symbol !== loadedSym) { setInput(symbol); loadExp(symbol); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, loadedSym]);

  async function loadExp(sym) {
    setErr(""); setChain([]); setExp(""); setLoadedSym(sym);
    setIvInfo(null); setHv(null); setAutoEvents([]); setStreet(null);
    try {
      const [e, q] = await Promise.all([
        getJSON(`/api/expirations?symbol=${sym}`),
        getJSON(`/api/quote?symbols=${sym}`),
      ]);
      const spotVal = q.quotes[0]?.last ?? null;
      setExps(e.expirations); setSpot(spotVal);
      if (e.expirations[0]) loadChain(sym, e.expirations[0]);
      snapshotIv(sym, e.expirations, spotVal);
      loadContext(sym);
    } catch (er) { setErr(er.message); }
  }

  // Context fetches — each degrades independently; none blocks the chain.
  function loadContext(sym) {
    getJSON(`/api/history?symbol=${sym}&days=160`)
      .then((h) => setHv({ hv20: realizedVol(h.closes, 20), hv60: realizedVol(h.closes, 60) }))
      .catch(() => {});
    getJSON(`/api/events?symbol=${sym}`)
      .then((d) => setAutoEvents(d.events || []))
      .catch(() => {});
    getJSON(`/api/analyst?symbol=${sym}`)
      .then((d) => setStreet(d.available ? d : null))
      .catch(() => {});
  }

  // IV snapshot from the nearest monthly expiration; history in localStorage → IV Rank
  async function snapshotIv(sym, expsList, spotVal) {
    try {
      const mExp = nearestMonthly(expsList);
      if (!mExp || spotVal == null) return;
      const d = await getJSON(`/api/chain?symbol=${sym}&expiration=${mExp}`);
      const snap = ivSnapshot(toRows(d.options), spotVal);
      if (snap == null) return;
      let prior = [];
      try {
        const store = JSON.parse(localStorage.getItem("iv_history") || "{}");
        prior = (store[sym] || []).filter((h) => h.date !== todayStr());
        store[sym] = [...prior, { date: todayStr(), iv: snap }].slice(-250);
        localStorage.setItem("iv_history", JSON.stringify(store));
      } catch {}
      const { rank, n } = ivRank(prior, snap);
      setIvInfo({ snap, rank, n, monthly: mExp });
    } catch {}
  }
  async function loadChain(sym, expiration) {
    setExp(expiration); setLoading(true); setErr("");
    try { const d = await getJSON(`/api/chain?symbol=${sym}&expiration=${expiration}`); setChain(d.options); }
    catch (er) { setErr(er.message); } finally { setLoading(false); }
  }

  const strikes = useMemo(() => toRows(chain), [chain]);
  const em = useMemo(() => expectedMove(strikes, spot), [strikes, spot]);
  const walls = useMemo(() => oiWalls(strikes), [strikes]);
  const verdict = em && userMove !== "" ? moveVerdict(parseFloat(userMove), em.emPct * 100) : null;

  const symEvents = events[loadedSym] || [];
  const allEvents = [...autoEvents, ...symEvents];
  const heldThrough = legs.length > 0 && exp ? eventsHeldThrough(allEvents, exp) : [];
  const addEvent = () => {
    if (!evLabel.trim() || !evDate || !loadedSym) return;
    setEvents((ev) => ({ ...ev, [loadedSym]: [...(ev[loadedSym] || []), { label: evLabel.trim(), date: evDate }].sort((a, b) => a.date < b.date ? -1 : 1) }));
    setEvLabel(""); setEvDate("");
  };
  const removeEvent = (i) => setEvents((ev) => ({ ...ev, [loadedSym]: symEvents.filter((_, j) => j !== i) }));

  const addLeg = (o, action) => {
    const mid = o.bid != null && o.ask != null ? ((Number(o.bid) + Number(o.ask)) / 2) : Number(o.last || 0);
    setLegs((ls) => [...ls, { action, type: o.type, strike: String(o.strike), premium: mid.toFixed(2), qty: 1, bid: o.bid, ask: o.ask }]);
  };
  const a = useMemo(() => analyze(legs), [legs]);
  // worst bid–ask spread across legs (display-side; the order gate re-checks live server-side)
  const worstLegSpread = useMemo(() => {
    const ps = legs.map((l) => spreadPct(l));
    if (!ps.length) return null;
    if (ps.some((p) => p == null)) return { p: null, flag: "bad" };
    const p = Math.max(...ps);
    return { p, flag: spreadFlag(p) };
  }, [legs]);
  const ivhv = ivInfo && hv?.hv20 ? ivHvRead(ivInfo.snap, hv.hv20) : null;

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
        {street && spot != null && (
          <div className="mono muted" style={{ fontSize: 12, marginTop: 8 }}>
            Street 12-mo target: <b>${f2(street.median ?? street.consensus)}</b> (range ${f2(street.low)}–${f2(street.high)})
            {" · "}{((((street.median ?? street.consensus) - spot) / spot) * 100).toFixed(1)}% vs spot
            <span className="muted"> — analyst consensus, context not signal</span>
          </div>
        )}
        {exps.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <span className="label">Expiration</span>
            <select className="sel" value={exp} onChange={(e) => loadChain(loadedSym, e.target.value)} style={{ width: "100%", maxWidth: 260 }}>
              {exps.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}
      </div>

      {err && <div className="err">{err}</div>}

      {em && exp && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span className="label" style={{ margin: 0 }}>Expected move · straddle-implied</span>
            {ivInfo && (
              <span className="badge">
                IV snapshot: {(ivInfo.snap * 100).toFixed(1)}%{" · "}
                {ivInfo.rank != null
                  ? <>IV Rank: {ivInfo.rank.toFixed(0)} ({ivRankRead(ivInfo.rank)})</>
                  : <>IV Rank: n/a — building history ({ivInfo.n} day{ivInfo.n === 1 ? "" : "s"})</>}
              </span>
            )}
          </div>
          <div style={{ fontFamily: "var(--serif)", fontSize: 22, margin: "10px 0 4px" }}>
            Market implies <b>±${em.em.toFixed(2)}</b> (±{(em.emPct * 100).toFixed(1)}%) by {exp}
          </div>
          <div className="mono muted" style={{ fontSize: 12.5 }}>
            Implied range: ${em.low.toFixed(2)} … ${em.high.toFixed(2)} · ATM strike {em.atmStrike}
          </div>
          {hv && (hv.hv20 || hv.hv60) && (
            <div className="mono" style={{ fontSize: 12.5, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              Realized vol: {hv.hv20 ? <>HV20 <b>{(hv.hv20 * 100).toFixed(1)}%</b></> : null}
              {hv.hv20 && hv.hv60 ? " · " : null}
              {hv.hv60 ? <>HV60 <b>{(hv.hv60 * 100).toFixed(1)}%</b></> : null}
              {ivInfo && <> · IV <b>{(ivInfo.snap * 100).toFixed(1)}%</b></>}
              {ivhv && (
                <span className={ivhv.tone === "sell" ? "down" : ivhv.tone === "buy" ? "up" : "muted"} style={{ fontWeight: 600 }}>
                  {" "}— IV/HV20 {ivhv.ratio.toFixed(2)}: {ivhv.text}
                </span>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
            <span className="mono" style={{ fontSize: 12.5 }}>Your expected move %:</span>
            <input className="in" style={{ width: 80 }} placeholder="e.g. 5" inputMode="decimal"
              value={userMove} onChange={(e) => setUserMove(e.target.value.replace(/[^0-9.]/g, ""))} />
            {verdict && (
              <span className={verdict.tone === "bull" ? "up" : verdict.tone === "bear" ? "down" : "muted"}
                style={{ fontSize: 13, fontWeight: 600 }}>{verdict.text}</span>
            )}
          </div>
          {walls && (
            <div className="mono" style={{ fontSize: 12.5, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              {walls.callWall && <>Call wall <b>{walls.callWall.strike}</b> (OI {walls.callWall.oi.toLocaleString()})</>}
              {walls.callWall && walls.putWall && " · "}
              {walls.putWall && <>Put wall <b>{walls.putWall.strike}</b> (OI {walls.putWall.oi.toLocaleString()})</>}
              {walls.pc != null && <> · P/C {walls.pc.toFixed(2)} <span className="muted">— {walls.note}</span></>}
            </div>
          )}
        </div>
      )}

      {heldThrough.map((ev) => (
        <div className="warn" key={ev.label + ev.date}>
          ⚠ You are holding through {ev.label} in {daysUntil(ev.date)} day{daysUntil(ev.date) === 1 ? "" : "s"} — expect IV crush after.
        </div>
      ))}

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
          {worstLegSpread && worstLegSpread.flag !== "ok" && (
            <div className="mono" style={{ fontSize: 12.5, color: "#7A5C15", padding: "8px 0" }}>
              ⚠ Liquidity: worst leg spread {worstLegSpread.p != null ? (worstLegSpread.p * 100).toFixed(1) + "% of mid" : "no bid — unquotable"} — {spreadRead(worstLegSpread.flag)}.
            </div>
          )}
          <div className="metrics" style={{ marginTop: 14 }}>
            <div className="metric"><div className="k">Max profit</div><div className="v" style={{ color: a.unlimitedProfit ? "var(--bull)" : "var(--ink)" }}>{money(a.maxP)}</div></div>
            <div className="metric"><div className="k">Max loss</div><div className="v" style={{ color: a.unlimitedLoss ? "var(--bear)" : "var(--ink)" }}>{money(a.maxL)}</div></div>
            <div className="metric"><div className="k">Breakeven</div><div className="v">{a.bes.length ? a.bes.map((b) => "$" + b.toFixed(2)).join(" / ") : "—"}</div></div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
            <span>{a.net >= 0 ? "Net debit: " : "Net credit: "}<b style={{ color: "var(--ink)" }}>{money(Math.abs(a.net))}</b></span>
            {a.rr != null && <span>Risk/reward 1 : {a.rr.toFixed(2)}</span>}
            <button className="chip" onClick={() => setLegs([])}>clear</button>
          </div>
        </div>
      )}

      {loadedSym && (
        <div className="card">
          <span className="label">Event risk · {loadedSym} · earnings &amp; high-impact macro auto-fetched (FMP) — add your own below</span>
          {autoEvents.map((ev) => (
            <div className="leg" key={"auto" + ev.label + ev.date}>
              <span>
                <b>{ev.label}</b> · {ev.date} ·{" "}
                <span className={daysUntil(ev.date) < 0 ? "muted" : "mono"}>
                  {daysUntil(ev.date) < 0 ? "past" : daysUntil(ev.date) === 0 ? "today" : `in ${daysUntil(ev.date)} day${daysUntil(ev.date) === 1 ? "" : "s"}`}
                </span>
              </span>
              <span className="badge" style={{ fontSize: 10, padding: "2px 6px" }}>{ev.kind === "earnings" ? "auto · earnings" : "auto · macro"}</span>
            </div>
          ))}
          {symEvents.map((ev, i) => (
            <div className="leg" key={ev.label + ev.date}>
              <span>
                <b>{ev.label}</b> · {ev.date} ·{" "}
                <span className={daysUntil(ev.date) < 0 ? "muted" : "mono"}>
                  {daysUntil(ev.date) < 0 ? "past" : daysUntil(ev.date) === 0 ? "today" : `in ${daysUntil(ev.date)} day${daysUntil(ev.date) === 1 ? "" : "s"}`}
                </span>
              </span>
              <button className="x" onClick={() => removeEvent(i)}>×</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <input className="in" style={{ width: 160 }} placeholder="Event (e.g. Earnings)" value={evLabel}
              onChange={(e) => setEvLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addEvent()} />
            <input className="in" type="date" value={evDate} onChange={(e) => setEvDate(e.target.value)} />
            <button className="chip" onClick={addEvent}>+ add event</button>
          </div>
        </div>
      )}

      {loading && <div className="card muted">Loading chain…</div>}

      {strikes.length > 0 && (
        <div className="card" style={{ overflowX: "auto" }}>
          <span className="label">Chain · {exp} · tap a price to add a leg (buy)/(sell) · underline = wide spread (dotted &gt;4%, solid &gt;8% of mid)</span>
          <table>
            <thead><tr>
              <th>C Δ</th><th>C IV</th><th>C OI</th><th>C Bid×Ask</th>
              <th className="strike-col">Strike</th>
              <th>P Bid×Ask</th><th>P OI</th><th>P IV</th><th>P Δ</th>
            </tr></thead>
            <tbody>
              {strikes.map((r) => {
                const atm = spot != null && Math.abs(r.strike - spot) <= (strikes[1]?.strike - strikes[0]?.strike || 5) / 2;
                const cWall = walls?.callWall?.strike === r.strike, pWall = walls?.putWall?.strike === r.strike;
                return (
                  <tr key={r.strike} className={atm ? "atm" : ""}>
                    <td>{f2(r.call?.delta)}</td><td>{pct(r.call?.iv)}</td><td className={cWall ? "wall" : "muted"}>{r.call?.oi ?? "—"}</td>
                    <td>{r.call ? <SpreadCell o={r.call} onBuy={() => addLeg(r.call, "buy")} onSell={() => addLeg(r.call, "sell")} /> : "—"}</td>
                    <td className="strike-col">{r.strike}</td>
                    <td>{r.put ? <SpreadCell o={r.put} onBuy={() => addLeg(r.put, "buy")} onSell={() => addLeg(r.put, "sell")} /> : "—"}</td>
                    <td className={pWall ? "wall" : "muted"}>{r.put?.oi ?? "—"}</td><td>{pct(r.put?.iv)}</td><td>{f2(r.put?.delta)}</td>
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

function Ideas() {
  const [suggestions, setSuggestions] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  async function load() {
    setLoading(true);
    try {
      let syms = DEFAULT_SYMS;
      try {
        const saved = JSON.parse(localStorage.getItem("cockpit_watch"));
        if (Array.isArray(saved) && saved.length) syms = saved;
      } catch {}
      const d = await getJSON(`/api/suggestions?symbols=${syms.join(",")}`);
      setSuggestions(d.suggestions);
      setErr("");
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}><span className="live" />Ideas · refreshes every 60s</span>
        <button className="btn" onClick={load} disabled={loading}>{loading ? "Loading..." : "Refresh"}</button>
      </div>
      {err && <div className="err">{err}</div>}
      {suggestions && (
        <div style={{ fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.8", whiteSpace: "pre-wrap", color: "var(--ink)" }}>
          {suggestions}
        </div>
      )}
      {!suggestions && !loading && <div className="muted">Click Refresh to get trading ideas from Claude AI</div>}
    </div>
  );
}

export default function Page() {
  const [tab, setTab] = useState("watch");
  const [symbol, setSymbol] = useState("");
  const [status, setStatus] = useState(null);
  const pick = (s) => { setSymbol(s); setTab("chain"); };

  useEffect(() => {
    getJSON("/api/status").then(setStatus).catch(() => {});
  }, []);

  return (
    <div className="wrap">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span className="eyebrow">Options Desk · Live Cockpit</span>
        {status && (
          <span style={{ display: "flex", gap: 6 }}>
            <span className={"badge " + (status.data === "realtime" ? "stat-rt" : "stat-delay")}
              title={status.data === "realtime" ? "Production Tradier — real-time quotes" : "Sandbox Tradier — quotes are ~15 min delayed. Set TRADIER_TOKEN (production) for real-time."}>
              {status.data === "realtime" ? "● DATA: REALTIME" : "● DATA: DELAYED (sandbox)"}
            </span>
            <span className="badge" title="Order routes are hard-locked to the Tradier sandbox — staged orders never touch real money.">
              ORDERS: PAPER
            </span>
          </span>
        )}
      </div>
      <h1>The Cockpit</h1>
      <p className="sub">Live quotes and chains from your Tradier account, with defined-risk math built in.</p>
      <div className="tabs">
        <button className={"tab" + (tab === "watch" ? " on" : "")} onClick={() => setTab("watch")}>Watchlist</button>
        <button className={"tab" + (tab === "chain" ? " on" : "")} onClick={() => setTab("chain")}>Chain &amp; Risk</button>
        <button className={"tab" + (tab === "div" ? " on" : "")} onClick={() => setTab("div")}>Divergence</button>
        <button className={"tab" + (tab === "journal" ? " on" : "")} onClick={() => setTab("journal")}>Journal</button>
        <button className={"tab" + (tab === "ideas" ? " on" : "")} onClick={() => setTab("ideas")}>Ideas</button>
      </div>
      {tab === "watch" && <Watchlist onPick={pick} />}
      {tab === "chain" && <ChainRisk symbol={symbol} setSymbol={setSymbol} />}
      {tab === "div" && <Divergence />}
      {tab === "journal" && <Journal />}
      {tab === "ideas" && <Ideas />}
      <div className="foot">
        Informational only — not financial advice. Real-time data requires a funded Tradier brokerage account; without one the feed is delayed.
        Risk figures assume holding to expiration and ignore commissions, assignment, and slippage — confirm in your broker before trading.
        Your token stays server-side and is never sent to the browser. AI suggestions are educational only and not investment advice.
      </div>
    </div>
  );
}
