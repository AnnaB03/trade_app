"""Backtest credit spreads on the weekly chains saved by fetch_chains.py.

Each entry day, at the first quote at or after ENTRY_TIME, the stock price is
taken from put-call parity at the strike nearest the money (call mid - put mid
+ strike; within ~0.04% of the real price on QQQ, checked 2026-10-30). Then a
spread WIDTH dollars wide is sold with its short strike DIST% away:

    put  spread (bullish):  sell strike ~ S*(1-DIST%), buy strike - WIDTH
    call spread (bearish):  sell strike ~ S*(1+DIST%), buy strike + WIDTH

Fills are conservative: sold at the bid, bought at the ask, both legs, both
ways, plus $0.35 a contract per leg. It is checked every 15 minutes: bought
back when that costs no more than (1 - TAKE) of the credit, stopped when it
costs STOP times the credit, otherwise settled at expiry on the last quote of
the expiry day. Every trade is sized to the same $500 maximum loss, so the
dollar figures compare across distances and expiries.

    python3 scripts/backtest/credit_spreads.py            # the grid
    python3 scripts/backtest/credit_spreads.py --trades   # plus each trade of the best rows
"""
import gzip, glob, json, os, sys, datetime as dt, itertools, collections

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
DATA = os.path.join(ROOT, "data", "backtest")
WIDTH, FEE, RISK_USD, ENTRY_TIME = 5.0, 0.35, 500.0, "10:00"


def load(path):
    with gzip.open(path, "rt") as f:
        d = json.load(f)
    q = {}
    for c in d["contracts"]:
        q[(c["k"], c["r"])] = {t[:16]: (b, a) for t, b, a in c["q"]}
    return d["symbol"], dt.date.fromisoformat(d["expiration"]), q


def spot(q, ts):
    """Underlying at a timestamp from put-call parity at the most at-the-money strike."""
    best = None
    for (k, r), qs in q.items():
        if r != "C" or ts not in qs:
            continue
        p = q.get((k, "P"), {}).get(ts)
        c = qs[ts]
        if not p or c[0] <= 0 or p[0] <= 0:
            continue
        cm, pm = (c[0] + c[1]) / 2, (p[0] + p[1]) / 2
        if best is None or abs(cm - pm) < best[0]:
            best = (abs(cm - pm), cm - pm + k)
    return best[1] if best else None


def nearest_strike(q, target):
    ks = sorted({k for k, r in q})
    return min(ks, key=lambda k: abs(k - target)) if ks else None


def run_spread(q, exp, day, side, dist, take, stop):
    times = sorted({t for qs in q.values() for t in qs if t[:10] >= day.isoformat()})
    entry = next((t for t in times if t[:10] == day.isoformat() and t[11:] >= ENTRY_TIME), None)
    if not entry:
        return None
    s = spot(q, entry)
    if not s:
        return None
    if side == "put":
        ks = nearest_strike(q, s * (1 - dist / 100)); kl = ks - WIDTH
        short, long_ = (ks, "P"), (kl, "P")
    else:
        ks = nearest_strike(q, s * (1 + dist / 100)); kl = ks + WIDTH
        short, long_ = (ks, "C"), (kl, "C")
    sq, lq = q.get(short, {}), q.get(long_, {})
    if entry not in sq or entry not in lq:
        return None
    credit = sq[entry][0] - lq[entry][1]           # sell the short at the bid, buy the protection at the ask
    if credit <= 0.05 or credit >= WIDTH:
        return None
    max_loss = (WIDTH - credit) * 100 + 2 * FEE
    cost, how, when = None, "expiry", None
    for t in times:
        if t <= entry:
            continue
        if t in sq and t in lq and sq[t][1] > 0:
            close = sq[t][1] - lq[t][0]            # buy back the short at the ask, sell the long at the bid
            if take and close <= credit * (1 - take):
                cost, how, when = close, "take", t; break
            if stop and close >= credit * stop:
                cost, how, when = close, "stop", t; break
    fees = 2 * FEE
    if cost is None:                                # settle at expiry on the last price of the expiry day
        last = [t for t in times if t[:10] == exp.isoformat()]
        if not last:
            return None
        st = spot(q, last[-1]) or s
        intrinsic = max(0.0, min(WIDTH, (ks - st) if side == "put" else (st - ks)))
        cost, when = intrinsic, last[-1]
    else:
        fees += 2 * FEE
    pnl = (credit - cost) * 100 - fees
    scale = RISK_USD / max_loss                     # the same $500 at risk on every trade
    return {"day": day.isoformat(), "exp": exp.isoformat(), "side": side, "spot": round(s, 2), "short": ks,
            "credit": round(credit, 2), "exit": how, "when": when, "pnl500": pnl * scale}


def main():
    files = sorted(glob.glob(os.path.join(DATA, "*.json.gz")))
    # One period at a time: BT_FROM=2022-01-01 BT_TO=2022-12-31 python3 scripts/backtest/credit_spreads.py
    lo, hi = os.environ.get("BT_FROM", "2025-10-27"), os.environ.get("BT_TO", "2026-10-30")
    files = [f for f in files if lo.replace("-", "") <= os.path.basename(f).split("_")[1][:8] <= hi.replace("-", "")]
    chains = [load(f) for f in files]
    print(f"{len(chains)} weekly chains: " + ", ".join(f"{s} {n}" for s, n in collections.Counter(c[0] for c in chains).items()))
    grid = list(itertools.product(("put", "call"), (1.0, 2.0, 3.0), (1, 2, 4, 7), (0.5, None), (2.0, None)))
    results = []
    for side, dist, dte, take, stop in grid:
        trades = []
        for sym, exp, q in chains:
            day = exp - dt.timedelta(days=dte)
            if day.weekday() >= 5:
                continue
            r = run_spread(q, exp, day, side, dist, take, stop)
            if r:
                r["sym"] = sym; trades.append(r)
        if len(trades) < 20:
            continue
        trades.sort(key=lambda r: r["day"])
        h = len(trades) // 2
        halves = [trades[:h], trades[h:]]
        net = lambda ts: sum(t["pnl500"] for t in ts)
        win = lambda ts: 100 * sum(1 for t in ts if t["pnl500"] > 0) / max(1, len(ts))
        worst = min(t["pnl500"] for t in trades)
        results.append((min(net(halves[0]), net(halves[1])), side, dist, dte, take, stop, trades, halves, worst))
    print("side  dist dte take stop | trades  won  | first half      | second half     | worst trade")
    for m, side, dist, dte, take, stop, trades, halves, worst in sorted(results, key=lambda r: -r[0]):
        f = lambda ts: f"{sum(t['pnl500'] for t in ts):+7.0f} ({100 * sum(1 for t in ts if t['pnl500'] > 0) / max(1, len(ts)):.0f}%)"
        print(f"{side:4} {dist:4.0f}% {dte:3}d {('50%' if take else ' - '):4} {(f'{stop:.0f}x' if stop else ' - '):4} | {len(trades):5} {100 * sum(1 for t in trades if t['pnl500'] > 0) / len(trades):4.0f}% | {f(halves[0])} | {f(halves[1])} | {worst:+.0f}")
    if "--trades" in sys.argv:
        for m, side, dist, dte, take, stop, trades, *_ in sorted(results, key=lambda r: -r[0])[:2]:
            print(f"\n{side} {dist}% {dte}d take={take} stop={stop}")
            for t in trades:
                print(f"  {t['sym']} {t['day']} spot {t['spot']} short {t['short']} credit {t['credit']} {t['exit']:6} {t['pnl500']:+.0f}")


if __name__ == "__main__":
    main()
