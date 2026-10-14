# Cockpit trading rules

Every rule below is agreed with the account owner and pinned by
`tests/rules.contract.test.js`. A change that breaks one of those tests is
wrong, or it is a rule change — and rules change only when the owner agrees.
When one does, update the test in the same commit with the date and the reason.

`npm test` runs everything. A git pre-push hook (`scripts/pre-push.hook`,
install with `cp scripts/pre-push.hook .git/hooks/pre-push`) refuses to push
when any test fails.

| Rule | Value | Where | Since |
|---|---|---|---|
| Most one trade may lose | 1% of the account ($250 at $25K) | `exitRules.MAX_LOSS_PCT`, `entryRules.RISK_PER_TRADE_PCT` | 2026-10-08 |
| Daily loss limit | 5% of the account | `riskLib.DAILY_LOSS_LIMIT_PCT` | 2026-10-13 |
| Buys are priced at | the ask (`ENTRY_AT_MID=true` for the mid) | `entryRules.payPrice` | 2026-10-14 |
| New positions only in | the regular session | `entryRules.entriesAllowed` | 2026-10-13 |
| Position cap | 15% of the account | `sizingLib.OPTION_HARD_PCT` | 2026-10-06 |
| One stock | 20% of the account | `entryRules.MAX_SYMBOL_EXPOSURE_PCT` | 2026-10-06 |
| Entries per stock per day | 4, then a 45-minute wait after an exit | `entryRules` | 2026-10-13 |
| Idea minimums | conviction 2, reward:risk 1.5 | `entryRules` | — |
| Same-day contracts opened until | 15:00 ET | `entryRules.lateEntryRefused` | 2026-10-08 |
| Contracts per option trade | 1% of the account / loss at the stop that fires first | `entryRules.sizeOptionEntry` | 2026-10-14 |
| Option stop | from its stock's p90 30-minute adverse move, 8–35%; else 10% | `swingLib.optionStopPct`, `exitRules.HARD_LOSS_PCT` | 2026-10-14 |
| Spread at entry | at most 6% of the premium and 40% of the loss limit | `entryRules` | 2026-10-12/14 |
| Selection | no calls in an uptrend, no puts in a transitioning tape, no calls after 14:00, no FDA | `selectionLib` | 2026-10-13 |
| Watch-only (record, never trade) | the fade, the fade scan | `entryRules.isWatchOnly` | 2026-10-14 |
| Same-day ideas | trade live (`INTRADAY_LIVE=false` to record only) | `entryRules.isWatchOnly` | 2026-10-14 |
| Fades | not before 10:00; stop at least 0.5% of the price away | `fadeLib` | 2026-10-14 |
| Take profits | trail arms at +5% (options), sells on a 25% giveback; 1–3 day contracts at +7%, flat from 15:45 | `exitRules` | 2026-10-07 |
| Account | margin: proceeds reusable at once; 3 day trades per 5 days under $25K equity | `simBroker` | 2026-10-13 |
| Broker rules | limit orders only, no shorting, no option writing, $0.35 a contract each way | `simBroker` | 2026-10-07 |
| Idea model | Opus | `suggestions/route.js` | 2026-10-13 |
| A losing recent record | trades at 1/2 size (0 to −0.25R a trade) or 1/4 (worse), never stops | `edgeLib.edgeRiskMultiplier` | 2026-10-14 |
| Same-day ideas are asked for | 1.8× reward to risk at the trigger | `suggestions/route.js` prompt | 2026-10-14 |
