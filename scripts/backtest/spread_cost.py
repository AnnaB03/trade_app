"""What does the bid/ask spread cost us, and would buying and selling at the
mid have filled? (owner, 2026-11-04: "lets do all").

For every option trade since the restart, from ThetaData's 1-minute quotes
of that contract (the local Theta Terminal):
  - the half-spread paid on the buy (ask - mid) and on the sale (mid - bid),
    in dollars, at the minute of each fill;
  - a patient order: a buy limit at that minute's mid fills if the ask comes
    down to it within WAIT minutes; a sale at the mid fills if the bid comes
    up to it. That is a strict test: a real resting order at the mid often
    fills without the quote crossing it, so the true fill rate is higher.
  - what a patient order that missed would have paid instead (it chases at
    the ask/bid after WAIT minutes), so the saving is net of misses.

    python3 scripts/backtest/spread_cost.py            # WAIT=2
    WAIT=5 python3 scripts/backtest/spread_cost.py
"""
import json, os, re, sqlite3, statistics, urllib.request, datetime as dt
from zoneinfo import ZoneInfo

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
ET = ZoneInfo("America/New_York")
WAIT = int(os.environ.get("WAIT", 2))
CACHE = os.path.join(ROOT, "data", "backtest", "option_quotes")
et = lambda iso: dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET)


def quotes(occ, day):
    """{HH:MM: (bid, ask)} for one contract and day, cached."""
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, f"{occ}_{day:%Y%m%d}.json")
    if os.path.exists(f):
        return {k: tuple(v) for k, v in json.load(open(f)).items()}
    sym, exp, right, k = re.match(r"([A-Z]+)(\d{6})([CP])(\d{8})", occ).groups()
    url = (f"http://127.0.0.1:25503/v3/option/history/quote?symbol={sym}&expiration=20{exp}&strike={int(k) / 1000:.3f}"
           f"&right={'call' if right == 'C' else 'put'}&date={day:%Y%m%d}&interval=1m&format=json")
    try:
        d = json.load(urllib.request.urlopen(url, timeout=120))["response"][0]["data"]
    except Exception:
        return None
    q = {x["timestamp"][11:16]: (x["bid"], x["ask"]) for x in d if x["bid"] > 0 and x["ask"] > 0}
    json.dump(q, open(f, "w"))
    return q


def at(q, t):
    """The quote at minute t, or the last one before it."""
    keys = [k for k in q if k <= t]
    return q[max(keys)] if keys else None


def sane_mid(q, t):
    """The mid at t, skipping blown-out quotes (spread over 30% of the mid): the nearest sane minute within 3."""
    for d in (0, 1, -1, 2, -2, 3, -3):
        x = at(q, plus(t, d))
        if x and (x[1] - x[0]) / ((x[0] + x[1]) / 2) <= 0.3:
            return (x[0] + x[1]) / 2
    return None


def plus(t, m):
    return (dt.datetime.strptime(t, "%H:%M") + dt.timedelta(minutes=m)).strftime("%H:%M")


