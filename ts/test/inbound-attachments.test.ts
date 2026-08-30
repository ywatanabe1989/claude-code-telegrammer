/**
 * Incident cct-inbound-images-20260707: an operator-sent photo rendered
 * to the agent as bare "(photo)" — no file_id, no path — so
 * download_attachment could not be called without digging the file_id
 * out of get_history raw_json.
 *
 * Root cause: poller.ts DID set meta.attachment_kind/attachment_file_id,
 * but the Claude Code harness renders only a whitelist of meta keys into
 * the <channel> tag — arbitrary meta is dropped. Fix: the kind + file_id
 * ride in the CONTENT string (always rendered) via
 * forward.ts::attachmentDescriptor, and the query tools expose the
 * attachments table (get_history/get_unread `attachments` array;
 * download_attachment by row_id with a no-network local_path
 * short-circuit).
 *
 * These tests exercise the same pipeline pieces poller.ts uses
 * (buildInboundText + attachmentDescriptor → saveInbound →
 * insertAttachment → tools-messages handlers) against a real
 * store. The only injected piece is the download function — proving the
 * short-circuit paths never touch the network.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import {
  initStore,
  saveInbound,
  insertAttachment,
  markAttachmentDownloaded,
  attachmentsForRows,
} from "../lib/store.js";
import { buildInboundText, attachmentDescriptor } from "../lib/forward.js";
import { _resetCache } from "../lib/access.js";
import { ACCESS_FILE } from "../lib/config.js";
import {
  handleGetHistory,
  handleGetUnread,
  handleDownloadAttachment,
} from "../lib/tools-messages.js";

const CHAT = "9100";
const TEST_DIR = (globalThis as any).__CCT_TEST_DIR as string;
const FILES_DIR = join(TEST_DIR, "inbound-attachment-files");

/** A throwing download stub — any call means the network was hit. */
function noNetwork(): Promise<string> {
  throw new Error("network hit — short-circuit failed");
}

function photoUpdate(messageId: number, fileId: string) {
  return {
    update_id: 910000 + messageId,
    message: {
      message_id: messageId,
      from: { id: 42, is_bot: false, first_name: "Op" },
      chat: { id: Number(CHAT), type: "private" },
      date: 1720300000,
      photo: [
        { file_id: `${fileId}_thumb`, file_unique_id: "u_s", file_size: 90 },
        { file_id: fileId, file_unique_id: "u_l", file_size: 51234 },
      ],
    },
  };
}

/** Same persistence steps poller.ts performs for an inbound photo. */
async function savePhotoMessage(
  messageId: number,
  fileId: string,
): Promise<number> {
  const msg = photoUpdate(messageId, fileId).message;
  const rowId = await saveInbound({
    chat_id: CHAT,
    message_id: String(msg.message_id),
    user_id: String(msg.from.id),
    username: "op",
    text: buildInboundText(msg),
    telegram_ts: new Date(msg.date * 1000).toISOString(),
    host: "h",
    project: "p",
    agent_id: "a",
    bot_token_hash: "b",
    raw_json: JSON.stringify(photoUpdate(messageId, fileId)),
  });
  expect(rowId).not.toBeNull();
  await insertAttachment(rowId!, {
    kind: "photo",
    file_id: fileId,
    file_unique_id: "u_l",
    file_size: 51234,
  });
  return rowId!;
}

async function saveTextMessage(
  messageId: number,
  text: string,
): Promise<number> {
  const rowId = await saveInbound({
    chat_id: CHAT,
    message_id: String(messageId),
    user_id: "42",
    username: "op",
    text,
    telegram_ts: new Date(1720300000 * 1000).toISOString(),
    host: "h",
    project: "p",
    agent_id: "a",
    bot_token_hash: "b",
    raw_json: "{}",
  });
  expect(rowId).not.toBeNull();
  return rowId!;
}

beforeAll(async () => {
  await initStore();
  mkdirSync(FILES_DIR, { recursive: true });
  // handleGetHistory/handleGetUnread gate on the allowlist — permit the
  // test chat the same way an operator's access.json would.
  writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: [CHAT] }));
  _resetCache();
});

afterAll(() => {
  try {
    unlinkSync(ACCESS_FILE);
  } catch {
    // already removed
  }
  _resetCache();
});

describe("inbound photo content line carries kind + file_id", () => {
  test("photo without caption: descriptor appended to placeholder", () => {
    const msg = photoUpdate(9001, "AgACAg_PHOTO_FID").message;
    // poller.ts composition: buildInboundText + attachmentDescriptor for
    // the LARGEST photo size (last array element).
    const obj = msg.photo[msg.photo.length - 1];
    const delivered = `${buildInboundText(msg)} ${attachmentDescriptor("photo", obj)}`;
    expect(delivered).toBe(
      "(photo) [attachment kind=photo file_id=AgACAg_PHOTO_FID — call download_attachment(file_id) for the local path]",
    );
  });

  test("document descriptor includes name + mime when present", () => {
    const desc = attachmentDescriptor("document", {
      file_id: "BQACDoc_FID",
      file_name: "report.pdf",
      mime_type: "application/pdf",
    });
    expect(desc).toBe(
      "[attachment kind=document file_id=BQACDoc_FID name=report.pdf mime=application/pdf — call download_attachment(file_id) for the local path]",
    );
  });
});

