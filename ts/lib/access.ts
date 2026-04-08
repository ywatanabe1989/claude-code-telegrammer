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

function getDefaults(): Access {
  return {
    dmPolicy: "allowlist",
    allowFrom: [...ENV_ALLOWED],
    groups: {},
  };
}

export function loadAccess(): Access {
  // Check file mtime; only re-read if changed
  try {
    const st = statSync(ACCESS_FILE);
    if (cachedAccess && st.mtimeMs === cachedMtimeMs) {
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
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log("access", `access.json parse error, using defaults`, {
        error: String(err),
      });
    }
    // On ENOENT or error, return defaults (don't cache — file may appear later)
    cachedAccess = null;
    cachedMtimeMs = 0;
    return getDefaults();
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
