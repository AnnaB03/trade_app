# Build plan: "Opening drive" signal in the Ideas tab

## 1. What this is, and what it is not

Two rounds of analysis (Sep 2026, FMP daily and 30-minute bars) established:

| Question | Answer | Evidence |
|---|---|---|
| Does another stock's move predict SPY/SPX the next day? | No | Lag-1 correlations of -0.12 to 0.00 for NVDA, AAPL, JPM, HYG, IWM vs SPY; sign hit rates 46-54% over 250 days |
| Does yesterday's move predict the next morning's gap or first 30 minutes? | No | Pooled NVDA/AAPL/TSLA, 228 days: correlations -0.11 to 0.06; hit rates 43-52% |
| Does the first 30 minutes predict the rest of the day? | Yes, modestly | Pooled correlation 0.25 (noise band ±0.13); TSLA 0.34, AAPL 0.17, NVDA 0.13; hit rate 54-59% |

So the only thing worth building is the third row: an **opening-drive** read
(9:30 open to 10:00 ET) that biases ideas for the rest of the session, and
that the track record can confirm or refute over time.

Explicitly out of scope: any "yesterday predicts today's open" rule, and any
cross-stock lead-lag rule. Both were tested and carry no signal.

Caveat on the evidence: one summer, three correlated mega-caps. The plan below
therefore treats the signal as **context the model sees and the ledger
grades**, not a hard gate, until the app's own calibration data (n ≥ 30 per
bucket) says whether "with the drive" ideas actually outperform.

## 2. Signal definition

For each symbol on a given session:

```
open      = first regular-session trade at 9:30 ET
at10      = last trade at or before 10:00 ET
drivePct  = (at10 - open) / open * 100
typical   = median |drivePct| over the prior 20 sessions for that symbol
             (fallback when history is unavailable: 0.5 × today's implied
             daily move from the option chain, else 0.6%)
strength  = |drivePct| / typical
state     = "strong up"   if drivePct > 0 and strength >= 1.0
            "strong down" if drivePct < 0 and strength >= 1.0
            "flat"        if strength < 0.5
            "mild up" / "mild down" otherwise
            "pending"     before 10:00 ET (partial read, not used for bias)
            "n/a"         market closed, holiday, or no intraday data
```