/**
 * get_history / get_unread answer {coverage, count, messages} rather than a
 * bare array — a bare [] could not distinguish "nothing was sent" from "this
 * store never observed that window" (incident 2026-08-10). Tests read the
 * messages through here so the envelope is asserted in exactly one place.
 */
function parseMessages(res: { content: Array<{ text: string }> }): Array<any> {
  return JSON.parse(res.content[0].text).messages as Array<any>;
}

describe("get_history / get_unread expose the attachments array", () => {
  test("history row carries attachments with local_path after download-complete", async () => {
    const rowId = await savePhotoMessage(9010, "FID_HISTORY");
    const localPath = join(FILES_DIR, "history.jpg");
    writeFileSync(localPath, "jpegbytes");
    // Simulate the background auto-download completing.
    await markAttachmentDownloaded(rowId, "FID_HISTORY", localPath);

    const res = await handleGetHistory({ chat_id: CHAT, limit: 50 });
    expect(res.isError).toBeUndefined();
    const rows = parseMessages(res);
    const row = rows.find((r) => r.id === rowId);
    expect(row).toBeDefined();
    expect(row.attachments).toHaveLength(1);
    expect(row.attachments[0]).toMatchObject({
      message_row_id: rowId,
      kind: "photo",
      file_id: "FID_HISTORY",
      local_path: localPath,
      chat_id: CHAT,
    });
    expect(row.attachments[0].downloaded_at).toBeTruthy();
  });

  test("plain-text rows carry NO attachments key (no empty-array noise)", async () => {
    const rowId = await saveTextMessage(9011, "just words");
    const res = await handleGetHistory({ chat_id: CHAT, limit: 50 });
    const rows = parseMessages(res);
    const row = rows.find((r) => r.id === rowId);
    expect(row).toBeDefined();
    expect("attachments" in row).toBe(false);
  });

  test("get_unread includes the same attachments array", async () => {
    const rowId = await savePhotoMessage(9012, "FID_UNREAD");
    const res = await handleGetUnread({ chat_id: CHAT });
    const rows = parseMessages(res);
    const row = rows.find((r) => r.id === rowId);
    expect(row).toBeDefined();
    expect(row.attachments[0].file_id).toBe("FID_UNREAD");
    expect(row.attachments[0].local_path).toBeNull();
  });

  test("every read carries a coverage verdict, so [] is never ambiguous", async () => {
    const parsed = JSON.parse(
      (await handleGetUnread({ chat_id: CHAT })).content[0].text,
    );
    expect(parsed).toHaveProperty("coverage");
    expect(parsed).toHaveProperty("count");
    expect(parsed).toHaveProperty("messages");
    expect(["covered", "unverifiable"]).toContain(parsed.coverage.verdict);
    expect(parsed.coverage.reason).toBeTruthy();
    expect(parsed.count).toBe(parsed.messages.length);
  });
});

describe("download_attachment by row_id / file_id", () => {
  test("row_id with existing local_path returns it WITHOUT network", async () => {
    const rowId = await savePhotoMessage(9020, "FID_CACHED");
    const localPath = join(FILES_DIR, "cached.jpg");
    writeFileSync(localPath, "jpegbytes");
    await markAttachmentDownloaded(rowId, "FID_CACHED", localPath);

    const res = await handleDownloadAttachment({ row_id: rowId }, noNetwork);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(`downloaded to: ${localPath}`);
  });

  test("file_id with existing local_path also short-circuits", async () => {
    const rowId = await savePhotoMessage(9021, "FID_CACHED_BY_ID");
    const localPath = join(FILES_DIR, "cached-by-id.jpg");
    writeFileSync(localPath, "jpegbytes");
    await markAttachmentDownloaded(rowId, "FID_CACHED_BY_ID", localPath);

    const res = await handleDownloadAttachment(
      { file_id: "FID_CACHED_BY_ID" },
      noNetwork,
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(`downloaded to: ${localPath}`);
  });

  test("row_id not yet downloaded: downloads, routes to the row's chat, records local_path", async () => {
    const rowId = await savePhotoMessage(9022, "FID_FRESH");
    const localPath = join(FILES_DIR, "fresh.jpg");
    const calls: Array<[string, string]> = [];
    const stub = async (fileId: string, chatId: string) => {
      calls.push([fileId, chatId]);
      writeFileSync(localPath, "jpegbytes");
      return localPath;
    };

    const res = await handleDownloadAttachment({ row_id: rowId }, stub);
    expect(res.content[0].text).toBe(`downloaded to: ${localPath}`);
    // chat_id resolved from the attachment row (not "unknown").
    expect(calls).toEqual([["FID_FRESH", CHAT]]);

    // The download was recorded — a second call must short-circuit.
    expect((await attachmentsForRows([rowId]))[0].local_path).toBe(localPath);
    const res2 = await handleDownloadAttachment({ row_id: rowId }, noNetwork);
    expect(res2.content[0].text).toBe(`downloaded to: ${localPath}`);
  });

  test("row_id with no attachment: clear error, no network", async () => {
    const rowId = await saveTextMessage(9023, "no file here");
    const res = await handleDownloadAttachment({ row_id: rowId }, noNetwork);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(
      `no attachment recorded for row_id ${rowId}`,
    );
  });

  test("neither file_id nor row_id: usage error", async () => {
    const res = await handleDownloadAttachment({}, noNetwork);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("provide file_id or row_id");
  });
});
