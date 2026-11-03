"""Trade-by-trade review of one day, on real minute prices (owner, 2026-11-03:
"look into all today's losses and winners ... at which point stocks and
options would have made us money ... lets do that every day and see if we
find a pattern").

For every trade bought that day:
  - the best and worst point after the buy (how far in our favour / against
    us, and when), on what we could have SOLD at: the option's bid, the
    stock's minute low/high;
  - the sale: what the best moment after the buy would have made, and where
    the price was at 15:45 (did a stopped trade recover, did a profit sale
    leave a run on the table?);
  - the buy: the best price we could have paid in the 30 minutes after the
    actual buy (would waiting have helped?);
  - losers that were green first (a break-even stop would have saved them).
Options come from the local Theta Terminal (ThetaData quotes), shares from
Tradier 1-minute bars. Each day is saved to data/trade_review/<date>.json,
and the summary at the end reads every saved day, so patterns build up.

    python3 scripts/trade-review.py              # today (New York date)
    python3 scripts/trade-review.py 2026-11-03   # a given day
"""
import json, os, re, sqlite3, sys, urllib.parse, urllib.request, datetime as dt, glob, statistics
from zoneinfo import ZoneInfo

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "data", "trade_review")
ET = ZoneInfo("America/New_York")
et = lambda iso: dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET)
TOK = next((l.split("=", 1)[1].strip().strip('"') for l in open(os.path.join(ROOT, ".env.local")) if l.startswith("TRADIER_TOKEN=")), None)


def option_path(occ, day):
    m = re.match(r"([A-Z]+)(\d{6})([CP])(\d{8})", occ)
    sym, exp, right, k = m.groups()
    url = (f"http://127.0.0.1:25503/v3/option/history/quote?symbol={sym}&expiration=20{exp}&strike={int(k) / 1000:.3f}"
           f"&right={'call' if right == 'C' else 'put'}&date={day:%Y%m%d}&interval=1m&format=json")
    try:
        d = json.load(urllib.request.urlopen(url, timeout=120))["response"][0]["data"]
    except Exception:
        return None
    # (minute, value if sold = bid, cost if bought = ask)
    return [(x["timestamp"][11:16], x["bid"], x["ask"]) for x in d if x["bid"] > 0 and x["ask"] > 0]


def stock_path(sym, day):
    q = urllib.parse.urlencode({"symbol": sym, "interval": "1min", "start": f"{day} 09:30", "end": f"{day} 16:00"})
    req = urllib.request.Request("https://api.tradier.com/v1/markets/timesales?" + q, headers={"Authorization": "Bearer " + TOK, "Accept": "application/json"})
    try:
        d = (json.load(urllib.request.urlopen(req, timeout=60)).get("series") or {}).get("data") or []
    except Exception:
        return None
    d = [d] if isinstance(d, dict) else d
    # shares: sold near the minute's low on the way down, high on the way up; bought near its close
    return [(b["time"][11:16], b["low"], b["high"], b["close"]) for b in d]


