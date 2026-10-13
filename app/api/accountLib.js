/* ---------- The one account size ----------
   Every dollar rule in this app is a share of the account: position caps,
   the loss at a stop, the daily loss limit, the exit bars. They used to read
   ACCOUNT_SIZE separately and fall back to different numbers when it was
   unset — $1,000 in the entry path and the halt, $10,000 in the simulated
   broker, $99,000 in the exit rules — so a missing line in .env.local would
   have run a $10K book with a $50 daily limit and exits sized for $99K.
   One reader, one default, matching the broker's starting cash. */
export const DEFAULT_ACCOUNT_SIZE = 10000;

export function accountSize() {
  const n = Number(process.env.ACCOUNT_SIZE);
  return n > 0 ? n : DEFAULT_ACCOUNT_SIZE;
}
