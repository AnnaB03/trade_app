#!/bin/bash
# Publish the live record (owner, 2026-11-11) to the public site
# https://cockpit-ai-record.github.io: fetch the read-only record from this Mac's
# server and push data.json when it changed, or at least every 30 minutes so the
# page's "last update" stays fresh. Runs from ~/.cockpit (launchd cannot read
# ~/Documents); commits are signed "Cockpit AI", never the owner's name.
set -uo pipefail
# launchd's PATH finds Apple's /usr/bin/git, which does not read Homebrew's
# gitconfig and so has no credential helper: every scheduled push failed
# silently from 11/11 to 11/20 (141 updates never reached the site). Use
# Homebrew's git when present, name the keychain helper explicitly, and log a
# failed push.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
LOG="${COCKPIT_LOG:-$HOME/Library/Logs/cockpit-autopilot.log}"
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
cd "$SITE" && git add data.json && git -c user.name="Cockpit AI" -c user.email="cockpit-ai-record@users.noreply.github.com" commit -q -m "Record update $(TZ=America/New_York date '+%Y-%m-%d %H:%M') ET" && { git -c credential.helper=osxkeychain push -q origin main >/dev/null 2>&1 || echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR scoreboard push failed (the public record is not updating)" >> "$LOG"; }
exit 0
