"""Which contract should an idea buy? (owner, 2026-11-04: "lets do all").

For every real option trade since 10/07, at the same minute and in the same
direction, nine alternative contracts are bought on their real 1-minute
quotes (ThetaData) and sold under today's exits (tournament.option_exit:
stop 20% at the mid, +$80 at the bid, +50%, 15:45):

  expiry:  near (the first expiry 1+ days out, today's default), week (6-12
           days), month (13-24 days)
  strike:  in the money (1.5% through the stock price), at the money, out of
           the money (1.5% away)

Each is sized like the Cockpit: $250 at the 20% stop, at most 15% of the
account. The real contract's own replay is the 'actual' line.

    python3 scripts/backtest/contract_choice.py
"""
import json, os, re, sqlite3, statistics, sys, urllib.request, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spread_cost as sc
from tournament import option_exit, FEE

ROOT = sc.ROOT
CACHE = os.path.join(ROOT, "data", "backtest", "chains")
EXPIRY = {"near": (1, 5), "week": (6, 12), "month": (13, 24)}
MONEY = {"itm": -1.5, "atm": 0.0, "otm": 1.5}           # % from the stock price, in the option's direction


def theta(path):
    return json.load(urllib.request.urlopen("http://127.0.0.1:25503/v3/option/" + path + "&format=json", timeout=120))["response"]


def cached(name, fn):
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, name + ".json")
    if os.path.exists(f):
        return json.load(open(f))
    v = fn(); json.dump(v, open(f, "w")); return v


