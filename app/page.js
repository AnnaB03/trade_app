"use client";
import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from "react";
import {
  analyze, toRows, expectedMove, ivSnapshot, ivRank, ivRankRead, nearestMonthly,
  oiWalls, todayStr, daysUntil, eventsHeldThrough,
  spreadPct, spreadFlag, spreadRead, realizedVol, ivHvRead,
} from "./lib/metrics";
import Journal from "./components/Journal";
import TrackRecord from "./components/TrackRecord";
import NewsBoard from "./components/NewsBoard";
import { buildOptionStopEstimate } from "./lib/orders";

// Account size the Ideas engine sizes for — per browser, editable in the
// Ideas header; the server falls back to ACCOUNT_SIZE, then $1,000.
const readAccount = () => {
  try { const v = Number(localStorage.getItem("cockpit_account")); if (v > 0) return v; } catch {}
  return 1000;
};

const money = (v) => v === Infinity ? "Unlimited ▲" : v === -Infinity ? "UNLIMITED" :
  (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(Math.abs(v) >= 1000 ? 0 : 2);
// For a max_loss/max_profit figure that came back over JSON: null there is
// ambiguous (it means either "not computed" or "genuinely uncapped" — the
// server can't send a literal Infinity through JSON), so an explicit
// unlimited flag settles it instead of guessing from the number alone.
const moneyU = (v, unlimited) => unlimited ? "Unlimited" : money(v);
const pct = (v) => v == null ? "—" : (v * 100).toFixed(1) + "%";
const f2 = (v) => v == null || v === "" ? "—" : Number(v).toFixed(2);

/* ---------- data hooks ---------- */
async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

/* Market clock: { state, description } refreshed every 5 min.
   state "unknown" (clock unavailable) is treated as open everywhere so a clock
   outage never freezes quotes or ideas. */
function useMarketClock() {
  const [clock, setClock] = useState(null);
  useEffect(() => {
    let on = true;
    const load = () => getJSON("/api/clock").then((d) => { if (on) setClock(d); }).catch(() => {});
    load();
    const t = setInterval(load, 300000);
    return () => { on = false; clearInterval(t); };
  }, []);
  return clock;
}
const marketClosed = (clock) => clock != null && clock.state !== "open" && clock.state !== "unknown";

/* ---------- watchlist ---------- */
const DEFAULT_SYMS = ["SPY", "SPX", "QQQ", "NVDA", "TSLA", "AMD"];
// Symbols added to DEFAULT_SYMS after launch, tagged with the version that introduced
// them. Each is merged into an already-saved watchlist exactly once, so new defaults
// reach existing users without resurrecting symbols they deliberately deleted.
// When adding another, append it here and bump WATCH_VERSION to match.
const WATCH_VERSION = 1;
const ADDED_SYMS = [{ v: 1, sym: "SPX" }];

/* The three checks that separate a real move from a trap, per symbol:
   volume reality (RVOL + float rotation), whether news justifies the move
   (catalyst type + freshness), and where LULD halt bands sit. */
function RealityPanel({ data, symbol }) {
  if (data === undefined) return <span className="muted mono" style={{ fontSize: 12.5 }}>Checking {symbol}…</span>;
  if (!data || data.unavailable) {
    return (
      <span className="muted mono" style={{ fontSize: 12.5 }}>
        No reality check for {symbol} — {data?.reason || "unavailable"}.
        {" "}Index symbols (SPX) have no company profile, float, or share volume to check.
      </span>
    );
  }
  const { volume: v, news: n, halt: h } = data;
  const toneCls = (t) => t === "warn" ? "down" : t === "ok" || t === "strong" ? "up" : t === "weak" ? "down" : "muted";
  const Row = ({ label, children }) => (
    <div style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: 10, padding: "6px 0", alignItems: "baseline" }}>
      <span className="label" style={{ margin: 0 }}>{label}</span>
      <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
  return (
    <div>
      <Row label="Volume">
        <span className={toneCls(v.read.tone)} style={{ fontWeight: 600 }}>{v.read.text}</span>
        <div className="muted">
          {v.today != null && v.average != null
            ? `${Number(v.today).toLocaleString()} today vs ${Number(v.average).toLocaleString()} average`
            : "share counts unavailable"}
          {v.rotation != null && <> · {(v.rotation * 100).toFixed(0)}% of float traded{v.rotation >= 1 ? " — full float rotation, classic squeeze signature" : ""}</>}
        </div>
      </Row>
      <Row label="News">
        <span className={toneCls(n.verdict.tone)} style={{ fontWeight: 600 }}>{n.verdict.text}</span>
        {n.headline && (
          <div className="muted" style={{ marginTop: 2 }}>
            “{n.headline.title}” — {n.headline.site}
          </div>
        )}
      </Row>
      {h && (
        <Row label="Halt bands">
          <span>
            Trading pauses if it hits <b className="down">${h.down.toFixed(2)}</b> or <b className="up">${h.up.toFixed(2)}</b>
            {" "}(±{(h.pct * 100).toFixed(0)}%, Tier {h.tier}{h.doubled ? ", doubled window" : ""})
          </span>
          <div className="muted">
            Indicative: the official band tracks a rolling 5-min average price, not the last trade. Tier estimated from market cap.
            {" "}You cannot exit during a halt. {h.note}
          </div>
        </Row>
      )}
      <div className="muted mono" style={{ fontSize: 11.5, marginTop: 6, opacity: 0.8 }}>
        Volume and % move are regular-session figures — in pre/post-market they lag the extended tape shown above.
      </div>
    </div>
  );
}

/* Penny stocks ($0.10-$5) get their own card, not folded into Top Movers,
   because they're a different risk category rather than just "cheaper
   stocks" — thin float, wide spreads, promotion/pump-and-dump patterns, and
   dilution (a company selling new shares into its own rally) dominate here
   more than direction does. Every candidate is run through the same reality
   check (RVOL, catalyst classification, halt bands) shown on the Watchlist,
   reused via RealityPanel — this is exactly the context that separates a
   real move from a promoted one. */