def main():
    rows = [json.loads(x[0]) for x in sqlite3.connect(os.path.join(ROOT, "data", "cockpit.db")).execute("select data from journal")]
    trades = [r for r in rows if r.get("vehicle") == "OPTION" and r.get("entryFillPrice") and r.get("entryAt") and r.get("occ")
              and r["entryAt"] >= "2026-10-07" and r.get("exitReasonTag") not in ("unfilled", "orphaned")]
    out = []
    for r in trades:
        e = et(r["entryAt"]); q = quotes(r["occ"], e.date())
        if not q:
            continue
        n = (r.get("entryFilledQuantity") or r.get("entryQuantity") or 1) * 100
        te = e.strftime("%H:%M"); qe = at(q, te)
        if not qe:
            continue
        bid, ask = qe; mid = (bid + ask) / 2
        row = {"sym": r["symbol"], "day": e.date().isoformat(), "spread_pct": (ask - bid) / mid * 100,
               "buy_half_usd": (ask - mid) * n, "pnl": r.get("pnl") or 0}
        # what we really paid against the market's mid (blown-out quotes skipped)
        m1 = sane_mid(q, te)
        if m1 and r.get("exitAt") and r.get("exitFillPrice") is not None:
            xq = et(r["exitAt"]); qxq = quotes(r["occ"], xq.date()); m2 = sane_mid(qxq, xq.strftime("%H:%M")) if qxq else None
            if m2:
                row["paid_buy"] = (r["entryFillPrice"] - m1) * n
                row["paid_sell"] = (m2 - r["exitFillPrice"]) * n
                row["mid_to_mid"] = (m2 - m1) * n
        # patient buy: did the ask come down to the mid within WAIT minutes?
        later = [at(q, plus(te, m)) for m in range(1, WAIT + 1)]
        hit = any(x and x[1] <= mid for x in later)
        chase = later[-1][1] if later and later[-1] else ask
        row["buy_filled_mid"] = hit
        row["buy_saving_usd"] = (ask - (mid if hit else chase)) * n
        if r.get("exitAt") and r.get("exitFillPrice") is not None:
            x = et(r["exitAt"]); qx = quotes(r["occ"], x.date()) if x.date() != e.date() else q
            tx = x.strftime("%H:%M"); qq = at(qx, tx) if qx else None
            if qq:
                b2, a2 = qq; m2 = (b2 + a2) / 2
                row["sell_half_usd"] = (m2 - b2) * n
                urgent = r.get("exitReasonTag") in ("stop", "stop_hit", "eod_flat", "invalidation")   # a stop or the 15:45 sale cannot wait
                later2 = [at(qx, plus(tx, m)) for m in range(1, WAIT + 1)]
                hit2 = (not urgent) and any(y and y[0] >= m2 for y in later2)
                chase2 = later2[-1][0] if later2 and later2[-1] else b2
                row["sell_filled_mid"] = hit2
                row["sell_saving_usd"] = 0 if urgent else ((m2 if hit2 else chase2) - b2) * n
                row["urgent"] = urgent
        out.append(row)
    print(f"{len(out)} of {len(trades)} option trades had ThetaData quotes (patient order waits {WAIT} min)")
    tot = lambda k: sum(t.get(k, 0) for t in out)
    f = [t for t in out if "mid_to_mid" in t]
    print(f"  WHAT WE PAID against the mid ({len(f)} trades): buys ${sum(t['paid_buy'] for t in f):,.0f} + sales ${sum(t['paid_sell'] for t in f):,.0f}"
          f" = ${sum(t['paid_buy'] + t['paid_sell'] for t in f):,.0f}, of a net P&L of ${sum(t['pnl'] for t in f):,.0f};"
          f" the trades themselves, mid to mid: ${sum(t['mid_to_mid'] for t in f):,.0f}")
    md = sorted(t["day"] for t in f)[len(f) // 2]
    for part, g in (("first half", lambda t: t["day"] < md), ("second half", lambda t: t["day"] >= md)):
        x = [t for t in f if g(t)]
        print(f"    {part}: net ${sum(t['pnl'] for t in x):,.0f} = spread ${-sum(t['paid_buy'] + t['paid_sell'] for t in x):,.0f} + mid to mid ${sum(t['mid_to_mid'] for t in x):,.0f} + fees and the rest")
    print("  (the quote-based lines below count the full quoted spread at the fill minute, which overstates it when quotes blow out)")
    print(f"  spread at the buy: median {statistics.median(t['spread_pct'] for t in out):.1f}% of the mid; "
          f"{sum(t['spread_pct'] > 6 for t in out)} trades over 6%")
    print(f"  paid in half-spreads: buys ${tot('buy_half_usd'):,.0f} + sales ${tot('sell_half_usd'):,.0f} = ${tot('buy_half_usd') + tot('sell_half_usd'):,.0f}"
          f"  (the options' net P&L on these trades: ${sum(t['pnl'] or 0 for t in out):,.0f})")
    b = [t for t in out]; s = [t for t in out if "sell_filled_mid" in t and not t.get("urgent")]
    print(f"  patient buy at the mid filled {sum(t['buy_filled_mid'] for t in b)} of {len(b)}; net saving after chasing the misses ${tot('buy_saving_usd'):,.0f}")
    print(f"  patient sale at the mid (profit sales only; stops and 15:45 sell at once) filled {sum(t['sell_filled_mid'] for t in s)} of {len(s)}; net saving ${tot('sell_saving_usd'):,.0f}")
    mid_d = sorted(t["day"] for t in out)[len(out) // 2]
    for part, f in (("first half", lambda t: t["day"] < mid_d), ("second half", lambda t: t["day"] >= mid_d)):
        x = [t for t in out if f(t)]
        print(f"    {part}: {len(x)} trades, saving ${sum(t.get('buy_saving_usd', 0) + t.get('sell_saving_usd', 0) for t in x):,.0f}")


if __name__ == "__main__":
    main()
