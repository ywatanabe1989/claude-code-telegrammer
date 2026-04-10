/**
 * Test preload — sets env vars BEFORE any module imports.
 */

import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";

const TEST_DIR = join(tmpdir(), `cct-test-${process.pid}`);
mkdirSync(TEST_DIR, { recursive: true });

process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR = TEST_DIR;
process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN = "fake:token";
process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS = "";

// Export for tests to reference
(globalThis as any).__CCT_TEST_DIR = TEST_DIR;
