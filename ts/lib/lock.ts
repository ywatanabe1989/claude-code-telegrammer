/**
 * Single-instance enforcement via PID lock file.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { STATE_DIR, LOCK_FILE } from "./config.js";
import { log } from "./log.js";

export function acquireLock(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(LOCK_FILE)) {
    let stale = false;
    try {
      const pid = parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
      try {
        process.kill(pid, 0);
      } catch {
        stale = true;
      }
    } catch {
      stale = true;
    }
    if (!stale) {
      log(
        "another instance is running (lock file exists with live PID). Exiting.",
      );
      process.exit(1);
    }
    log("removing stale lock file");
  }
  writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
}

export function releaseLock(): void {
  try {
    unlinkSync(LOCK_FILE);
  } catch {}
}