function PennyStocks({ onPick }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let on = true;
    const load = () => getJSON("/api/penny")
      .then((d) => { if (on) { setData(d); setErr(""); } })
      .catch((e) => { if (on) setErr(e.message); });
    load();
    const t = setInterval(load, 300000);
    return () => { on = false; clearInterval(t); };
  }, []);

  if (!data || !data.available || !data.candidates.length) return null;

  return (
    <div className="card">
      <span className="label">Penny stocks · today's $0.10–$5 movers, reality-checked before anything else</span>
      <div className="warn" style={{ marginBottom: 4, fontSize: 12.5 }}>
        A different risk category, not just "cheaper stocks": thin float, wide spreads, promotion / pump-and-dump patterns, and
        dilution (a company selling new shares into its own rally) are the dominant risks here — more than direction. Most of
        these have no usable options chain; treat any idea as shares only, small size, with a hard stop.
      </div>
      {err && <div className="err">{err}</div>}
      {data.candidates.map((c) => (
        <div key={c.symbol} style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 13 }}>
            <button className="chip" style={{ padding: "2px 8px", fontWeight: 700 }} onClick={() => onPick(c.symbol)}>{c.symbol}</button>
            <span className={c.changePct >= 0 ? "up" : "down"} style={{ fontWeight: 600 }}>
              {c.changePct >= 0 ? "+" : ""}{c.changePct?.toFixed(1)}%
            </span>
            <span className="muted">${f2(c.price)} · {c.name?.slice(0, 40)}</span>
          </div>
          <div style={{ marginTop: 6 }}>
            <RealityPanel data={c} symbol={c.symbol} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* What moved since the close: last pre/post-market trade per symbol (Tradier
   extended-session timesales) + fresh headlines (FMP). Shown only outside
   regular hours — this is where Monday's gaps come from. */
function OvernightBrief({ syms }) {
  const [ext, setExt] = useState([]);
  const [news, setNews] = useState([]);
  const [cal, setCal] = useState(null); // today's macro + upcoming earnings
  const list = syms.slice(0, 10).join(",");

  useEffect(() => {
    if (!list) return;
    let on = true;
    const load = () => {
      getJSON(`/api/overnight?symbols=${list}`).then((d) => { if (on) setExt(d.quotes || []); }).catch(() => {});
      getJSON(`/api/news?symbols=${list}&limit=2`).then((d) => { if (on) setNews(d.articles || []); }).catch(() => {});
      getJSON(`/api/today?symbols=${list}`).then((d) => { if (on) setCal(d.available ? d : null); }).catch(() => {});
    };
    load();
    const t = setInterval(load, 300000);
    return () => { on = false; clearInterval(t); };
  }, [list]);

  if (!list) return null;
  const calItems = cal ? [
    ...cal.earnings.map((e) => ({ key: "e" + e.symbol + e.date, hot: e.when === "today", text: `${e.symbol} earnings ${e.when}` })),
    ...cal.macro.map((m) => ({ key: "m" + m.label, hot: true, text: `${m.label}${m.timeET ? ` · ${m.timeET} ET` : ""}` })),
  ] : [];
  return (
    <div className="card">
      <span className="label">Overnight brief · extended-hours moves &amp; news since the close — this is where opening gaps come from</span>
      {calItems.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", padding: "2px 0 10px", borderBottom: "1px solid var(--line)", marginBottom: 4 }}>
          <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>On the calendar:</span>
          {calItems.map((c) => (
            <span key={c.key} className="badge" style={c.hot ? { color: "#7A5C15", borderColor: "rgba(163,120,32,.5)", fontWeight: 600 } : undefined}>
              {c.text}
            </span>
          ))}
        </div>
      )}
      {syms.slice(0, 10).map((s) => {
        const e = ext.find((x) => x.symbol === s);
        const arts = news.filter((a) => a.symbol === s).slice(0, 2);
        const chg = e?.extChangePct;
        const moved = chg != null && Math.abs(chg) >= 0.05;
        return (
          <div key={s} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 13 }}>
              <b style={{ cursor: "default" }}>{s}</b>
              {e?.ext != null ? (
                <span>
                  ext ${f2(e.ext)}{" "}
                  <span className={moved ? (chg < 0 ? "down" : "up") : "muted"} style={moved ? { fontWeight: 600 } : undefined}>
                    {chg != null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% vs close` : ""}
                  </span>
                </span>
              ) : (
                <span className="muted">no extended-hours trades</span>
              )}
            </div>
            {arts.map((a) => (
              <div key={a.url || a.title} className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                “{a.title}” <span style={{ opacity: 0.7 }}>— {a.site}{a.publishedDate ? `, ${String(a.publishedDate).slice(0, 16)}` : ""}</span>
              </div>
            ))}
            {!arts.length && <div className="muted" style={{ fontSize: 12, marginTop: 3, opacity: 0.7 }}>no fresh headlines</div>}
          </div>
        );
      })}
    </div>
  );
}

function Watchlist({ onPick }) {
  const [syms, setSyms] = useState(DEFAULT_SYMS);
  const [quotes, setQuotes] = useState([]);
  const [err, setErr] = useState("");
  const [add, setAdd] = useState("");
  const [reality, setReality] = useState({}); // symbol → reality check payload
  const [openSym, setOpenSym] = useState(null); // expanded reality panel
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

  // Reality checks (volume / news / halt bands) per symbol, refreshed every
  // 5 min. Server-cached 2 min; one call per symbol since FMP's batch quote
  // endpoints need a higher plan tier.
  const symKey = syms.join(",");
  useEffect(() => {
    if (!syms.length) return;
    let on = true;
    const load = () => {
      syms.slice(0, 12).forEach((s) => {
        getJSON(`/api/reality?symbol=${s}`)
          .then((d) => { if (on) setReality((m) => ({ ...m, [s]: d.available ? d : { unavailable: true, reason: d.reason } })); })
          .catch(() => {});
      });
    };
    load();
    const t = setInterval(load, 300000);
    return () => { on = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symKey]);

  const clock = useMarketClock();
  const closed = marketClosed(clock);

  // Poll only while the market can move prices. Pre/post-market still trades,
  // so only a fully closed market (weekend/holiday/overnight) pauses polling.
  useEffect(() => {
    load();
    if (clock?.state === "closed") return;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load, clock?.state]);

  return (
    <>
    <div className="card">
      {closed && (
        <div className="warn" style={{ marginBottom: 12 }}>
          {clock.state === "closed"
            ? <>Market closed — prices shown are from the last session&apos;s close{clock.description ? ` (${clock.description})` : ""}. Orders queue until the next open, and prices can gap.</>
            : <>{clock.state === "premarket" ? "Premarket" : "After hours"} — regular session closed. Stock quotes may reflect extended trading; option quotes are stale until the open.</>}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}>
          <span className="live" style={clock?.state === "closed" ? { background: "var(--faint)" } : undefined} />
          {clock?.state === "closed" ? "Market closed · polling paused" : "Live · refreshes every 30s"}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="mono muted" style={{ fontSize: 11 }} title="Every symbol here gets the full treatment (quotes, option chains, news) on every Ideas refresh — a long list is the main reason that tab loads slowly.">
            {syms.length} on list
          </span>
          <input className="in" style={{ width: 90 }} placeholder="add" value={add}
            onChange={(e) => setAdd(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter" && add.trim()) { setSyms([...new Set([...syms, add.trim()])]); setAdd(""); } }} />
          {syms.length > DEFAULT_SYMS.length && (
            <button className="chip" title={`Back to the base list: ${DEFAULT_SYMS.join(", ")}`}
              onClick={() => { if (confirm(`Reset watchlist to the base ${DEFAULT_SYMS.length} symbols (${DEFAULT_SYMS.join(", ")})? This removes everything you've added.`)) setSyms(DEFAULT_SYMS); }}>
              Reset to base list
            </button>
          )}
        </div>
      </div>
      {syms.length > DEFAULT_SYMS.length + 6 && (
        <div className="warn" style={{ marginBottom: 10, fontSize: 12.5 }}>
          {syms.length} symbols on your watchlist — every one of them is fully re-scanned on each Ideas refresh, which is the main cause of a slow load. Trim symbols you're done watching, or use &quot;Reset to base list&quot; above.
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <table>
        <thead><tr>
          <th style={{ textAlign: "left" }}>Symbol</th><th>Last</th><th>Chg</th><th>Chg %</th>
          <th>Bid</th><th>Ask</th><th>Vol</th>
          <th title="Relative volume: today's volume vs its average. Under 1× means thinner than normal.">RVOL</th>
          <th></th>
        </tr></thead>
        <tbody>
          {syms.map((s) => {
            const q = quotes.find((x) => x.symbol === s) || {};
            const chg = q.change, dn = chg < 0;
            const chgCls = chg == null ? "muted" : dn ? "down" : "up";
            const rc = reality[s], rv = rc?.volume?.rvol ?? null, isOpen = openSym === s;
            return (
              <Fragment key={s}>
              <tr>
                <td style={{ textAlign: "left", fontWeight: 600, cursor: "pointer" }} onClick={() => onPick(s)}>{s}</td>
                <td>{f2(q.last)}</td>
                <td className={chgCls}>{q.change != null ? (dn ? "" : "+") + f2(q.change) : "—"}</td>
                <td className={chgCls}>{q.change_percentage != null ? (dn ? "" : "+") + Number(q.change_percentage).toFixed(2) + "%" : "—"}</td>
                <td className="muted">{f2(q.bid)}</td><td className="muted">{f2(q.ask)}</td>
                <td className="muted">{q.volume ? Number(q.volume).toLocaleString() : "—"}</td>
                <td className={rv == null ? "muted" : rv >= 2 ? "up" : rv < 1 ? "down" : ""} style={rv != null ? { fontWeight: 600 } : undefined}>
                  {rv != null ? rv.toFixed(1) + "×" : "—"}
                </td>
                <td>
                  <button className="chip" onClick={() => setOpenSym(isOpen ? null : s)}
                    title="Reality check: is the volume real, does news justify the move, where are the halt bands">
                    {isOpen ? "hide" : "check"}
                  </button>
                  <button className="chip" onClick={() => onPick(s)}>chain →</button>
                  <button className="x" onClick={() => setSyms(syms.filter((x) => x !== s))}>×</button>
                </td>
              </tr>
              {isOpen && (
                <tr key={s + "-rc"}>
                  <td colSpan={9} style={{ textAlign: "left", background: "var(--paper)", padding: "12px 10px" }}>
                    <RealityPanel data={rc} symbol={s} />
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
    <PennyStocks onPick={onPick} />
    {closed && <OvernightBrief syms={syms} />}
    </>
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

const RISK_COLOR = { LOW: "var(--bull)", MEDIUM: "#7A5C15", HIGH: "var(--bear)" };
const CONVICTION_DOTS = (n) => "●".repeat(Math.max(0, Math.min(5, n || 0))) + "○".repeat(5 - Math.max(0, Math.min(5, n || 0)));

// Shared preview → send-to-Tradier status/controls, driven by the calling
// component's own state machine. Two explicit steps always, because "Stage"
// alone (a Tradier preview) never creates an order Tradier will show you
// anywhere — that confused more than one person. Preview first (no side
// effect at all), then a separate click actually sends the order into the
// Tradier sandbox account.
function OrderFlowStatus({ status, msg, previewLabel, onPreview, onConfirmPreview, onPlace, onConfirmPlace, onDiscard }) {
  if (status === "placed") return <div className="safe" style={{ marginTop: 8, fontSize: 12.5, padding: "8px 10px" }}>✓ {msg}</div>;
  if (status === "needs_ack_preview") {
    return (
      <div className="warn" style={{ marginTop: 8, fontSize: 12.5, padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>{msg}</span>
        <button className="chip" onClick={onConfirmPreview}>Confirm &amp; preview</button>
      </div>
    );
  }
  if (status === "needs_ack_place") {
    return (
      <div className="warn" style={{ marginTop: 8, fontSize: 12.5, padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>{msg}</span>
        <button className="chip" onClick={onConfirmPlace}>Confirm &amp; send to Tradier</button>
      </div>
    );
  }
  if (status === "previewed") {
    return (
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="mono muted" style={{ fontSize: 12 }}>{msg}</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="chip" onClick={onPlace} disabled={status === "placing"}>
            {status === "placing" ? "Sending…" : "Send to Tradier (paper)"}
          </button>
          <button className="chip" onClick={onDiscard}>Discard</button>
        </div>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      <button className="chip" onClick={onPreview} disabled={status === "previewing"}>
        {status === "previewing" ? "Checking risk…" : previewLabel}
      </button>
      {status === "error" && <div className="err" style={{ marginTop: 6, fontSize: 12.5 }}>{msg}</div>}
    </div>
  );
}

// OPTION ideas: single long call/put, qty 1 contract, using the contract the
// suggestions route already resolved to a real OCC symbol + live bid/ask.
async function submitLegOrder(url, idea, ack = {}, stopPrice = null) {
  const leg = idea.leg;
  if (!leg?.occ) throw new Error("No resolved contract for this idea.");
  const body = {
    legs: [{ action: "buy", type: idea.action === "CALL" ? "call" : "put", strike: String(leg.strike), premium: String(leg.mid ?? leg.ask ?? 0), qty: 1, occ: leg.occ }],
    closing: false,
    ideaId: idea.id ?? null, // links the journal entry back to this idea's full plan/context
    ...(stopPrice > 0 ? { stop: { price: stopPrice } } : {}),
    ...ack,
  };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) {
    const err = new Error(d.error || "Request failed");
    err.needsSpreadAck = d.needs_spread_ack; err.worstSpread = d.worst_spread;
    err.needsAck = d.needs_ack; err.figure = d.figure;
    throw err;
  }
  return d;
}

function OptionStageButton({ idea }) {
  const estStop = idea.invalidation != null && idea.leg?.delta != null
    ? buildOptionStopEstimate({ entryPremium: idea.leg.mid ?? idea.leg.ask, entryUnderlying: idea.entryPrice, invalidation: idea.invalidation, delta: idea.leg.delta })
    : null;
  const [stopOn, setStopOn] = useState(false); // default OFF — see caveat text below
  const [stopPx, setStopPx] = useState(estStop != null ? estStop.toFixed(2) : "");
  const [state, setState] = useState({ status: "idle", ack: {} });
  if (idea.vehicle !== "OPTION" || !idea.leg?.occ) return null;
  const locked = state.status === "placing" || state.status === "placed";
  const activeStop = stopOn && Number(stopPx) > 0 ? Number(stopPx) : null;

  const preview = async (ack = state.ack) => {
    setState((s) => ({ ...s, status: "previewing" }));
    try {
      const d = await submitLegOrder("/api/order/stage", idea, ack, activeStop);
      const stopNote = d.computed?.stop_attached ? ` · stop-market attached at $${Number(d.computed.stop_price).toFixed(2)} premium (GTC)` : "";
      setState({ status: "previewed", ack, msg: `Preview only, nothing sent to Tradier yet — max loss ${moneyU(d.computed?.max_loss, d.computed?.unlimited_loss)} · max profit ${moneyU(d.computed?.max_profit, d.computed?.unlimited_profit)}${stopNote}` });
    } catch (e) {
      if (e.needsSpreadAck) setState({ status: "needs_ack_preview", ack, msg: `${e.message} Preview anyway?` });
      else setState({ status: "error", ack, msg: e.message });
    }
  };
  const place = async (ack = state.ack) => {
    setState((s) => ({ ...s, status: "placing" }));
    try {
      const d = await submitLegOrder("/api/order/place", idea, ack, activeStop);
      const stopNote = d.computed?.stop_attached ? ` A protective stop is resting GTC at $${Number(d.computed.stop_price).toFixed(2)} premium.` : "";
      setState({ status: "placed", ack, msg: `Sent to Tradier (paper) — order #${d.order?.id ?? "?"}, status ${d.order?.status ?? "submitted"}.${stopNote} Check the Orders tab in your Tradier sandbox account.` });
    } catch (e) {
      if (e.needsSpreadAck) setState({ status: "needs_ack_place", ack, msg: `${e.message} Send anyway?` });
      else setState({ status: "error", ack, msg: e.message });
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      {estStop != null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 6 }}>
          <label className="mono muted" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={stopOn} disabled={locked} onChange={(e) => setStopOn(e.target.checked)} />
            Attach a GTC stop-market at
            <input className="in" style={{ width: 66, padding: "2px 5px", fontSize: 12 }} inputMode="decimal" value={stopPx} disabled={locked || !stopOn}
              onChange={(e) => setStopPx(e.target.value.replace(/[^0-9.]/g, ""))} />
            premium (est.)
          </label>
          <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.4 }}>
            Estimated from the ${money(idea.invalidation)} underlying stop via this contract's delta — drifts as delta changes, and can trigger early on a stale/wide option quote even if {idea.symbol} itself never hits ${money(idea.invalidation)}. Off by default for that reason.
          </div>
        </div>
      )}
      <OrderFlowStatus status={state.status} msg={state.msg} previewLabel="Preview this idea (no order sent)"
        onPreview={() => preview()} onConfirmPreview={() => preview({ ...state.ack, ack_wide_spread: true })}
        onPlace={() => place()} onConfirmPlace={() => place({ ...state.ack, ack_wide_spread: true })}
        onDiscard={() => setState({ status: "idle", ack: {} })} />
    </div>
  );
}

// SHARES ideas: no resolved contract to default from, so the trader picks a
// quantity and limit price. Defaults to a nominal ~$500 position and the spot
// price at generation time — both editable before either button does anything.
function ShareStageButton({ idea }) {
  const entry = Number(idea.entryPrice);
  const hasInvalidation = idea.invalidation != null;
  // Default quantity comes from the server's risk-based sizing (1% of the
  // account to the stop, capped at 25% of the account) — rounded to whole
  // shares because the Tradier paper sandbox can't do fractional; on
  // Robinhood you can enter the fractional figure shown in the sizing badge.
  const sized = idea.sizing?.vehicle === "SHARES" ? idea.sizing.shares : null;
  const [qty, setQty] = useState(String(sized > 0 ? Math.max(1, Math.round(sized)) : (entry > 0 ? Math.max(1, Math.round(250 / entry)) : 10)));
  const [price, setPrice] = useState(entry > 0 ? entry.toFixed(2) : "");
  const [stopOn, setStopOn] = useState(hasInvalidation); // on by default — exact, not an estimate, unlike options
  const [stopPx, setStopPx] = useState(hasInvalidation ? Number(idea.invalidation).toFixed(2) : "");
  const [state, setState] = useState({ status: "idle", ack: {} });
  if (idea.vehicle !== "SHARES") return null;
  const locked = state.status === "placing" || state.status === "placed";
  const activeStop = stopOn && Number(stopPx) > 0 ? Number(stopPx) : null;

  const submit = async (url, ack) => {
    const body = {
      equity: {
        symbol: idea.symbol, side: idea.action === "SELL" ? "sell" : "buy", quantity: Number(qty), price: Number(price),
        stop: activeStop ?? idea.invalidation ?? undefined, attachStop: activeStop != null,
      },
      closing: false,
      ideaId: idea.id ?? null, // links the journal entry back to this idea's full plan/context
      ...ack,
    };
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Request failed");
    return d;
  };
  const preview = async () => {
    setState((s) => ({ ...s, status: "previewing" }));
    try {
      const d = await submit("/api/order/stage", {});
      const risk = d.computed?.est_risk_at_stop;
      const stopNote = d.computed?.stop_attached ? ` · GTC stop attached at $${Number(d.computed.stop_price).toFixed(2)}` : (risk != null ? ` · est. risk to stop ${money(-risk)}` : "");
      setState({ status: "previewed", msg: `Preview only, nothing sent to Tradier yet — ${qty} sh @ $${Number(price).toFixed(2)}${stopNote}` });
    } catch (e) {
      setState({ status: "error", msg: e.message });
    }
  };
  const place = async () => {
    setState((s) => ({ ...s, status: "placing" }));
    try {
      const d = await submit("/api/order/place", {});
      const stopNote = d.computed?.stop_attached ? ` A protective stop is resting GTC at $${Number(d.computed.stop_price).toFixed(2)}.` : "";
      setState({ status: "placed", msg: `Sent to Tradier (paper) — order #${d.order?.id ?? "?"}, status ${d.order?.status ?? "submitted"}.${stopNote} Check the Orders tab in your Tradier sandbox account.` });
    } catch (e) {
      setState({ status: "error", msg: e.message });
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span className="mono muted" style={{ fontSize: 12 }}>{idea.action === "SELL" ? "Short" : "Buy"}</span>
        <input className="in" style={{ width: 60, padding: "3px 6px", fontSize: 12 }} inputMode="numeric" value={qty} disabled={locked}
          onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))} />
        <span className="mono muted" style={{ fontSize: 12 }}>sh @ $</span>
        <input className="in" style={{ width: 80, padding: "3px 6px", fontSize: 12 }} inputMode="decimal" value={price} disabled={locked}
          onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="mono muted" style={{ fontSize: 12 }}>limit</span>
      </div>
      {hasInvalidation && (
        <label className="mono muted" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
          <input type="checkbox" checked={stopOn} disabled={locked} onChange={(e) => setStopOn(e.target.checked)} />
          Attach a real GTC stop at
          <input className="in" style={{ width: 70, padding: "2px 5px", fontSize: 12 }} inputMode="decimal" value={stopPx} disabled={locked || !stopOn}
            onChange={(e) => setStopPx(e.target.value.replace(/[^0-9.]/g, ""))} />
          (exact — same units as the plan's stop, recommended)
        </label>
      )}
      <OrderFlowStatus status={state.status} msg={state.msg} previewLabel="Preview this idea (no order sent)"
        onPreview={preview} onConfirmPreview={preview} onPlace={place} onConfirmPlace={place}
        onDiscard={() => setState({ status: "idle" })} />
    </div>
  );
}

function RegimeBanner() {
  const [regime, setRegime] = useState(null);
  useEffect(() => { getJSON("/api/regime").then(setRegime).catch(() => {}); }, []);
  if (!regime?.available) return null;
  const { spy, qqq, vix, rotation } = regime;
  return (
    <div className="mono muted" style={{ fontSize: 12, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid var(--line)" }}>
      Regime — SPY <span className={spy.chgPct >= 0 ? "up" : "down"}>{spy.chgPct >= 0 ? "+" : ""}{spy.chgPct?.toFixed(1)}%</span> ({spy.trend})
      {" · "}QQQ <span className={qqq.chgPct >= 0 ? "up" : "down"}>{qqq.chgPct >= 0 ? "+" : ""}{qqq.chgPct?.toFixed(1)}%</span> ({qqq.trend})
      {" · "}VIX {vix.last?.toFixed(1)} ({vix.read.split(" — ")[0]}) · {rotation}
    </div>
  );
}

// Ideas auto-refresh only at the moments the desk rulebook actually calls
// for a fresh read — never on a fixed poll: 8:30 ET (pre-market plan) and the
// two prime trading windows, 9:45 and 14:30 ET. Deliberately nothing at
// 11:00 (that's the lunch-chop "manage, don't hunt for new setups" window).
const IDEAS_SCHEDULE_ET = [8 * 60 + 30, 9 * 60 + 45, 14 * 60 + 30]; // minutes since ET midnight

function etMinutesNow(now = new Date()) {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getHours() * 60 + et.getMinutes() + et.getSeconds() / 60;
}
function msUntilNextIdeasSlot(now = new Date()) {
  const cur = etMinutesNow(now);
  const next = IDEAS_SCHEDULE_ET.find((m) => m > cur);
  const untilMinutes = next != null ? next - cur : (1440 - cur) + IDEAS_SCHEDULE_ET[0];
  return Math.max(1000, untilMinutes * 60000);
}
const IDEAS_SCHEDULE_LABEL = "8:30, 9:45 & 2:30pm ET";

// A good setup showing up at 9:47 does you no good if you see it at noon.
// Browser desktop notifications + a synthesized chime (no sound file to
// ship) are the whole mechanism — no server, no accounts, works the moment
// permission is granted. Real limits, stated plainly rather than hidden:
// this only fires while a browser tab with this app open somewhere on this
// machine is alive, and only at the existing Ideas refresh schedule
// (8:30/9:45/2:30 ET or a manual click) — there is no background process
// checking in between.
const ALERT_MIN_CONVICTION = 4;

function playAlertChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      const t0 = now + i * 0.15;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + 0.35);
    });
  } catch {}
}

function notifyGoodIdeas(ideas) {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
  const good = (ideas || []).filter((i) => i.action !== "WAIT" && Number(i.conviction) >= ALERT_MIN_CONVICTION && i.risk && i.risk !== "HIGH");
  if (!good.length) return;
  playAlertChime();
  good.slice(0, 3).forEach((idea) => {
    const body = idea.vehicle === "OPTION"
      ? `${idea.action} ${idea.leg?.strike ?? idea.strike ?? ""} ${idea.expiration ?? ""} · conviction ${idea.conviction}/5 · ${idea.risk}`
      : `${idea.action} shares · conviction ${idea.conviction}/5 · ${idea.risk}`;
    try {
      const n = new Notification(`${idea.emoji || "💡"} ${idea.symbol} — good setup`, { body, tag: idea.id });
      n.onclick = () => window.focus();
    } catch {}
  });
}

function AlertsToggle() {
  const [perm, setPerm] = useState("unsupported");
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) setPerm(Notification.permission);
  }, []);
  if (perm === "unsupported") return null;
  if (perm === "granted") return <span className="mono muted" style={{ fontSize: 11, alignSelf: "center" }} title={`Notifies for conviction ${ALERT_MIN_CONVICTION}+ / non-HIGH-risk ideas on refresh`}>🔔 Alerts on</span>;
  if (perm === "denied") return <span className="mono muted" style={{ fontSize: 11, alignSelf: "center" }} title="Blocked in this browser's site settings for this page">🔕 Alerts blocked</span>;
  return (
    <button className="chip" onClick={async () => {
      const r = await Notification.requestPermission();
      setPerm(r);
      if (r === "granted") playAlertChime();
    }}>Enable alerts 🔔</button>
  );
}

// variant "mover": actionable big mover, red — a real signal, high urgency.
// variant "flag": big mover the Cockpit is passing on (action WAIT), amber —
// worth seeing (something big happened) without reading as a buy/sell signal.
function IdeaCard({ idea, isLast, asOf, showPro, variant }) {
  const staleAt = asOf && idea.staleMinutes ? asOf + idea.staleMinutes * 60000 : null;
  const isStale = staleAt != null && Date.now() > staleAt;
  const boxed = variant != null;
  const flagStyle = { border: "1.5px solid rgba(163,120,32,.45)", borderRadius: 3, background: "rgba(163,120,32,.08)" };
  const moverStyle = { border: "1.5px solid var(--bear)", borderRadius: 3, background: "rgba(154,71,54,.07)" };
  return (
    <div style={{
      padding: boxed ? "12px" : "12px 0", margin: boxed ? "0 0 10px" : 0,
      borderBottom: boxed ? "none" : (isLast ? "none" : "1px solid var(--line)"),
      opacity: isStale ? 0.55 : 1,
      ...(variant === "mover" ? moverStyle : variant === "flag" ? flagStyle : {}),
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600 }}>
          {variant === "mover" && <span className="down" style={{ fontWeight: 700, marginRight: 6 }} title={`${idea.todayChangePct >= 0 ? "+" : ""}${idea.todayChangePct?.toFixed(0)}% today`}>🔴 BIG MOVER</span>}
          {variant === "flag" && <span style={{ fontWeight: 700, marginRight: 6, color: "#7A5C15" }} title={`${idea.todayChangePct >= 0 ? "+" : ""}${idea.todayChangePct?.toFixed(0)}% today — flagged, not a buy`}>⚠️ FLAGGED, NOT A BUY</span>}
          {idea.emoji} {idea.symbol} · {idea.action}
          {idea.vehicle === "OPTION" ? ` ${idea.leg?.strike ?? idea.strike ?? ""} ${idea.expiration ?? ""}` : idea.vehicle === "SHARES" ? " shares" : ""}
          {idea.todayChangePct != null && (
            <span className={idea.todayChangePct >= 0 ? "up" : "down"} style={{ marginLeft: 8, fontWeight: 600 }}>
              {idea.todayChangePct >= 0 ? "+" : ""}{idea.todayChangePct.toFixed(1)}% today
            </span>
          )}
        </span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {idea.conviction != null && (
            <span className="mono muted" title={`Conviction ${idea.conviction}/5`} style={{ fontSize: 11, letterSpacing: 1 }}>{CONVICTION_DOTS(idea.conviction)}</span>
          )}
          <span className="badge" style={{ color: RISK_COLOR[idea.risk] || "var(--muted)", borderColor: RISK_COLOR[idea.risk] || "var(--line)" }}>
            {idea.risk || "—"}
          </span>
        </span>
      </div>
      {idea.triggered != null && (
        <div style={{ marginTop: 5 }}>
          <span className="badge" style={idea.triggered
            ? { color: "var(--bull)", borderColor: "var(--bull)" }
            : { color: "#7A5C15", borderColor: "rgba(163,120,32,.5)" }}>
            {idea.triggered
              ? "✓ Entry condition already met — this is live, not just a watch"
              : `⏳ NOT triggered yet — still needs to go ${idea.triggerDirection} ${money(idea.triggerPrice)} first`}
          </span>
        </div>
      )}
      {(idea.invalidation != null || idea.target != null || idea.entryTrigger) && (
        <div className="mono muted" style={{ fontSize: 12, marginTop: 5 }}>
          {idea.entryTrigger && <>Entry: {idea.entryTrigger}{" · "}</>}
          {idea.invalidation != null && <>Stop (stock) <span className="down">{money(idea.invalidation)}</span></>}
          {idea.invalidation != null && idea.target != null && " → "}
          {idea.target != null && <>Target (stock) <span className="up">{money(idea.target)}</span></>}
          {idea.catalyst && <span> · {idea.catalyst}</span>}
          {staleAt && <span> · {isStale ? "stale" : `stale by ${new Date(staleAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}</span>}
        </div>
      )}
      {idea.vehicle === "OPTION" && idea.leg?.delta != null && (idea.invalidation != null || idea.target != null) && (() => {
        const entryPx = idea.leg.mid ?? idea.leg.ask;
        const atLevel = (level) => level != null && entryPx != null
          ? Math.max(0.01, entryPx + idea.leg.delta * (level - idea.entryPrice))
          : null;
        const stopPrem = atLevel(idea.invalidation);
        const targetPrem = atLevel(idea.target);
        return (
          <div className="mono muted" style={{ fontSize: 12, marginTop: 2 }}>
            For a stop/limit order on the CONTRACT itself (Robinhood, etc. want this in the option's own price, not the stock's):
            {" "}{stopPrem != null && <>stop ≈ <span className="down">${stopPrem.toFixed(2)}</span></>}
            {stopPrem != null && targetPrem != null && " → "}
            {targetPrem != null && <>target ≈ <span className="up">${targetPrem.toFixed(2)}</span></>}
            {" "}<span style={{ opacity: 0.75 }}>(estimate from delta {idea.leg.delta.toFixed(2)} at entry — drifts as delta itself changes; re-check before relying on it)</span>
          </div>
        );
      })()}
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{showPro ? (idea.why_pro || idea.why_plain || idea.why) : (idea.why_plain || idea.why)}</div>
      {idea.sizing?.note && (
        <div className="mono" style={{ fontSize: 12, marginTop: 6 }}>
          <span className="badge" style={idea.affordable === false
            ? { color: "var(--bear)", borderColor: "var(--bear)" }
            : idea.sizing.comfortable === false
            ? { color: "#7A5C15", borderColor: "rgba(163,120,32,.5)" }
            : { color: "var(--bull)", borderColor: "var(--bull)" }}>
            {idea.affordable === false ? "Bigger than this account's comfort zone" : "Sized for your account"}: {idea.sizing.note}
          </span>
        </div>
      )}
      {idea.vehicle === "OPTION" && idea.affordable === false && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.4 }}>
          Can't afford this strike? Don't swap to a cheaper, further-out strike on the same idea — a different strike is a different trade with a different breakeven, and the stop/target above won't apply to it. Buy fewer contracts if the sizing allows, look for a cheaper underlying, or use shares instead.
        </div>
      )}
      <OptionStageButton idea={idea} />
      <ShareStageButton idea={idea} />
    </div>
  );
}

function Ideas() {
  const [ideas, setIdeas] = useState([]);
  const [asOf, setAsOf] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [showPro, setShowPro] = useState(false);
  const [account, setAccount] = useState(1000);
  useEffect(() => { setAccount(readAccount()); }, []);
  const clock = useMarketClock();
  const closed = marketClosed(clock);
  // React Strict Mode (dev only) intentionally fires a fresh mount's effects
  // twice to surface non-idempotent ones. Without this guard that meant two
  // independent, billed /api/suggestions calls (each a real Anthropic call)
  // on every open of this tab, whichever finished last silently overwriting
  // the other — same idea, two different generations, seconds apart, with no
  // Refresh click in sight. A real remount (leaving and reopening the tab)
  // gets a fresh ref and still loads normally.
  const bootedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let syms = DEFAULT_SYMS;
      try {
        const saved = JSON.parse(localStorage.getItem("cockpit_watch"));
        if (Array.isArray(saved) && saved.length) syms = saved;
      } catch {}
      const d = await getJSON(`/api/suggestions?symbols=${syms.join(",")}&account=${readAccount()}`);
      setIdeas(d.ideas || []);
      setAsOf(d.timestamp ? new Date(d.timestamp).getTime() : Date.now());
      setErr("");
      notifyGoodIdeas(d.ideas);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load once on open. After that, refresh ONLY on the click of Refresh or at
  // the next scheduled slot above — no interval polling. Market fully closed
  // (weekend/holiday) suspends scheduling entirely until it reopens.
  useEffect(() => {
    if (asOf == null) {
      if (bootedRef.current) return;
      bootedRef.current = true;
      load();
      return;
    }
    if (!clock || clock.state === "closed") return;
    const t = setTimeout(load, msUntilNextIdeasSlot());
    return () => clearTimeout(t);
  }, [clock?.state, asOf, load]);

  // Bigger bets aren't hidden or converted to shares anymore — they're the
  // same real CALL/PUT ideas, just sorted below anything that actually fits
  // the stated account size, so the safer setups read first without losing
  // the ones that don't fit yet.
  // Big movers (real move today, computed from the actual quote, not
  // self-reported by the model) get pulled to their own section at the very
  // top — a MEDS-style 480% outlier or a 24%+ mover deserves to be seen
  // immediately, not buried at whatever position risk-sorting happened to
  // put it. Split into two: an actionable mover (red, "BIG MOVER") is a real
  // signal; a WAIT on a huge mover — e.g. a 271% no-news microfloat spike the
  // Cockpit deliberately declined — used to fall silently into the generic
  // WAIT pile at the bottom, unreadable as anything other than "nothing
  // happened." It gets its own amber "flagged, not a buy" section instead,
  // so a move that big is never invisible even when the call is to skip it.
  // Order below: red movers, then flagged-but-skipped movers, then
  // actionable ideas sized for the account, then actionable ideas too big
  // for it, then every remaining (non-mover) WAIT lumped at the very bottom
  // — a routine WAIT is "nothing to do right now" no matter which bucket its
  // underlying would otherwise fall into, so it shouldn't be interleaved
  // with the ideas actually worth reading first.
  const BIG_MOVER_PCT = 15;
  const isBigMoveToday = (idea) => idea.todayChangePct != null && Math.abs(idea.todayChangePct) >= BIG_MOVER_PCT;
  const isWait = (idea) => idea.action === "WAIT";
  const bigMovers = ideas.filter((idea) => isBigMoveToday(idea) && !isWait(idea));
  const flaggedMovers = ideas.filter((idea) => isBigMoveToday(idea) && isWait(idea));
  const rest = ideas.filter((idea) => !isBigMoveToday(idea));
  const sizedIdeas = rest.filter((idea) => !isWait(idea) && !(idea.vehicle === "OPTION" && idea.affordable === false));
  const biggerIdeas = rest.filter((idea) => !isWait(idea) && idea.vehicle === "OPTION" && idea.affordable === false);
  const waitIdeas = rest.filter(isWait);

  return (
    <div className="card">
      {closed && (
        <div className="warn" style={{ marginBottom: 12 }}>
          {clock.state === "closed"
            ? <>Market closed — ideas below are based on the last session&apos;s close plus overnight news, framed as plans for the next open.
                Prices can gap at the open, so re-check before acting.</>
            : <>{clock.state === "premarket" ? "Premarket" : "After hours"} — ideas factor in live extended-hours prices and fresh news from the Overnight Brief,
                framed as plans for the next regular session. Option quotes stay stale until the open.</>}
        </div>
      )}
      <RegimeBanner />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <span className="label" style={{ margin: 0 }}>
          <span className="live" style={closed ? { background: "var(--faint)" } : undefined} />
          Ideas{asOf ? <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}> · as of {new Date(asOf).toLocaleTimeString()} · auto-refreshes {IDEAS_SCHEDULE_LABEL}</span> : ""}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <label className="mono muted" style={{ fontSize: 11, display: "flex", gap: 4, alignItems: "center" }} title="Ideas are sized for this account: which cheaper names get scanned, whether a contract fits (hard cap 10%), and how many shares (1% risk to the stop). Takes effect on the next refresh.">
            Account $
            <input className="in" style={{ width: 74, padding: "2px 5px", fontSize: 12 }} inputMode="numeric" value={account}
              onChange={(e) => { const v = Number(e.target.value.replace(/[^0-9]/g, "")) || 0; setAccount(v); try { localStorage.setItem("cockpit_account", String(v)); } catch {} }} />
          </label>
          <AlertsToggle />
          <button className="chip" onClick={() => setShowPro((v) => !v)}>{showPro ? "Plain view" : "Pro view"}</button>
          <button className="btn" onClick={load} disabled={loading}>{loading ? "Loading..." : "Refresh"}</button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {bigMovers.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <span className="label down" style={{ margin: "0 0 8px", display: "block" }}>🔴 Big movers · {BIG_MOVER_PCT}%+ today — a real outlier, not routine noise</span>
          {bigMovers.map((idea, i) => (
            <IdeaCard key={idea.id ?? `${idea.symbol}-mover-${i}`} idea={idea} isLast={true} asOf={asOf} showPro={showPro} variant="mover" />
          ))}
        </div>
      )}
      {flaggedMovers.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <span className="label" style={{ margin: "0 0 8px", display: "block", color: "#7A5C15" }}>⚠️ Flagged movers · {BIG_MOVER_PCT}%+ today, but no clean setup — checked, not chased</span>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            A real move, but the Cockpit couldn't back it with fresh news or another good reason to trade it — usually a thin-float spike on stale or missing news. Shown here so a big move is never invisible, even when the call is to skip it.
          </div>
          {flaggedMovers.map((idea, i) => (
            <IdeaCard key={idea.id ?? `${idea.symbol}-flag-${i}`} idea={idea} isLast={true} asOf={asOf} showPro={showPro} variant="flag" />
          ))}
        </div>
      )}
      {sizedIdeas.map((idea, i) => (
        <IdeaCard key={idea.id ?? `${idea.symbol}-${i}`} idea={idea} isLast={i === sizedIdeas.length - 1 && !biggerIdeas.length && !waitIdeas.length} asOf={asOf} showPro={showPro} />
      ))}
      {biggerIdeas.length > 0 && (
        <div style={{ margin: "18px 0 10px", paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <span className="label" style={{ margin: 0 }}>Bigger bets · not sized for your ${account.toLocaleString()} account</span>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Same real ideas as before, on names whose contracts cost more than the account's comfort cap. Still fully actionable — just extra caution warranted on size.
          </div>
        </div>
      )}
      {biggerIdeas.map((idea, i) => (
        <IdeaCard key={idea.id ?? `${idea.symbol}-big-${i}`} idea={idea} isLast={i === biggerIdeas.length - 1 && !waitIdeas.length} asOf={asOf} showPro={showPro} />
      ))}
      {waitIdeas.length > 0 && (
        <div style={{ margin: "18px 0 10px", paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <span className="label" style={{ margin: 0 }}>Watching · no clear setup right now</span>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Nothing actionable on these today — kept here so you can see they were checked, not skipped.
          </div>
        </div>
      )}
      {waitIdeas.map((idea, i) => (
        <IdeaCard key={idea.id ?? `${idea.symbol}-wait-${i}`} idea={idea} isLast={i === waitIdeas.length - 1} asOf={asOf} showPro={showPro} />
      ))}
      {!ideas.length && !loading && <div className="muted">Click Refresh to get trading ideas from Claude AI</div>}
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
        <button className={"tab" + (tab === "news" ? " on" : "")} onClick={() => setTab("news")}>News</button>
        <button className={"tab" + (tab === "chain" ? " on" : "")} onClick={() => setTab("chain")}>Chain &amp; Risk</button>
        <button className={"tab" + (tab === "track" ? " on" : "")} onClick={() => setTab("track")}>Track Record</button>
        <button className={"tab" + (tab === "journal" ? " on" : "")} onClick={() => setTab("journal")}>Journal</button>
        <button className={"tab" + (tab === "ideas" ? " on" : "")} onClick={() => setTab("ideas")}>Ideas</button>
      </div>
      {tab === "watch" && <Watchlist onPick={pick} />}
      {tab === "news" && <NewsBoard onPick={pick} />}
      {tab === "chain" && <ChainRisk symbol={symbol} setSymbol={setSymbol} />}
      {tab === "track" && <TrackRecord />}
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
