"""Backtest the trend-day idea on the saved weekly chains (fetch_chains.py).

On each trading day with a weekly chain 1-4 days from expiry: if the stock
has moved at least MOVE% from the first quote of the day by CHECK time, buy
the at-the-money option in that direction (with the trend), or against it
(the control). Bought at the ask, sold at the bid; judged every 15 minutes:
a 20% stop at the mid, then either a fixed dollar sale (TAKE, like the
Cockpit's quick sale) or held to 15:45. Sized like the Cockpit: $500 at the
20% stop, so the dollar sale is comparable to the live +$80.

    BT_FROM=2022-01-01 BT_TO=2022-12-31 python3 scripts/backtest/trend_day.py
"""
import glob, os, sys, datetime as dt, itertools
sys.path.insert(0, os.path.dirname(__file__))
from credit_spreads import load, spot, nearest_strike, DATA

STOP, RISK, FEE = 0.20, 500.0, 0.35


def trade(q, day, check, move, with_trend, take):
    d = day.isoformat()
    times = sorted({t for qs in q.values() for t in qs if t[:10] == d})
    if not times:
        return None
    first = times[0]
    at = next((t for t in times if t[11:] >= check), None)
    s0, s1 = spot(q, first), spot(q, at) if at else None
    if not (s0 and s1):
        return None
    mv = (s1 - s0) / s0 * 100
    if abs(mv) < move:
        return None
    up = mv > 0
    right = ("C" if up else "P") if with_trend else ("P" if up else "C")
    k = nearest_strike(q, s1)
    oq = q.get((k, right), {})
    if at not in oq or oq[at][1] <= 0:
        return None
    ask = oq[at][1]
    n = RISK / (ask * STOP * 100)               # contracts for $500 at the 20% stop (fractional: comparable)
    for t in times:
        if t <= at or t not in oq:
            continue
        b, a = oq[t]
        if b <= 0:
            continue
        gain = (b - ask) * 100 * n
        if ((b + a) / 2 - ask) / ask <= -STOP or t[11:] >= "15:45" or (take and gain > take):
            return gain - 2 * FEE * n, mv
    return None


def main():
    lo, hi = os.environ.get("BT_FROM", "2025-10-27"), os.environ.get("BT_TO", "2026-10-30")
    files = [f for f in sorted(glob.glob(os.path.join(DATA, "*.json.gz")))
             if lo.replace("-", "") <= os.path.basename(f).split("_")[1][:8] <= hi.replace("-", "")]
    chains = [load(f) for f in files]
    print(f"{lo} to {hi}: {len(chains)} weekly chains")
    print("check  move  side      exit   | days  won  | first half      | second half     | total")
    for check, move, with_trend, take in itertools.product(("10:30", "11:00"), (0.5, 1.0), (True, False), (80, None)):
        res = []
        for sym, exp, q in chains:
            for back in (1, 2, 3, 4):
                day = exp - dt.timedelta(days=back)
                if day.weekday() < 5:
                    r = trade(q, day, check, move, with_trend, take)
                    if r:
                        res.append((day, sym, r[0]))
        if len(res) < 10:
            continue
        res.sort()
        h = len(res) // 2
        f = lambda xs: f"{sum(x[2] for x in xs):+7.0f} ({100 * sum(1 for x in xs if x[2] > 0) / max(1, len(xs)):.0f}%)"
        print(f"{check}  {move:.1f}%  {'with' if with_trend else 'against':8}  {('+$' + str(take)) if take else '15:45':6} | {len(res):4} {100 * sum(1 for x in res if x[2] > 0) / len(res):4.0f}% | {f(res[:h])} | {f(res[h:])} | {sum(x[2] for x in res):+.0f}")


if __name__ == "__main__":
    main()
