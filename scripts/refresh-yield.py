#!/usr/bin/env python3
"""Does refreshing more often produce more positions?  (experiment from 2026-10-06)

Per trading day: refreshes (billed calls), directional ideas split into NEW
(symbol+direction not already called in the previous 3 hours) versus REPEATS,
positions opened, and positions per refresh. Compare days before the change
(hourly refresh, through 2026-10-06) with days after (every 30 minutes).

Read it with care: a position count depends on the tape that day as much as on
the schedule, so a few days is a direction, not a result.
"""
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHANGE_DAY = "2026-10-07"   # first full day on the 30-minute schedule
D = ("CALL", "PUT", "BUY", "SELL")
ideas = [i for i in json.load(open(os.path.join(ROOT, "data/ideas.json"))) if not i.get("strategy")]
journal = json.load(open(os.path.join(ROOT, "data/journal.json")))
since = sys.argv[1] if len(sys.argv) > 1 else "2026-09-29"
ideas = [i for i in ideas if i["createdAt"] >= since]

batches = defaultdict(list)
for i in ideas:
    batches[i["createdAt"][:16]].append(i)

parse = lambda s: datetime.fromisoformat(s[:19])
seen, per_day = [], defaultdict(lambda: Counter())
for minute in sorted(batches):
    day = minute[:10]
    per_day[day]["refreshes"] += 1
    t = parse(minute)
    for i in batches[minute]:
        if i["action"] not in D:
            continue
        key = (i["symbol"], i["action"])
        dup = any(k == key and (t - st) < timedelta(hours=3) for k, st in seen)
        per_day[day]["repeat" if dup else "new"] += 1
    seen += [((i["symbol"], i["action"]), t) for i in batches[minute] if i["action"] in D]

for r in journal:
    if r["createdAt"] >= since:
        per_day[r["createdAt"][:10]]["positions"] += 1

print(f"{'day':11} {'refreshes':>9} {'new ideas':>9} {'repeats':>8} {'positions':>9} {'pos/refresh':>11}  schedule")
for day in sorted(per_day):
    c = per_day[day]
    if not c["refreshes"]:
        continue
    sched = "30-min" if day >= CHANGE_DAY else "hourly"
    print(f"{day:11} {c['refreshes']:>9} {c['new']:>9} {c['repeat']:>8} {c['positions']:>9} {c['positions'] / c['refreshes']:>11.2f}  {sched}")

for label, test in (("hourly", lambda d: d < CHANGE_DAY), ("30-min", lambda d: d >= CHANGE_DAY)):
    days = [d for d in per_day if per_day[d]["refreshes"] and test(d)]
    if not days:
        print(f"\n{label}: no full days yet")
        continue
    tot = Counter()
    for d in days:
        tot.update(per_day[d])
    n = len(days)
    print(f"\n{label}: {n} days | per day: {tot['refreshes'] / n:.1f} refreshes, {tot['new'] / n:.1f} new ideas, "
          f"{tot['positions'] / n:.1f} positions | new ideas per refresh {tot['new'] / max(tot['refreshes'], 1):.2f}")
