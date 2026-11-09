# Options Cockpit: standing instructions

**The main goal is to learn: always buy → sell → learn.** The owner said so on 2026-10-14:
"remove all the blockers that will block you from learning ... always try and always
learn from every single contract or trade."

- Learning mode (`app/api/order/entryRules.js`, on unless `LEARNING_MODE=false`). An idea
  whose trigger fires is traded. A soft rule that would have refused it is written on the
  journal row as `learningOverrides`, and the edge report scores each rule on real fills.
- New concerns become recorded overrides, not refusals. A new hard refusal needs the
  owner's agreement.
- The safety core still refuses:
  - paper only;
  - the regular session only;
  - (the daily loss halt is off since 2026-10-15, `DAILY_LOSS_LIMIT_PCT=0`, at the owner's call; default 10%);
  - the option stop (20% minimum, judged at the mid; no dollar cap on options), and the $500 cap for shares;
  - the 15% position, 20% per-symbol and total-capital caps;
  - the idea's trigger has not fired;
  - price is already through the invalidation, or already at the target;
  - an exact duplicate of an open position;
  - no usable stop;
  - a spread over 12% of the premium, or over half the loss limit on arrival, or an option under $1;
  - an idea from an earlier session, or one that already reached its target;
  - the other side of a stock already held, or a second position in the same stock, side and playbook;
  - a third trade of one idea in a day;
  - any new buy before 10:00 ET (since 2026-10-29), and any option before 10:30 (since 2026-11-03), any new option trade from 14:00 ET, or a target within 0.15%. Every option is sold from 15:45 (the 14+ day carry was undone on 2026-10-29);
  - the other side of a stock within 30 minutes of a stop-out on it;
  - a second fade of a stock in a day, the other side of a stock within 30 minutes, or the same side within 30 minutes of a sale;
  - more than 8 entries per stock per day;
  - an idea carrying 3 or more different warnings at once (since 2026-10-27);
  - an option unless QQQ has moved 0.3%+ since the open in its direction (since 2026-11-02).
- Contract: every option idea buys the nearest 1-5 day expiry at the money (since 2026-11-04, `contractLib.nearAtmContract`; `NEAR_ATM_CONTRACTS=false` restores the old choice).
- Size: options risk 1% at the stop ($250), shares 2% ($500), since 2026-11-02.
- Profits: an option up over $80 at the bid is sold at once ($50 until 2026-10-30; kept at $80 with half-size options) (shares keep their own exits) (since 2026-10-27, `PROFIT_TAKE_USD`); otherwise an option sells at +50% or the idea's target. An option bought while QQQ is 0.5%+ and SPY 0.25%+ our way since the open skips the +$80 sale and runs to +50%, the target, the stop or 15:45 (since 2026-11-05, `entryRules.letItRun`).
- When nothing is trading, that is the bug. Print every idea's refusal reason and fix the cause.
- The dip playbook (`strategy: "dip"`, since 2026-10-29) buys shares of core-list stocks that are up on the day after a 1% dip from the high; sold +1%, stopped -1%, or at 15:45; no dip buy while QQQ is 0.5%+ below its day's high (since 2026-11-04); at most 3 open dip positions and 40% of the account in them (since 2026-11-09).
- The agent team (`.claude/agents/`, run by `app/api/agentsLib.js`) is read-only and reports in the Team tab. The risk & market agent's trade ideas reach the Cockpit only through the server's checks (`app/api/newsIdeasLib.js`), as playbook `news`.
- The Time Machine (`scripts/backtest/timemachine.py`) records each trade's target-first / stop-first odds after the close (the server runs it at 16:10, `app/api/timeMachineJob.js`, into `data/timemachine/`). It only records; `timemachine.py score` judges it at the rule review. Its odds are never a learning warning (a new warning would push ideas to 3+ and refuse them).
- Every agreed rule is in `RULES.md` and pinned by `tests/rules.contract.test.js`. Never push
  red tests; the pre-push hook enforces this.
- Paper only. No live orders, and nothing touches real money.