def main():
    rows = [json.loads(x[0]) for x in sqlite3.connect(os.path.join(ROOT, "data", "cockpit.db")).execute("select data from journal")]
    trades = sorted([r for r in rows if r.get("vehicle") == "OPTION" and r.get("entryFillPrice") and r.get("entryAt") and r.get("occ")
                     and r["entryAt"] >= "2026-10-07" and r.get("entryUnderlying") and r.get("exitReasonTag") not in ("unfilled", "orphaned")], key=lambda r: r["entryAt"])
    res = {}
    for k, r in enumerate(trades):
        e = sc.et(r["entryAt"]); day = e.date(); t0 = e.strftime("%H:%M")
        if t0 >= "15:44":
            continue
        sym = r["symbol"]; und = float(r["entryUnderlying"]); put = r["occ"][-9] == "P"
        exps = cached(f"{sym}_exps", lambda: sorted(x["expiration"] for x in theta(f"list/expirations?symbol={sym}")))
        q0 = sc.quotes(r["occ"], day)
        if q0:
            entry = float(r["entryFillPrice"]); qty = int(r.get("entryFilledQuantity") or r.get("entryQuantity") or 1)
            px, why, _ = option_exit(q0, entry, qty, t0)
            # the same contract bought the way the alternatives are (the minute's ask, $250 at the 20% stop), so the comparison is fair
            x0 = sc.at(q0, t0)
            if x0 and x0[1] >= 0.2 and (x0[1] - x0[0]) / ((x0[0] + x0[1]) / 2) <= 0.3:
                n0 = int(min(250 / (0.2 * x0[1] * 100), 0.15 * 25000 / (x0[1] * 100)))
                if n0 >= 1:
                    p0, _, _ = option_exit(q0, x0[1], n0, t0)
                    res.setdefault("same_replayed", []).append(dict(id=r.get("id"), day=day.isoformat(), pnl=(p0 - x0[1]) * n0 * 100 - 2 * FEE * n0,
                                                                   spread=(x0[1] - x0[0]) / ((x0[0] + x0[1]) / 2) * 100))
            res.setdefault("actual", []).append(dict(id=r.get("id"), dte=(dt.date(2000 + int(r["occ"][-15:-13]), int(r["occ"][-13:-11]), int(r["occ"][-11:-9])) - day).days, day=day.isoformat(), pnl=(px - entry) * qty * 100 - 2 * FEE * qty))
        for en, (lo, hi) in EXPIRY.items():
            exp = next((x for x in exps if lo <= (dt.date.fromisoformat(x) - day).days <= hi), None)
            if not exp:
                continue
            strikes = cached(f"{sym}_{exp}_strikes", lambda: sorted(float(x["strike"]) for x in theta(f"list/strikes?symbol={sym}&expiration={exp.replace('-', '')}")))
            for mn, pct in MONEY.items():
                want = und * (1 + (pct / 100) * (-1 if put else 1))
                k_ = min(strikes, key=lambda s: abs(s - want))
                occ = f"{sym}{dt.date.fromisoformat(exp):%y%m%d}{'P' if put else 'C'}{int(round(k_ * 1000)):08d}"
                q = sc.quotes(occ, day)
                x = sc.at(q, t0) if q else None
                if not x or x[1] < 0.2 or (x[1] - x[0]) / ((x[0] + x[1]) / 2) > 0.3:
                    continue
                ask = x[1]
                n = int(min(250 / (0.2 * ask * 100), 0.15 * 25000 / (ask * 100)))
                if n < 1:
                    continue
                px, why, _ = option_exit(q, ask, n, t0)
                res.setdefault(f"{en}/{mn}", []).append(dict(id=r.get("id"), day=day.isoformat(), pnl=(px - ask) * n * 100 - 2 * FEE * n,
                                                            spread=(x[1] - x[0]) / ((x[0] + x[1]) / 2) * 100))
        if k % 25 == 0:
            print(f"  ... {k} of {len(trades)} trades", flush=True)
    days = sorted({t["day"] for v in res.values() for t in v}); mid = days[len(days) // 2]
    print(f"\n{len(trades)} trades, {days[0]}..{days[-1]}, halves split at {mid}")
    act = {t["id"]: t for t in res.get("same_replayed", [])}
    dte_of = {t["id"]: t["dte"] for t in res.get("actual", [])}
    print("the contracts really bought, by days to expiry: " + ", ".join(f"{lab} {len(v)} trades {sum(t['pnl'] for t in v):+,.0f}" for lab, v in (
        ("1-5d", [t for t in res["actual"] if t["dte"] <= 5]), ("6-12d", [t for t in res["actual"] if 6 <= t["dte"] <= 12]), ("13d+", [t for t in res["actual"] if t["dte"] >= 13]))))
    print(f"{'contract':12} {'trades':>6} {'won':>4} {'net':>8} | {'1st':>7} {'2nd':>7} | avg  | median spread | our contract, replayed the same way, on the same trades: 1st / 2nd")
    for name in ["actual", "same_replayed"] + [f"{e}/{m}" for e in EXPIRY for m in MONEY]:
        v = res.get(name)
        if not v: continue
        h1 = sum(t["pnl"] for t in v if t["day"] < mid); h2 = sum(t["pnl"] for t in v if t["day"] >= mid)
        sp = statistics.median(t["spread"] for t in v) if "spread" in v[0] else None
        same = [act[t["id"]] for t in v if t["id"] in act]
        a1 = sum(t["pnl"] for t in same if t["day"] < mid); a2 = sum(t["pnl"] for t in same if t["day"] >= mid)
        beat = "BEATS our contract in both halves" if name not in ("actual", "same_replayed") and h1 > a1 and h2 > a2 else ""
        print(f"{name:12} {len(v):6} {sum(t['pnl'] > 0 for t in v) * 100 // len(v):3}% {sum(t['pnl'] for t in v):+8,.0f} | {h1:+7,.0f} {h2:+7,.0f} | {statistics.mean(t['pnl'] for t in v):+4.0f} | {f'{sp:.1f}%' if sp else '':13} | {a1:+7,.0f} {a2:+7,.0f}  {beat}")
    json.dump(res, open(os.path.join(ROOT, "data", "backtest", "contract_choice.json"), "w"))


if __name__ == "__main__":
    main()
