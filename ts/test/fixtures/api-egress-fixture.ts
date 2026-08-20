#!/usr/bin/env bun
/**
 * Drives EVERY Telegram HTTP egress site in this package, once each, in a real
 * child process — so a test can prove the CCT_TELEGRAM_API_BASE override
 * reaches all of them and not just the popular one.
 *
 * There are five, and they do NOT all share a code path:
 *
 *   telegram-api::tgApi        POST <API_BASE>/<method>   (the universal funnel)
 *   telegram-api::getMeRaw     POST <API_BASE>/getMe      (own fetch, bounded)
 *   telegram-api::sendDocument POST <API_BASE>/sendDocument (own fetch, multipart)
 *   telegram-api::downloadFile GET  <FILE_BASE>/<path>    (different path shape)
 *   health-adapters::probeWebhook POST <API_BASE>/getWebhookInfo (own fetch)
 *
 * A child process is required, not a convenience: both bases are module-load-
 * time consts, so the env var has to be set BEFORE import — which means before
 * the process starts.
 *
 * NOT named "*.test.ts" on purpose — bun's discovery would otherwise run it as
 * a test file. Same convention as concurrent-writer-fixture.ts.
 *
 * Usage: bun run api-egress-fixture.ts <workdir>
 * Prints EGRESS_FIXTURE_OK on success; exits 1 with EGRESS_FIXTURE_FAILED
 * otherwise.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  tgApi,
  getMeRaw,
  sendDocument,
  downloadFile,
} from "../../lib/telegram-api.js";
import { probeWebhook } from "../../lib/health-adapters.js";

const workDir = process.argv[2];
if (!workDir) {
  process.stderr.write("usage: api-egress-fixture <workdir>\n");
  process.exit(2);
}

mkdirSync(workDir, { recursive: true });
const document = join(workDir, "seam-document.txt");
writeFileSync(document, "seam-document-bytes");

async function main(): Promise<void> {
  await tgApi("sendChatAction", { chat_id: "1", action: "typing" });
  await getMeRaw();
  await sendDocument("1", document, "seam caption");
  await downloadFile("documents/seam-file.bin", join(workDir, "downloads"));
  await probeWebhook();
  process.stdout.write("EGRESS_FIXTURE_OK\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`EGRESS_FIXTURE_FAILED: ${err}\n`);
  process.exit(1);
});
