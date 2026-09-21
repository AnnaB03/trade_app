"use client";
import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { journalStats, todayStr } from "../lib/metrics";

const pctFmt = (v) => v == null ? "—" : (v * 100).toFixed(0) + "%";
const usd = (v) => v == null ? "—" : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const blank = () => ({ date: todayStr(), symbol: "", structure: "", direction: "bull", premium: "bought", entryIv: "", thesis: "", status: "open", pnl: "" });

async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

// latest stored IV snapshot for a symbol (written by the Chain & Risk tab)
function latestIv(sym) {
  try {
    const store = JSON.parse(localStorage.getItem("iv_history") || "{}");
    const list = store[sym?.toUpperCase()] || [];
    return list.length ? list[list.length - 1].iv : null;
  } catch { return null; }
}

// Close an open live position: quantity + limit price (both editable,
// defaulted from the position) and a required reason — the same
// preview-then-send pattern as the Ideas tab's order buttons, ending in a
// real (paper) closing order once you confirm. The server derives which
// Tradier side to use (sell / buy_to_cover / sell_to_close) from the actual
// live position, so a mislabeled close can't open the opposite exposure.
function ClosePositionControl({ position, onClosed }) {
  const [qty, setQty] = useState(String(Math.abs(position.quantity)));
  const [price, setPrice] = useState(position.last != null ? Number(position.last).toFixed(2) : "");
  const [reason, setReason] = useState("");
  const [state, setState] = useState({ status: "idle" });

  const body = () => position.vehicle === "OPTION"
    ? { legs: [{ action: "sell", type: position.optionType, strike: String(position.strike), premium: price, qty: Number(qty), occ: position.symbol }], closing: true, outcome_note: reason }
    : { equity: { symbol: position.underlying, quantity: Number(qty), price: Number(price) }, closing: true, outcome_note: reason };

  const submit = async (url) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Request failed");
    return d;
  };
  const preview = async () => {
    setState({ status: "previewing" });
    try {
      await submit("/api/order/stage");
      setState({ status: "previewed", msg: `Preview only, nothing sent to Tradier yet — closing ${qty} @ $${Number(price || 0).toFixed(2)}` });
    } catch (e) { setState({ status: "error", msg: e.message }); }
  };
  const place = async () => {
    setState((s) => ({ ...s, status: "placing" }));
    try {
      const d = await submit("/api/order/place");
      setState({ status: "placed", msg: `Sent to Tradier (paper) — order #${d.order?.id ?? "?"}, status ${d.order?.status ?? "submitted"}.` });
      onClosed?.();
    } catch (e) { setState({ status: "error", msg: e.message }); }
  };

  if (state.status === "placed") return <div className="safe" style={{ fontSize: 12.5, padding: "8px 10px", marginTop: 6 }}>✓ {state.msg}</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input className="in" style={{ width: 56, padding: "3px 6px", fontSize: 12 }} inputMode="numeric" value={qty} disabled={state.status === "placing"}
          onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))} />
        <span className="mono muted" style={{ fontSize: 12 }}>@ $</span>
        <input className="in" style={{ width: 76, padding: "3px 6px", fontSize: 12 }} inputMode="decimal" value={price} disabled={state.status === "placing"}
          onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
        <input className="in" style={{ flex: 1, minWidth: 180, padding: "3px 6px", fontSize: 12 }} placeholder="Reason for closing (required)" value={reason}
          disabled={state.status === "placing"} onChange={(e) => setReason(e.target.value)} />
      </div>
      {state.status === "previewed" ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mono muted" style={{ fontSize: 12 }}>{state.msg}</span>
          <button className="chip" onClick={place} disabled={state.status === "placing"}>{state.status === "placing" ? "Sending…" : "Send to Tradier (paper)"}</button>
        </div>
      ) : (
        <button className="chip" onClick={preview} disabled={state.status === "previewing" || !reason.trim() || !price} style={{ alignSelf: "flex-start" }}>
          {state.status === "previewing" ? "Checking…" : "Preview close"}
        </button>
      )}
      {state.status === "error" && <div className="err" style={{ fontSize: 12.5 }}>{state.msg}</div>}
    </div>
  );
}

