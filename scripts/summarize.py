#!/usr/bin/env python3
"""One-line summary of a Cockpit route response, for the autopilot log.

Prints nothing when a run was a clean no-op, so a per-minute exit check does not
bury real events in the log. Prints a line whenever something was closed,
opened, or went wrong.
"""
import json
import os
import sys
from collections import Counter

path = sys.argv[1]
try:
    d = json.load(open(path))
except Exception as e:
    print(f"unparseable response ({e})")
    sys.exit(0)

if isinstance(d, dict) and "error" in d:
    print("ERROR: " + str(d["error"])[:200])
    sys.exit(0)

ideas = d.get("ideas") or d.get("suggestions")
if isinstance(ideas, list):
    shorts = [x.get("symbol") for x in ideas if x.get("action") in ("PUT", "SELL")]
    line = f"ideas={len(ideas)} {dict(Counter(x.get('action') for x in ideas))}"
    if shorts:
        line += f"  SHORTS: {','.join(str(s) for s in shorts)}"
    print(line)
    sys.exit(0)

# A halted book places nothing, which would otherwise read as a quiet run —
# but the same-day entry pass runs every minute, so a halt is logged when it
# starts (or its reason changes) and when it lifts, not on every run. The
# marker is shared by both entry passes, since they share one halt.
HALT_MARK = os.environ.get("COCKPIT_HALT_MARK", "/tmp/cockpit-halt-state")
if isinstance(d, dict) and "candidateCount" in d:  # an entry-route response
    try:
        before = open(HALT_MARK).read()
    except OSError:
        before = None
    if d.get("halted"):
        now = f"{d.get('haltKind')}: {str(d.get('haltReason'))[:200]}"
        if now != before:
            print(f"HALTED ({now.split(': ', 1)[0]}): {now.split(': ', 1)[1]}")
            try:
                open(HALT_MARK, "w").write(now)
            except OSError:
                pass
        sys.exit(0)
    if before is not None:
        print("RESUMED: new entries allowed again")
        try:
            os.remove(HALT_MARK)
        except OSError:
            pass

acted = []
for r in d.get("results") or []:
    if not isinstance(r, dict):
        continue
    if r.get("closed"):
        acted.append(f"CLOSED {r.get('symbol')} {r.get('tag') or ''} @{r.get('exitPrice')}")
    elif r.get("placed"):
        acted.append(f"OPENED {r.get('symbol')} {r.get('action') or ''}")

if acted:
    counts = " ".join(f"{k}={d[k]}" for k in ("closed", "placed", "checked") if d.get(k) is not None)
    print(f"{counts} | " + "; ".join(acted))
