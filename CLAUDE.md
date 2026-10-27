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
  - any new option trade from 14:00 ET (it is sold at 15:45; nothing is carried overnight unless CARRY_OVERNIGHT=true), or a target within 0.15%;
  - the other side of a stock within 30 minutes of a stop-out on it;
  - a second fade of a stock in a day, the other side of a stock within 30 minutes, or the same side within 30 minutes of a sale;
  - more than 8 entries per stock per day.
- Profits: anything up over $50 at the bid is sold at once (since 2026-10-27, `PROFIT_TAKE_USD`); otherwise an option sells at +50% or the idea's target.
- When nothing is trading, that is the bug. Print every idea's refusal reason and fix the cause.
- The agent team (`.claude/agents/`, run by `app/api/agentsLib.js`) is read-only and reports in the Team tab. The risk & market agent's trade ideas reach the Cockpit only through the server's checks (`app/api/newsIdeasLib.js`), as playbook `news`.
- Every agreed rule is in `RULES.md` and pinned by `tests/rules.contract.test.js`. Never push
  red tests; the pre-push hook enforces this.
- Paper only. No live orders, and nothing touches real money.