function PositionsPanel() {
  const [positions, setPositions] = useState(null);
  const [err, setErr] = useState("");
  const [openSym, setOpenSym] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setPositions((await getJSON("/api/positions")).positions || []); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}>Open positions · live, from your Tradier sandbox account</span>
        <button className="chip" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </div>
      {err && <div className="err">{err}</div>}
      {positions && !positions.length && <div className="muted" style={{ fontSize: 13 }}>No open positions.</div>}
      {positions && positions.length > 0 && (
        <table>
          <thead><tr>
            <th style={{ textAlign: "left" }}>Symbol</th><th>Qty</th><th>Cost basis</th><th>Last</th><th>Unrealized</th><th></th>
          </tr></thead>
          <tbody>
            {positions.map((p) => {
              const isOpen = openSym === p.symbol;
              return (
                <Fragment key={p.symbol}>
                  <tr>
                    <td style={{ textAlign: "left" }}>
                      <span style={{ fontWeight: 600 }}>{p.underlying}</span>
                      {p.vehicle === "OPTION" && <span className="muted"> {p.strike} {p.optionType} {p.expiration}</span>}
                    </td>
                    <td>{p.quantity}</td>
                    <td className="muted">{usd(p.costBasis)}</td>
                    <td>{p.last != null ? "$" + Number(p.last).toFixed(2) : "—"}</td>
                    <td className={p.unrealizedPnl == null ? "muted" : p.unrealizedPnl >= 0 ? "up" : "down"} style={{ fontWeight: 600 }}>
                      {usd(p.unrealizedPnl)}
                    </td>
                    <td><button className="chip" onClick={() => setOpenSym(isOpen ? null : p.symbol)}>{isOpen ? "hide" : "close…"}</button></td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "left", background: "var(--paper)", padding: "10px" }}>
                        {p.journal && (
                          <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
                            {p.journal.thesis && <>Plan: {p.journal.thesis} </>}
                            {p.journal.invalidation != null && p.journal.target != null && (
                              <>· stop {usd(p.journal.invalidation)} → target {usd(p.journal.target)}</>
                            )}
                          </div>
                        )}
                        <ClosePositionControl position={p} onClosed={load} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const GRADE_TONE = (v) => v == null ? "muted" : v >= 0 ? "up" : "down";

function AutoJournalPanel() {
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setEntries((await getJSON("/api/journal")).entries || []); }
    catch { setEntries([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label" style={{ margin: 0 }}>Trade journal · auto-logged from real orders placed in this app</span>
        <button className="chip" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </div>
      {entries && !entries.length && <div className="muted" style={{ fontSize: 13 }}>No trades placed through this app yet — placing an idea (or closing a position) logs one here automatically.</div>}
      {entries && entries.length > 0 && (
        <table>
          <thead><tr>
            <th style={{ textAlign: "left" }}>Opened</th><th style={{ textAlign: "left" }}>Symbol</th>
            <th style={{ textAlign: "left" }}>Plan</th><th>Status</th>
            <th style={{ textAlign: "left" }}>Exit reason</th><th>P&amp;L</th><th>R</th><th>Days</th>
          </tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td style={{ textAlign: "left" }} className="muted">{new Date(e.entryAt || e.createdAt).toLocaleDateString()}</td>
                <td style={{ textAlign: "left", fontWeight: 600 }}>{e.symbol}</td>
                <td style={{ textAlign: "left" }} title={e.thesis || ""}>
                  {e.vehicle === "OPTION" ? `${e.optionType ?? ""} ${e.strike ?? ""} ${e.expiration ?? ""}` : "shares"}
                  {e.source === "idea" && <span className="badge" style={{ fontSize: 10, marginLeft: 6, padding: "1px 5px" }}>from idea</span>}
                </td>
                <td className={e.status === "open" ? "" : "muted"}>{e.status}</td>
                <td style={{ textAlign: "left", fontSize: 12.5 }} className="muted">{e.exitReason || "—"}</td>
                <td className={GRADE_TONE(e.pnl)} style={{ fontWeight: 600 }}>{e.pnl != null ? usd(e.pnl) : "—"}</td>
                <td className={GRADE_TONE(e.rMultiple)}>{e.rMultiple != null ? (e.rMultiple >= 0 ? "+" : "") + e.rMultiple.toFixed(2) : "—"}</td>
                <td className="muted">{e.daysHeld != null ? e.daysHeld.toFixed(1) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Journal() {
  const [entries, setEntries] = useState([]);
  const [form, setForm] = useState(blank());
  const hydrated = useRef(false);
  const fileRef = useRef(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cockpit_journal"));
      if (Array.isArray(saved)) setEntries(saved);
    } catch {}
    hydrated.current = true;
  }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    try { localStorage.setItem("cockpit_journal", JSON.stringify(entries)); } catch {}
  }, [entries]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setSymbol = (e) => {
    const symbol = e.target.value.toUpperCase();
    setForm((f) => {
      const iv = f.entryIv === "" || f.autoIv ? latestIv(symbol) : null;
      return iv != null ? { ...f, symbol, entryIv: (iv * 100).toFixed(1), autoIv: true } : { ...f, symbol };
    });
  };
  const addEntry = () => {
    if (!form.symbol.trim() || !form.structure.trim()) return;
    const { autoIv, ...rest } = form;
    setEntries((es) => [{ ...rest, symbol: form.symbol.trim(), id: Date.now() + "-" + Math.random().toString(36).slice(2, 7) }, ...es]);
    setForm(blank());
  };
  const update = (id, patch) => setEntries((es) => es.map((e) => e.id === id ? { ...e, ...patch } : e));
  const remove = (id) => setEntries((es) => es.filter((e) => e.id !== id));

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cockpit-journal-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJSON = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error("not an array");
      const incoming = parsed.filter((x) => x && x.symbol).map((x) => ({ ...x, id: x.id || Date.now() + "-" + Math.random().toString(36).slice(2, 7) }));
      setEntries((es) => {
        const byId = new Map(es.map((x) => [x.id, x]));
        incoming.forEach((x) => byId.set(x.id, x));
        return [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
      });
    } catch { alert("Import failed — expected a JSON array exported from this journal."); }
  };

  const s = journalStats(entries);

  return (
    <>
      <PositionsPanel />
      <AutoJournalPanel />

      <div className="card">
        <span className="label">Log a manual trade &middot; for anything placed outside this app</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="in" type="date" value={form.date} onChange={set("date")} />
          <input className="in" style={{ width: 90 }} placeholder="SYMBOL" value={form.symbol} onChange={setSymbol} />
          <input className="in" style={{ width: 200 }} placeholder="Structure (e.g. 550/560 call spread)" value={form.structure} onChange={set("structure")} />
          <select className="sel" value={form.direction} onChange={set("direction")}>
            <option value="bull">bull</option><option value="bear">bear</option><option value="neutral">neutral</option>
          </select>
          <select className="sel" value={form.premium} onChange={set("premium")}>
            <option value="bought">premium bought</option><option value="sold">premium sold</option>
          </select>
          <input className="in" style={{ width: 110 }} placeholder="Entry IV %" inputMode="decimal" value={form.entryIv}
            onChange={(e) => setForm((f) => ({ ...f, entryIv: e.target.value.replace(/[^0-9.]/g, ""), autoIv: false }))} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <input className="in" style={{ flex: 1, minWidth: 240 }} placeholder="Thesis — why this trade?" value={form.thesis} onChange={set("thesis")}
            onKeyDown={(e) => e.key === "Enter" && addEntry()} />
          <button className="btn" onClick={addEntry}>Log trade</button>
        </div>
      </div>

      <div className="card">
        <span className="label">Stats · closed trades only</span>
        {s.nClosed < 10 ? (
          <div className="muted" style={{ fontSize: 13 }}>insufficient data (&lt;10 closed trades — {s.nClosed} so far)</div>
        ) : (
          <>
            <div className="metrics">
              <div className="metric"><div className="k">Win rate</div><div className="v">{pctFmt(s.winRate)}</div></div>
              <div className="metric"><div className="k">Expectancy / trade</div><div className="v" style={{ color: s.expectancy >= 0 ? "var(--bull)" : "var(--bear)" }}>{usd(s.expectancy)}</div></div>
              <div className="metric"><div className="k">Avg win / avg loss</div><div className="v">{usd(s.avgWin)} / {usd(s.avgLoss)}</div></div>
            </div>
            <div className="mono muted" style={{ fontSize: 12, marginTop: 8 }}>
              by premium — bought: {pctFmt(s.byPremium.bought)} · sold: {pctFmt(s.byPremium.sold)}
              {" · "}by direction — bull: {pctFmt(s.byDirection.bull)} · bear: {pctFmt(s.byDirection.bear)} · neutral: {pctFmt(s.byDirection.neutral)}
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span className="label" style={{ margin: 0 }}>Manual entries · {entries.length} entr{entries.length === 1 ? "y" : "ies"}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="chip" onClick={exportJSON} disabled={!entries.length}>export JSON</button>
            <button className="chip" onClick={() => fileRef.current?.click()}>import JSON</button>
            <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={importJSON} />
          </div>
        </div>
        {!entries.length && <div className="muted" style={{ fontSize: 13 }}>No trades logged yet.</div>}
        {entries.length > 0 && (
          <table>
            <thead><tr>
              <th style={{ textAlign: "left" }}>Date</th><th style={{ textAlign: "left" }}>Symbol</th>
              <th style={{ textAlign: "left" }}>Structure</th><th>Dir</th><th>Premium</th><th>Entry IV</th>
              <th>Status</th><th>P&amp;L $</th><th></th>
            </tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td style={{ textAlign: "left" }}>{e.date}</td>
                  <td style={{ textAlign: "left", fontWeight: 600 }}>{e.symbol}</td>
                  <td style={{ textAlign: "left" }} title={e.thesis}>{e.structure}{e.thesis ? " *" : ""}</td>
                  <td>{e.direction}</td><td>{e.premium}</td>
                  <td className="muted">{e.entryIv ? e.entryIv + "%" : "—"}</td>
                  <td>
                    <select className="sel" style={{ padding: "3px 6px", fontSize: 12 }} value={e.status} onChange={(ev) => update(e.id, { status: ev.target.value })}>
                      <option value="open">open</option><option value="won">won</option>
                      <option value="lost">lost</option><option value="scratched">scratched</option>
                    </select>
                  </td>
                  <td>
                    <input className="in" style={{ width: 80, padding: "3px 6px", fontSize: 12, textAlign: "right" }} inputMode="decimal"
                      value={e.pnl ?? ""} placeholder="0"
                      onChange={(ev) => update(e.id, { pnl: ev.target.value.replace(/[^0-9.\-]/g, "") })} />
                  </td>
                  <td><button className="x" onClick={() => remove(e.id)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {entries.some((e) => e.thesis) && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>* hover a structure to read the thesis</div>}
      </div>
    </>
  );
}
