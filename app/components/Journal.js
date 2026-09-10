"use client";
import { useState, useEffect, useRef } from "react";
import { journalStats, todayStr } from "../lib/metrics";

const pctFmt = (v) => v == null ? "—" : (v * 100).toFixed(0) + "%";
const usd = (v) => v == null ? "—" : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const blank = () => ({ date: todayStr(), symbol: "", structure: "", direction: "bull", premium: "bought", entryIv: "", thesis: "", status: "open", pnl: "" });

// latest stored IV snapshot for a symbol (written by the Chain & Risk tab)
function latestIv(sym) {
  try {
    const store = JSON.parse(localStorage.getItem("iv_history") || "{}");
    const list = store[sym?.toUpperCase()] || [];
    return list.length ? list[list.length - 1].iv : null;
  } catch { return null; }
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cockpit-journal-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // revoking in the same tick cancels the download in Firefox/Safari
    setTimeout(() => URL.revokeObjectURL(url), 10000);
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
      <div className="card">
        <span className="label">Log a trade</span>
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
              <div className="metric"><div className="k">Expectancy / trade</div><div className="v" style={{ color: s.expectancy == null ? "var(--muted)" : s.expectancy >= 0 ? "var(--bull)" : "var(--bear)" }}>{usd(s.expectancy)}</div></div>
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
          <span className="label" style={{ margin: 0 }}>Journal · {entries.length} entr{entries.length === 1 ? "y" : "ies"}</span>
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
