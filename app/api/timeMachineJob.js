/* The Time Machine's daily record (owner, 2026-11-04: "lets record odds on
   every trade"). After the close the server runs
   scripts/backtest/timemachine.py journal --save, which writes each trade's
   target-first / stop-first odds to data/timemachine/<date>.json. It only
   records: nothing here touches trading. `timemachine.py score` judges it at
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
  const child = spawn("python3", ["scripts/backtest/timemachine.py", "journal", dateET, "--save"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  child.on("close", (code) => {
    running = false;
    if (code !== 0) console.error(`[timemachine] exited ${code}: ${err.slice(-400)}`);
  });
  child.on("error", (e) => { running = false; console.error("[timemachine] failed to start:", e); });
  return true;
}
