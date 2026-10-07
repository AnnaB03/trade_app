/* When each part of the automation last ran, and what it found.

   The schedule runs in the background and logs only when something happens,
   so a quiet afternoon and a dead autopilot looked exactly the same from the
   screen. Each route stamps itself here when it finishes; the Journal tab
   shows the stamps, and goes red when the exit check has gone quiet. */
import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "activity.json");

export function readActivity() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch { return {}; }
}

export function markActivity(kind, detail = {}) {
  try {
    const a = readActivity();
    a[kind] = { at: new Date().toISOString(), ...detail };
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(a, null, 2));
  } catch {}
}