def review(r, day):
    e, x = et(r["entryAt"]), (et(r["exitAt"]) if r.get("exitAt") else None)
    opt = r.get("vehicle") == "OPTION"
    q = r.get("entryFilledQuantity") or r.get("entryQuantity") or 1
    mult = 100 if opt else 1
    ep, xp = r["entryFillPrice"], r.get("exitFillPrice")
    end = "15:45"
    em = e.strftime("%H:%M")
    if opt:
        p = option_path(r["occ"], day)
        if not p:
            return None
        after = [(t, b) for t, b, a in p if em < t <= end]
        buy30 = [a for t, b, a in p if em <= t <= (e + dt.timedelta(minutes=30)).strftime("%H:%M")]
        at_end = next((b for t, b, a in p if t >= end), after[-1][1] if after else None)
    else:
        p = stock_path(r["symbol"], day)
        if not p:
            return None
        after = [(t, hi) for t, lo, hi, c in p if em < t <= end]        # best case: sold at the minute's high
        worst = [(t, lo) for t, lo, hi, c in p if em < t <= end]
        buy30 = [c for t, lo, hi, c in p if em <= t <= (e + dt.timedelta(minutes=30)).strftime("%H:%M")]
        at_end = next((c for t, lo, hi, c in p if t >= end), None)
    if not after:
        return None
    best_t, best = max(after, key=lambda z: z[1])
    worst_t, low = min(worst if not opt else after, key=lambda z: z[1])
    pct = lambda v: (v - ep) / ep * 100
    row = {
        "symbol": r["symbol"], "kind": (r.get("optionType") or "shares"), "playbook": r.get("strategy") or "swing",
        "bought": em, "entry": ep, "sold": x.strftime("%H:%M") if x else None, "exit": xp, "why": r.get("exitReasonTag"),
        "pnl": round(r["pnl"], 2) if isinstance(r.get("pnl"), (int, float)) else None,
        "best_pct": round(pct(best), 1), "best_at": best_t, "best_usd": round((best - ep) * q * mult, 2),
        "worst_pct": round(pct(low), 1), "worst_at": worst_t,
        "at_1545_pct": round(pct(at_end), 1) if at_end else None,
        "cheapest_buy_30min_pct": round(pct(min(buy30)), 1) if buy30 else None,
        "minutes_to_best": int((dt.datetime.strptime(best_t, "%H:%M") - dt.datetime.strptime(em, "%H:%M")).total_seconds() // 60),
    }
    if xp is not None:
        row["left_on_table_usd"] = round((best - xp) * q * mult, 2)          # best moment after the buy vs the actual sale
        row["after_sale_to_1545_pct"] = round((at_end - xp) / xp * 100, 1) if at_end else None
    return row


def summarize(rows, label):
    w = [r for r in rows if (r["pnl"] or 0) > 0]; l = [r for r in rows if r["pnl"] is not None and r["pnl"] <= 0]
    print(f"\n{label}: {len(rows)} trades, {len(w)} won, net {sum(r['pnl'] or 0 for r in rows):+.0f}")
    if w:
        print(f"  winners: sold on average at {statistics.mean([(r['exit'] - r['entry']) / r['entry'] * 100 for r in w if r['exit']]):+.1f}%, "
              f"the best moment after the buy averaged {statistics.mean([r['best_pct'] for r in w]):+.1f}%; "
              f"left on the table {sum(r.get('left_on_table_usd', 0) for r in w):+.0f}")
    if l:
        green = [r for r in l if r["best_pct"] >= 3]
        rec = [r for r in l if r.get("at_1545_pct") is not None and r["at_1545_pct"] > 0]
        firsts = ", ".join(f"{r['symbol']} {r['best_pct']:+.0f}%" for r in green) or "none"
        print(f"  losers: {len(green)} of {len(l)} were up 3%+ first ({firsts}); "
              f"{len(rec)} were above their buy price again by 15:45")
    better = [r for r in rows if r["cheapest_buy_30min_pct"] is not None and r["cheapest_buy_30min_pct"] <= -2]
    print(f"  buys: waiting up to 30 minutes would have bought 2%+ cheaper on {len(better)} of {len(rows)}")
    by_hour = {}
    for r in rows:
        by_hour.setdefault(r["bought"][:2], []).append(r["pnl"] or 0)
    print("  by hour bought: " + ", ".join(f"{h}:00 {sum(v):+.0f} ({len(v)})" for h, v in sorted(by_hour.items())))


def main():
    day = dt.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else dt.datetime.now(ET).date()
    rows = [json.loads(x[0]) for x in sqlite3.connect(os.path.join(ROOT, "data", "cockpit.db")).execute("select data from journal")]
    todays = sorted([r for r in rows if r.get("entryFillPrice") and r.get("entryAt") and et(r["entryAt"]).date() == day
                     and r.get("exitReasonTag") not in ("unfilled", "orphaned")], key=lambda r: r["entryAt"])
    out = []
    for r in todays:
        v = review(r, day)
        if v:
            out.append(v)
    os.makedirs(OUT, exist_ok=True)
    json.dump(out, open(os.path.join(OUT, f"{day}.json"), "w"), indent=1)
    print(f"{day}: {len(out)} of {len(todays)} trades reviewed (the rest had no minute prices)")
    print("sym   kind   bought sold   why              pnl    | best after buy      worst        | at 15:45 | 30-min cheaper buy | left on table")
    for r in out:
        print(f"{r['symbol']:5} {r['kind'][:5]:6} {r['bought']}  {r['sold'] or 'open ':5}  {(r['why'] or '')[:15]:15} {r['pnl'] if r['pnl'] is not None else 0:+7.0f} | "
              f"{r['best_pct']:+6.1f}% at {r['best_at']} | {r['worst_pct']:+6.1f}% at {r['worst_at']} | {r['at_1545_pct'] if r['at_1545_pct'] is not None else 0:+6.1f}% | "
              f"{r['cheapest_buy_30min_pct'] if r['cheapest_buy_30min_pct'] is not None else 0:+6.1f}% | {r.get('left_on_table_usd', 0):+7.0f}")
    summarize(out, f"{day}")
    every = []
    for f in sorted(glob.glob(os.path.join(OUT, "*.json"))):
        every += json.load(open(f))
    if len(glob.glob(os.path.join(OUT, "*.json"))) > 1:
        summarize(every, f"All reviewed days ({len(glob.glob(os.path.join(OUT, '*.json')))})")
        for kind in ("option", "shares"):
            sub = [r for r in every if (r["kind"] == "shares") == (kind == "shares")]
            if sub:
                summarize(sub, f"  {kind}s only")


if __name__ == "__main__":
    main()
