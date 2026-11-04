/* The Time Machine's daily record (owner, 2026-11-04: "lets record odds on
   every trade"). After the close the server runs
   scripts/backtest/timemachine.py journal --save, which writes each trade's
   target-first / stop-first odds to data/timemachine/<date>.json. It only
   records: nothing here touches trading. After it, the strategy tournament
   replays every option trade under each ghost bot's rules (data/tournament/latest.json). `timemachine.py score` judges it at
   the rule review (does "no edge" at the buy predict a loser, in both halves?).
   Run by the server, not launchd, because launchd cannot read ~/Documents. */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export const TIME_MACHINE_MIN = 16 * 60 + 10;
export const timeMachineDue = ({ nowMin, dow, saved }) => dow <= 5 && nowMin >= TIME_MACHINE_MIN && !saved;

let running = false;
export function runTimeMachine({ dateET, nowMin, dow }) {
  const file = path.join(process.cwd(), "data", "timemachine", `${dateET}.json`);
  if (running || !timeMachineDue({ nowMin, dow, saved: fs.existsSync(file) })) return false;
  running = true;
  // Then the strategy tournament (scripts/backtest/tournament.py), which reads the odds just saved.
  const steps = [["scripts/backtest/timemachine.py", "journal", dateET, "--save"], ["scripts/backtest/tournament.py", "--save"]];
  const next = (i) => {
    if (i >= steps.length) { running = false; return; }
    const child = spawn("python3", steps[i], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      if (code !== 0) { running = false; console.error(`[timemachine] ${steps[i][0]} exited ${code}: ${err.slice(-400)}`); return; }
      next(i + 1);
    });
    child.on("error", (e) => { running = false; console.error("[timemachine] failed to start:", e); });
  };
  next(0);
  return true;
}
