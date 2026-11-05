"""The strategy tournament (owner, 2026-11-04: "lets do all"): ghost bots
replay every real option trade since 10/07 on that contract's real 1-minute
quotes (ThetaData), each with its own rules, so rule ideas are judged on the
same trades, side by side, instead of one rule at a time live.

The candidates are the option trades the Cockpit really bought (same idea,
same contract, same minute, same price). The bots change what happens next:

  now        the rules to 11/05: stop 20% at the mid, +$80 at the bid, +50%, sold 15:45
  let_run    live since 11/05: as now, but no +$80 sale when QQQ 0.5%+ and SPY 0.25%+ were our way at the buy
  pct10      sell at +10% at the bid instead of +$80 / +50%
  breakeven  today's rules, and once the bid is 15%+ up the stop moves to the buy
  tm_filter  today's rules, skipping trades the Time Machine called "no edge" (R < -0.05)
  qqq_size   no trade unless QQQ is 0.5%+ our way since the open; double size at 1%+
  tm_exit    today's rules, and every 5 minutes "sell now or hold?": sells at the bid
             when the Time Machine's odds from the current stock price fall below -0.10R
  shares     the same calls bought as shares instead ($250 at the idea's invalidation,
             capped at 15% of the account), sold at the target, the invalidation or
             15:45; puts are skipped (a cash account cannot short)

Every bot sells by 15:45 the same day (today's rule), so October's carried
trades are replayed as day trades. Fills: the ask to buy, the bid to sell, at
the minute; fees $0.35 a contract each way. `now` is checked against what
really happened on same-day trades, so the replay's own error is visible.

    python3 scripts/backtest/tournament.py            # every day since 10/07, by halves
    python3 scripts/backtest/tournament.py --save     # also writes data/tournament/latest.json (the server runs this after the close)
"""
import json, os, sqlite3, statistics, sys, urllib.parse, urllib.request, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spread_cost as sc
import timemachine as tm

ROOT = sc.ROOT
OUT = os.path.join(ROOT, "data", "tournament")
BARS1 = os.path.join(ROOT, "data", "backtest", "bars1m")
FEE = 0.35
BOTS = ("now", "let_run", "pct10", "breakeven", "tm_filter", "qqq_size", "tm_exit", "shares")


def minutes(t0, t1="15:45"):
    t = dt.datetime.strptime(t0, "%H:%M")
    while t.strftime("%H:%M") < t1:
        t += dt.timedelta(minutes=1)
        yield t.strftime("%H:%M")


def stock_1m(sym, day):
    """{HH:MM: (high, low, close)} from Tradier 1-minute bars (kept about a month), cached."""
    os.makedirs(BARS1, exist_ok=True)
    f = os.path.join(BARS1, f"{sym}_{day}.json")
    if os.path.exists(f):
        return {k: tuple(v) for k, v in json.load(open(f)).items()}
    q = urllib.parse.urlencode({"symbol": sym, "interval": "1min", "start": f"{day} 09:30", "end": f"{day} 16:00", "session_filter": "open"})
    req = urllib.request.Request("https://api.tradier.com/v1/markets/timesales?" + q, headers={"Authorization": "Bearer " + tm.TOK, "Accept": "application/json"})
    try:
        d = (json.load(urllib.request.urlopen(req, timeout=60)).get("series") or {}).get("data") or []
    except Exception:
        return None
    d = [d] if isinstance(d, dict) else d
    bars = {b["time"][11:16]: (float(b["high"]), float(b["low"]), float(b["close"])) for b in d}
    if day < dt.datetime.now(tm.ET).date().isoformat() or dt.datetime.now(tm.ET).strftime("%H:%M") >= "16:05":
        json.dump(bars, open(f, "w"))
    return bars


def option_exit(q, entry, qty, t0, *, stop_pct=0.20, take_usd=80, take_pct=0.50, pct10=False, breakeven=False, check=None):
    """Walk the option's minutes after the buy. Returns (exit price, reason, minute)."""
    stop = entry * (1 - stop_pct)
    last = None
    for t in minutes(t0):
        x = q.get(t)
        if not x:
            continue
        b, a = x; mid = (b + a) / 2; last = (b, t)
        if (a - b) / mid > 0.5:
            continue                                            # a blown-out quote is not a price
        if mid <= stop:
            return b, "stop", t
        if pct10:
            if b >= entry * 1.10: return b, "pct10", t
        else:
            if (b - entry) * qty * 100 > take_usd: return b, "take_usd", t
            if b >= entry * (1 + take_pct): return b, "pct50", t
        if breakeven and b >= entry * 1.15:
            stop = max(stop, entry)
        if check and t.endswith(("0", "5")) and check(t):
            return b, "tm_exit", t
    return (last[0], "1545", last[1]) if last else (entry, "noquote", t0)