Also computed once per refresh for **SPY** (the tape's own drive), so the
regime block and the banner carry a market-wide read alongside per-symbol
ones.

The signal is fixed after 10:00 ET and stays valid for the session. A
refresh at 2:30 still sees "strong up (as of 10:00)". Extra flags:

- `gapPct` > 1.5% in absolute terms → append "post-gap; drive is noisier"
  (the drive after a large gap was the least consistent slice in the data).
- `dataMode() === "delayed"` (sandbox token, 15-minute lag) → the 10:00
  print is not available until ~10:15; state stays "pending" until then and
  the text says why.

## 3. Data source

Tradier `GET /markets/timesales?symbol=X&interval=5min&start=YYYY-MM-DD 09:30&end=YYYY-MM-DD 10:00&session_filter=open`.
The app already calls this endpoint with `session_filter=all` in
`app/api/extended.js` and `app/api/moversLib.js`, so no new credentials or
client code. One call per symbol per refresh, cached per symbol per session
date (immutable once 10:00 has passed, so the cache never needs a TTL
shorter than the trading day).

For the 20-session `typical` baseline: Tradier keeps 5-minute timesales for
roughly 40 calendar days, so a per-symbol history of first-30-minute moves
can be seeded from timesales on first use and then appended daily to a
small JSON file under `data/` (same pattern and same read-only-filesystem
caveat as `app/api/store.js`). If the seed call fails, fall back to the
implied-move heuristic above rather than blocking the signal.

## 4. Files and changes

### Phase 0: validate on the app's own data feed (no product change)

- **New** `scripts/openingDriveBacktest.mjs`
  Node script, run with `node scripts/openingDriveBacktest.mjs NVDA AAPL TSLA SPY`.
  Pulls 5-minute timesales for the last ~40 sessions from Tradier, computes
  `drivePct` and `rest = close / at10 - 1`, prints correlation, sign hit rate,
  and hit rate conditional on `state` being strong. Reproduces the FMP
  numbers on Tradier data before anything is wired in.
  Acceptance: pooled correlation of first-30 to rest-of-day is positive and
  outside the noise band on Tradier bars too. If it is not, stop here.

### Phase 1: compute the signal and show it to the model (information only)

- **New** `app/api/openingDriveLib.js`
  - `openingDrive(symbol, { sessionDate, clockState })` → `{ open, at10, drivePct, typical, strength, state, asOf, note }`. Never throws; returns `state: "n/a"` on any failure.
  - `openingDriveText(d)` → one short phrase for the prompt, e.g. `opening drive +0.9% by 10:00 (strong up, 1.6× its usual)`.
  - Per-session in-memory cache keyed `${symbol}:${sessionDate}`.
- **Edit** `app/lib/checks.js`
  Add pure `classifyDrive(drivePct, typical)` returning `{ strength, state }`, so the thresholds are unit-testable without network.
- **Edit** `app/api/regimeLib.js`
  `marketRegime()` gains `spyDrive` (from `openingDrive("SPY")`) and `regimeText()` appends one line: `Opening drive (SPY, 9:30-10:00): +0.4% — mild up.` Or `pending until 10:00 ET` before then.
- **Edit** `app/api/suggestions/route.js`
  - In the `structureBySym` block, call `openingDrive(sym, ...)` in the same `Promise.all` as `dailyBars`, and store it on `structureBySym[sym].drive`.
  - In the MARKET DATA line builder, append `openingDriveText(s.drive)` when state is not `n/a`.
  - Persist on the ledger row in `appendIdea(...)`: `openingDriveState`, `openingDrivePct`, `spyDriveState`, and `driveAligned` (`"with"`, `"against"`, `"flat"`, or `null`) computed server-side from the idea's action direction vs the symbol's drive sign. This is what makes Phase 3 possible.
- **Edit** `app/api/regime/route.js`
  No logic change; the 5-minute cache means the banner will show "pending" until the first refresh after 10:00. Acceptable. If it bothers, drop the TTL to 60s between 9:55 and 10:10 ET.

Acceptance: a refresh after 10:00 shows the drive phrase on every MARKET DATA
line and in the regime block; a refresh before 10:00 shows "pending"; a
weekend refresh shows nothing. Ledger rows carry the four new fields.

### Phase 2: let the signal influence ideas, and surface it in the UI

- **Edit** `app/api/suggestions/route.js` (prompt)
  Add requirement **1c** next to 1b:
  > After 10:00 ET the first half hour has already told you which way the session is leaning: in this app's own data the 9:30-10:00 direction agrees with the 10:00-close direction more often than not, and the effect is strongest on the most volatile names. Treat a STRONG opening drive as the default direction for any intraday idea (staleMinutes under ~240) on that symbol. An intraday idea AGAINST a strong drive needs a specific, data-backed reason it reverses (a level reclaimed, a catalyst that hit after 10:00) or should be WAIT or conviction ≤ 2. A flat drive says nothing; do not cite it. Multi-day swing ideas are exempt from this rule. Never use this rule before 10:00 ET or on a "pending" read.
- **Edit** `app/page.js`
  - `RegimeBanner`: add `Open drive: SPY +0.4% (mild up)` using the new `spyDrive` field.
  - Ideas card: small badge from `driveAligned`: `with the open`, `against the open`, or nothing. Tooltip explains the 10:00 rule in one sentence.
  - Schedule: the 9:45 auto-refresh happens **before** the signal exists. Change `IDEAS_SCHEDULE_ET` from `9*60+45` to `10*60+2` and the label to `8:30, 10:02 & 2:30pm ET`. Rationale in a comment: the measured signal is the 10:00 print; refreshing at 9:45 pays for a model call that cannot see it. Assumption flagged for the owner: this moves the "prime window" refresh 17 minutes later. If that is unacceptable, keep 9:45 and add a 10:02 slot instead, at the cost of one extra billed call per day.
  - Delayed-data mode: if `dataMode()` is `delayed`, the client should schedule 10:17 instead of 10:02 (expose `dataMode` on `/api/status`, which already reports data freshness).

Acceptance: on a strong-drive day, ideas on that symbol that go with the
drive are the norm; any that go against it name a reason in `why_pro`.
Badge and banner render; the 10:02 refresh fires.

### Phase 3: grade it

- **Edit** `app/api/calibrationLib.js`
  Add `byOpeningDrive: groupStats(rows, (i) => i.driveAligned || null)` and a
  fifth line in `calibrationText`: `By opening drive: with 61% (n=34, avgR 0.42); against 44% (n=18, avgR -0.15)`. Same n ≥ 3 floor and ±5R winsorization as the other groups. This feeds the model its own evidence on the rule.
- **Edit** `app/api/gradeLib.js` (optional, recommended)
  Add a same-session checkpoint `{ key: "eod" }` due at 4:00pm ET on the creation date, for ideas created during the regular session. The signal is about the close, and the existing `h1` and `d1` checkpoints straddle it. `finalDueAt` already handles 0DTE ideas; this covers shares and multi-day options ideas created intraday. `dueForGrading` in `app/api/store.js` and the due filter in `app/api/grade/route.js` take the new checkpoint through the existing `CHECKPOINTS` loop, so the change is the definition plus a `dueAt` function rather than `afterMs`.
- **Edit** `app/components/TrackRecord.js`
  Show the new `byOpeningDrive` group alongside catalyst, symbol, and regime.

Acceptance: after two weeks of live use the Track Record tab shows the
with/against split with real n.

### Phase 4: decide on a hard gate (data-driven, not scheduled)

Only after `byOpeningDrive` has n ≥ 30 in both `with` and `against`:

- If `against` win rate is at least 10 points below `with`, promote the prompt rule to a server-side cap: an intraday idea against a strong drive gets `conviction = min(conviction, 2)` and the `why_plain` gets one sentence saying so, in `app/api/suggestions/route.js` after parsing, next to the sizing step.
- If the split is inside noise, keep the signal as information only and note that in the prompt line.

## 5. Tests

There is no test runner in the repo. Use `node --test`:

- **New** `app/lib/checks.test.mjs`: `classifyDrive` thresholds (strong / mild / flat), zero and null inputs, `typical` fallback.
- **New** `app/api/openingDriveLib.test.mjs`: state machine for `pending` (before 10:00), `n/a` (closed, no bars, thrown fetch), `delayed` mode, post-gap note; `openingDriveText` phrasing. Mock `tradier` by injecting a fetcher argument (mirror how `rvolTimeAdjusted` takes `now`).
- Add `"test": "node --test"` to `package.json` scripts.

## 6. Cost and performance

- One extra Tradier call per symbol per refresh, cached for the session date. On a 10-symbol watchlist that is 10 calls at 10:02 and zero at 2:30 (cache hit).
- No extra model tokens beyond about 15 words per MARKET DATA line and the 1c rule (~120 words). The route's own profiling note says the model call dominates wall time and scales with symbol count, not prompt context, so this is not a latency risk.
- One more ledger field group. No schema migration; missing fields on old rows read as `null` and fall out of `groupStats`.

## 7. Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Sandbox / delayed data makes the 10:00 print unavailable at 10:02 | `pending` state plus a 10:17 schedule when `dataMode()` is `delayed` |
| Half days, holidays, symbols with no 9:30 print (SPX index quotes) | `n/a` state; text omitted; never blocks the refresh |
| Overfitting to one summer of three names | Phase 0 re-validates on Tradier data; Phase 3 measures live; Phase 4 gates any hard rule on n ≥ 30 |
| Large-gap days behave differently | post-gap note on the line; model told the read is noisier |
| Rule leaks into swing ideas where it does not apply | prompt scopes it to `staleMinutes` under ~240; badge only on those |
| Signal computed before 10:00 and acted on | `pending` state is explicit; prompt forbids using it |

## 8. Order of work and rough effort

| Phase | Files | Effort |
|---|---|---|
| 0 Validate on Tradier | 1 new script | half a day |
| 1 Signal + prompt context + ledger fields | 1 new lib, 3 edits | 1 day |
| 2 Prompt rule + UI + schedule | 2 edits | half a day |
| 3 Calibration group + eod checkpoint + Track Record | 3 edits | half a day |
| 4 Hard gate | 1 edit | one hour, weeks later |

Phases 0 to 3 can ship in one PR; Phase 4 waits on data.
