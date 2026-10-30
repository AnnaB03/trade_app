"""Score the trend-day read (app/api/trendDayLib.js) against how each day closed.

For every day in data/trendday.json and each reading time (10:30, 11:00,
12:00): what the read said, and how far QQQ went from that moment to the
15:59 close in the flagged direction. A "trend" or "lean" read is right when
QQQ kept going its way after it was called.

    python3 scripts/trendday-report.py
"""
import json, os

ROOT = os.path.join(os.path.dirname(__file__), "..")
path = os.path.join(ROOT, "data", "trendday.json")
days = json.load(open(path)) if os.path.exists(path) else {}
score = {}
for day in sorted(days):
    d = days[day]; close = (d.get("last") or {}).get("qqqLast")
    for slot in ("10:30", "11:00", "12:00"):
        r = d.get("slots", {}).get(slot)
        if not r or not close or not r.get("qqqLast"):
            continue
        after = (close - r["qqqLast"]) / r["qqqLast"] * 100
        flag = r.get("flag", "?")
        kind = flag.split("_")[0]
        if r.get("side") in ("up", "down") and kind in ("trend", "lean"):
            more = after if r["side"] == "up" else -after
            s = score.setdefault((slot, kind), [0, 0, 0.0]); s[0] += 1; s[1] += more > 0; s[2] += more
            b = r.get("breadth") or {}
            print(f"{day} {slot} {flag:10} QQQ {r['qqqMove']:+.2f}% by then (breadth {b.get('down', '?')} down / {b.get('up', '?')} up of {b.get('total', '?')}), then {after:+.2f}% to the close -> {'kept going' if more > 0 else 'turned back'}")
        else:
            print(f"{day} {slot} {flag:10} QQQ {(r.get('qqqMove') or 0):+.2f}% by then, then {after:+.2f}% to the close")
print()
for (slot, kind), (n, right, total) in sorted(score.items()):
    print(f"{kind:5} read at {slot}: {n} days, kept going on {right}, average further move {total / n:+.2f}%")
if not score:
    print("No trend or lean reads recorded yet.")
