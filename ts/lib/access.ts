/**
 * Access control — allowlist-based gating via access.json + env var.
 * Caches parsed access.json with mtime-based invalidation.
 */

import { readFileSync, statSync } from "fs";
import { ACCESS_FILE, ENV_ALLOWED } from "./config.js";
import { log } from "./log.js";

export interface Access {
  dmPolicy: "allowlist" | "pairing" | "disabled";
  allowFrom: string[];
  groups: Record<string, { requireMention: boolean; allowFrom: string[] }>;
}

// ── Mtime-based cache ──────────────────────────────────────────────────────

let cachedAccess: Access | null = null;
let cachedMtimeMs: number = 0;
let lastCheckMs: number = 0;
const ENOENT_RECHECK_MS = 5000; // Re-check for access.json every 5s when missing

/** Reset cache — for testing only */
export function _resetCache(): void {
  cachedAccess = null;
  cachedMtimeMs = 0;
  lastCheckMs = 0;
}

function getDefaults(): Access {
  return {
    dmPolicy: "allowlist",
    allowFrom: [...ENV_ALLOWED],
    groups: {},
  };
}

export function loadAccess(): Access {
  const now = Date.now();

  // When file was missing, throttle re-checks
  if (cachedAccess && cachedMtimeMs === -1) {
    if (now - lastCheckMs < ENOENT_RECHECK_MS) {
      return cachedAccess;
    }
  }

  // Check file mtime; only re-read if changed
  try {
    const st = statSync(ACCESS_FILE);
    if (cachedAccess && cachedMtimeMs >= 0 && st.mtimeMs === cachedMtimeMs) {
      return cachedAccess;
    }
    const raw = readFileSync(ACCESS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Access>;
    const fileAllow = parsed.allowFrom ?? [];
    const merged = [...new Set([...fileAllow, ...ENV_ALLOWED])];
    cachedAccess = {
      dmPolicy: parsed.dmPolicy ?? "allowlist",
      allowFrom: merged,
      groups: parsed.groups ?? {},
    };
    cachedMtimeMs = st.mtimeMs;
    return cachedAccess;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const defaults = getDefaults();
      // Log only once (when not yet cached as ENOENT)
      if (cachedMtimeMs !== -1) {
        if (defaults.allowFrom.length === 0) {
          log(
            "access",
            `WARNING: no access.json and CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS is empty — all messages will be rejected`,
          );
        } else {
          log(
            "access",
            `access.json not found, using CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS`,
            { allowed: defaults.allowFrom },
          );
        }
      }
      cachedAccess = defaults;
      cachedMtimeMs = -1; // Sentinel: file missing
      lastCheckMs = now;
      return cachedAccess;
    } else {
      log(
        "access",
        `access.json parse error — all messages will be rejected until fixed`,
        { error: String(err) },
      );
      cachedAccess = null;
      cachedMtimeMs = 0;
      return getDefaults();
    }
  }
}

export function isAllowed(
  userId: string,
  chatId: string,
  chatType: string,
): boolean {
  const access = loadAccess();
  if (chatType === "private") {
    return access.allowFrom.includes(userId);
  }
  if (chatType === "group" || chatType === "supergroup") {
    const policy = access.groups[chatId];
    if (!policy) return false;
    if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(userId)) {
      return false;
    }
    return true;
  }
  return false;
}

export function assertAllowedChat(chatId: string): void {
  const access = loadAccess();
  if (access.allowFrom.includes(chatId)) return;
  if (chatId in access.groups) return;
  throw new Error(`chat ${chatId} is not allowlisted`);
}
