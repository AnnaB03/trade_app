#!/bin/bash
# Publish the live record (owner, 2026-11-11) to the public site
# https://cockpit-ai-record.github.io: fetch the read-only record from this Mac's
# server and push data.json when it changed, or at least every 30 minutes so the
# page's "last update" stays fresh. Runs from ~/.cockpit (launchd cannot read
# ~/Documents); commits are signed "Cockpit AI", never the owner's name.
set -uo pipefail
SITE="$HOME/.cockpit/scoreboard-site"
BASE="${COCKPIT_BASE:-http://localhost:3000}"
[ -d "$SITE/.git" ] || exit 0
tmp=$(mktemp)
curl -s --max-time 20 "$BASE/api/scoreboard" > "$tmp" || { rm -f "$tmp"; exit 0; }
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d.get('paper') is True and 'trades' in d" "$tmp" 2>/dev/null || { rm -f "$tmp"; exit 0; }
same=$(python3 - "$tmp" "$SITE/data.json" <<'PY'
import json,sys
try:
    a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
    a.pop("generatedAt",None); b.pop("generatedAt",None)
    print("yes" if a==b else "no")
except Exception: print("no")
PY
)
age=$(( $(date +%s) - $(git -C "$SITE" log -1 --format=%ct 2>/dev/null || echo 0) ))
if [ "$same" = "yes" ] && [ "$age" -lt 1800 ]; then rm -f "$tmp"; exit 0; fi
mv "$tmp" "$SITE/data.json"
cd "$SITE" && git add data.json && git -c user.name="Cockpit AI" -c user.email="cockpit-ai-record@users.noreply.github.com" commit -q -m "Record update $(TZ=America/New_York date '+%Y-%m-%d %H:%M') ET" && git push -q origin main >/dev/null 2>&1
exit 0