def main(save=False):
    rows = [json.loads(x[0]) for x in sqlite3.connect(os.path.join(ROOT, "data", "cockpit.db")).execute("select data from journal")]
    trades = sorted([r for r in rows if r.get("vehicle") == "OPTION" and r.get("entryFillPrice") and r.get("entryAt") and r.get("occ")
                     and r["entryAt"] >= "2026-10-07" and r.get("exitReasonTag") not in ("unfilled", "orphaned")], key=lambda r: r["entryAt"])
    tmsaved = {}
    for f in os.listdir(os.path.join(ROOT, "data", "timemachine")) if os.path.isdir(os.path.join(ROOT, "data", "timemachine")) else []:
        for t in json.load(open(os.path.join(ROOT, "data", "timemachine", f))):
            tmsaved[t.get("id")] = t
    qqq = tm.sessions("QQQ"); spy = tm.sessions("SPY")
    pools = {}
    res = {b: [] for b in BOTS}; calib = []
    for r in trades:
        e = sc.et(r["entryAt"]); day = e.date().isoformat(); t0 = e.strftime("%H:%M")
        if t0 >= "15:44":
            continue
        q = sc.quotes(r["occ"], e.date())
        if not q:
            continue
        entry = float(r["entryFillPrice"]); qty = int(r.get("entryFilledQuantity") or r.get("entryQuantity") or 1)
        stop_pct = max(0.20, (r.get("stopPct") or 20) / 100)
        put = r.get("optionType") == "put" or "P" in r["occ"][-9:-8]
        pnl = lambda px, n=qty: (px - entry) * n * 100 - 2 * FEE * n
        base = dict(id=r.get("id"), day=day, sym=r["symbol"], at=t0)
        px, why, _ = option_exit(q, entry, qty, t0, stop_pct=stop_pct)
        res["now"].append(dict(base, pnl=pnl(px), why=why))
        if (r.get("exitAt") or "")[:10] == r["entryAt"][:10] and isinstance(r.get("pnl"), (int, float)):
            calib.append((pnl(px), r["pnl"]))
        sq = spy.get(day); qs0 = qqq.get(day)
        if sq and qs0:
            i0 = max(0, tm.slot(t0) - 1); sgn = -1 if put else 1
            run_ = (qs0[i0][3] / qs0[0][0] - 1) * 100 * sgn >= 0.5 and (sq[i0][3] / sq[0][0] - 1) * 100 * sgn >= 0.25
            pr, wr, _ = option_exit(q, entry, qty, t0, stop_pct=stop_pct, take_usd=1e9) if run_ else (px, why, None)
            res["let_run"].append(dict(base, pnl=pnl(pr), why=wr))
        px2, why2, _ = option_exit(q, entry, qty, t0, stop_pct=stop_pct, pct10=True)
        res["pct10"].append(dict(base, pnl=pnl(px2), why=why2))
        px3, why3, _ = option_exit(q, entry, qty, t0, stop_pct=stop_pct, breakeven=True)
        res["breakeven"].append(dict(base, pnl=pnl(px3), why=why3))
        saved = tmsaved.get(r.get("id"))
        if not (saved and saved["mc_avg_r"] < -0.05):
            res["tm_filter"].append(dict(base, pnl=pnl(px), why=why))
        # QQQ's move since the open at the buy, in the trade's direction (5-minute bars)
        qs = qqq.get(day)
        if qs:
            i = max(0, tm.slot(t0) - 1)
            mv = (qs[i][3] / qs[0][0] - 1) * 100 * (-1 if put else 1)
            if mv >= 0.5:
                n = qty * (2 if mv >= 1 else 1)
                res["qqq_size"].append(dict(base, pnl=pnl(px, n) if n == qty else (px - entry) * n * 100 - 2 * FEE * n, why=why))
        # sell now or hold: the Time Machine from the current stock price to the idea's levels
        und, tgt, inv = r.get("entryUnderlying"), r.get("target"), r.get("invalidation")
        bars1 = stock_1m(r["symbol"], day) if (und and tgt and inv) else None
        if bars1:
            if put and tgt > und: tgt, inv = inv, tgt
            def check(t, sym=r["symbol"], tgt=float(tgt), inv=float(inv)):
                b = bars1.get(t)
                if not b: return False
                p = b[2]
                if (tgt > inv and not (inv < p < tgt)) or (tgt < inv and not (tgt < p < inv)): return False
                try:
                    v = tm.run(sym, p, inv, tgt, t, day=day, n=500)
                except Exception:
                    return False
                return v["mc_avg_r"] < -0.10
            px4, why4, _ = option_exit(q, entry, qty, t0, stop_pct=stop_pct, check=check)
            res["tm_exit"].append(dict(base, pnl=pnl(px4), why=why4))
            # the same call bought as shares
            if not put and float(inv) < und:
                n = int(min(250 / (und - float(inv)), 0.15 * 25000 / und))
                out = None
                for t in minutes(t0):
                    b = bars1.get(t)
                    if not b: continue
                    hi, lo, c = b
                    if lo <= float(inv): out = (float(inv), "stop"); break
                    if hi >= float(tgt): out = (float(tgt), "target"); break
                    last = c
                if out is None: out = (locals().get("last", und), "1545")
                res["shares"].append(dict(base, pnl=(out[0] - und) * n, why=out[1]))
    days = sorted({t["day"] for t in res["now"]}); mid = days[len(days) // 2]
    print(f"{len(res['now'])} option trades replayed, {days[0]}..{days[-1]}; halves split at {mid}")
    if calib:
        err = [a - b for a, b in calib]
        print(f"replay check: 'now' on {len(calib)} same-day trades made ${sum(a for a, _ in calib):,.0f} in the replay against ${sum(b for _, b in calib):,.0f} for real "
              f"(median gap ${statistics.median(err):+.0f} a trade)")
    key = lambda t: t["id"]
    now_by = {key(t): t for t in res["now"]}
    print(f"\n{'bot':10} {'trades':>6} {'won':>5} {'net':>9} | {'1st half':>9} {'2nd half':>9} | avg a trade | 'now' on the same trades: 1st / 2nd")
    summary = {}
    for b in BOTS:
        x = res[b]
        if not x: print(f"{b:10} none"); continue
        h1 = sum(t["pnl"] for t in x if t["day"] < mid); h2 = sum(t["pnl"] for t in x if t["day"] >= mid)
        # skipping bots (tm_filter, qqq_size) are judged against ALL of now's trades: the skipped ones count as $0
        same = res["now"] if b in ("tm_filter", "qqq_size") else [now_by[key(t)] for t in x if key(t) in now_by]
        n1 = sum(t["pnl"] for t in same if t["day"] < mid); n2 = sum(t["pnl"] for t in same if t["day"] >= mid)
        beat = "BEATS now in both halves" if b != "now" and h1 > n1 and h2 > n2 else ""
        print(f"{b:10} {len(x):6} {sum(t['pnl'] > 0 for t in x) * 100 // len(x):4}% {sum(t['pnl'] for t in x):+9,.0f} | {h1:+9,.0f} {h2:+9,.0f} | {statistics.mean(t['pnl'] for t in x):+6.0f}      | {n1:+9,.0f} {n2:+9,.0f}  {beat}")
        summary[b] = dict(trades=len(x), won=sum(t["pnl"] > 0 for t in x), net=round(sum(t["pnl"] for t in x)), first=round(h1), second=round(h2), now_first=round(n1), now_second=round(n2), beats=bool(beat))
    print("\nA bot beats 'now' only if it is ahead in BOTH halves, on the same trades. tm_exit and shares cover only trades with stock levels (shares: calls only).")
    if save:
        os.makedirs(OUT, exist_ok=True)
        json.dump({"at": dt.datetime.now(tm.ET).isoformat(), "split": mid, "summary": summary, "trades": res}, open(os.path.join(OUT, "latest.json"), "w"))
        print("saved data/tournament/latest.json")


if __name__ == "__main__":
    main("--save" in sys.argv)
