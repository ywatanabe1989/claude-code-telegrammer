/**
 * Access control — allowlist-based gating via access.json + env var.
 */

import { readFileSync } from "fs";
import { ACCESS_FILE, ENV_ALLOWED } from "./config.js";
import { log } from "./log.js";

export interface Access {
  dmPolicy: "allowlist" | "pairing" | "disabled";
  allowFrom: string[];
  groups: Record<string, { requireMention: boolean; allowFrom: string[] }>;
}

export function loadAccess(): Access {
  const defaults: Access = {
    dmPolicy: "allowlist",
    allowFrom: [...ENV_ALLOWED],
    groups: {},
  };
  try {
    const raw = readFileSync(ACCESS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Access>;
    const fileAllow = parsed.allowFrom ?? [];
    const merged = [...new Set([...fileAllow, ...ENV_ALLOWED])];
    return {
      dmPolicy: parsed.dmPolicy ?? "allowlist",
      allowFrom: merged,
      groups: parsed.groups ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`access.json parse error, using defaults: ${err}`);
    }
    return defaults;
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
