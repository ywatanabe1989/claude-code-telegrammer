/**
 * End-to-end pipeline checks for forwarded + media messages.
 *
 * No MCP Server mock — instead we exercise the SAME building blocks
 * poller.ts uses (buildInboundText + parseForward + saveInbound +
 * insertAttachment) against real Telegram update JSON, then read the
 * persisted row back out of the store to confirm caption + attachment
 * file_id + forward_json all coexist.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  initStore,
  saveInbound,
  insertAttachment,
  getHistory,
} from "../lib/store.js";
import { parseForward, buildInboundText } from "../lib/forward.js";

describe("inbound pipeline: forward + media + caption survive together", () => {
  beforeAll(async () => {
    await initStore();
  });

  test("forwarded photo with caption: agent-text has banner + caption AND file_id is persisted", async () => {
    // Real Telegram update shape: a photo forwarded from a channel,
    // with a caption typed by the forwarder.
    const update = {
      update_id: 200001,
      message: {
        message_id: 700,
        from: {
          id: 11111,
          is_bot: false,
          first_name: "Carol",
          username: "carolc",
        },
        chat: { id: 500, type: "private" },
        date: 1717568000,
        forward_origin: {
          type: "channel",
          date: 1717560000,
          chat: {
            id: -1009876543210,
            type: "channel",
            title: "Daily News",
            username: "dailynews_ch",
          },
          message_id: 4242,
          author_signature: "Editor",
        },
        photo: [
          {
            file_id: "AgACAgIPHOTO_SMALL",
            file_unique_id: "u1",
            file_size: 1500,
            width: 90,
            height: 90,
          },
          {
            file_id: "AgACAgIPHOTO_LARGE",
            file_unique_id: "u2",
            file_size: 80000,
            width: 1280,
            height: 960,
          },
        ],
        caption: "Big story today",
      },
    };

    const msg = update.message;
    const text = buildInboundText(msg);
    const fwd = parseForward(msg);

    // 1) Agent-visible text: banner FIRST, then (photo) placeholder,
    //    then caption — so the agent sees ALL three signals even when
    //    only the rendered text is carried (wake POST).
    expect(text.startsWith("[forwarded from Daily News, ")).toBe(true);
    expect(text).toContain("(photo)");
    expect(text).toContain("Big story today");
    expect(text.indexOf("[forwarded")).toBeLessThan(text.indexOf("(photo)"));
    expect(text.indexOf("(photo)")).toBeLessThan(
      text.indexOf("Big story today"),
    );

    // 2) Forward metadata correctly parsed
    expect(fwd).not.toBeNull();
    expect(fwd!.kind).toBe("channel");
    expect(fwd!.from_name).toBe("Daily News");
    expect(fwd!.original_message_id).toBe("4242");
    expect(fwd!.signature).toBe("Editor");

    // 3) Persist to the store — caption + forward_json + attachment all
    //    coexist for one row.
    const rowId = await saveInbound({
      chat_id: String(msg.chat.id),
      message_id: String(msg.message_id),
      user_id: String(msg.from.id),
      username: msg.from.username ?? String(msg.from.id),
      text,
      telegram_ts: new Date(msg.date * 1000).toISOString(),
      forward_json: JSON.stringify(fwd),
      host: "h",
      project: "p",
      agent_id: "a",
      bot_token_hash: "b",
      raw_json: JSON.stringify(update),
    });
    expect(rowId).not.toBeNull();

    // Insert the LARGEST photo size — mirrors poller.ts behavior
    const largest = msg.photo[msg.photo.length - 1];
    await insertAttachment(rowId!, {
      kind: "photo",
      file_id: largest.file_id,
      file_unique_id: largest.file_unique_id,
      file_size: largest.file_size,
    });

    const rows = await getHistory(String(msg.chat.id));
    const row = rows.find((r) => r.id === rowId)!;
    expect(row.text).toContain("[forwarded from Daily News,");
    expect(row.text).toContain("Big story today");
    expect(typeof row.forward_json).toBe("string");
    const stored = JSON.parse(row.forward_json as string);
    expect(stored.kind).toBe("channel");
    expect(stored.original_message_id).toBe("4242");
  });

  test("document + caption (NOT forwarded): caption + file_id both survive", async () => {
    const update = {
      update_id: 200002,
      message: {
        message_id: 701,
        from: { id: 11112, is_bot: false, first_name: "Dan" },
        chat: { id: 501, type: "private" },
        date: 1717568100,
        document: {
          file_id: "BQACDOC_FILE",
          file_unique_id: "doc_u1",
          file_name: "spec.pdf",
          mime_type: "application/pdf",
          file_size: 99999,
        },
        caption: "please review",
      },
    };

    const msg = update.message;
    const text = buildInboundText(msg);
    // Placeholder AND caption coexist (operator-confirmed bug 2026-06-07:
    // the old "caption beats placeholder" behavior dropped the document
    // from the agent's view when a caption was present).
    expect(text).toBe("(document: spec.pdf) please review");
    expect(parseForward(msg)).toBeNull();

    const rowId = await saveInbound({
      chat_id: String(msg.chat.id),
      message_id: String(msg.message_id),
      user_id: String(msg.from.id),
      username: String(msg.from.id),
      text,
      telegram_ts: new Date(msg.date * 1000).toISOString(),
      host: "h",
      project: "p",
      agent_id: "a",
      bot_token_hash: "b",
      raw_json: JSON.stringify(update),
    });
    expect(rowId).not.toBeNull();
    await insertAttachment(rowId!, {
      kind: "document",
      file_id: msg.document.file_id,
      file_unique_id: msg.document.file_unique_id,
      file_name: msg.document.file_name,
      mime_type: msg.document.mime_type,
      file_size: msg.document.file_size,
    });

    const rows = await getHistory(String(msg.chat.id));
    const row = rows.find((r) => r.id === rowId)!;
    expect(row.text).toBe("(document: spec.pdf) please review");
    expect(row.forward_json).toBeNull();
  });

  test("forwarded document (legacy fields) + caption: full survival", async () => {
    const update = {
      update_id: 200003,
      message: {
        message_id: 702,
        from: { id: 11113, is_bot: false, first_name: "Eve" },
        chat: { id: 502, type: "private" },
        date: 1717568200,
        forward_from: {
          id: 88888,
          is_bot: false,
          first_name: "Frank",
          last_name: "Original",
        },
        forward_date: 1717560000,
        document: {
          file_id: "BQACLEGACY_DOC",
          file_unique_id: "leg_u1",
          file_name: "legacy.pdf",
          mime_type: "application/pdf",
          file_size: 4242,
        },
        caption: "shared by Eve",
      },
    };

    const msg = update.message;
    const text = buildInboundText(msg);
    const fwd = parseForward(msg);

    expect(text).toContain("[forwarded from Frank Original,");
    expect(text).toContain("(document: legacy.pdf)");
    expect(text).toContain("shared by Eve");
    // Order: banner → placeholder → caption
    expect(text.indexOf("[forwarded")).toBeLessThan(
      text.indexOf("(document: legacy.pdf)"),
    );
    expect(text.indexOf("(document: legacy.pdf)")).toBeLessThan(
      text.indexOf("shared by Eve"),
    );
    expect(fwd!.kind).toBe("user");
    expect(fwd!.from_name).toBe("Frank Original");
    expect(fwd!.from_id).toBe("88888");

    const rowId = await saveInbound({
      chat_id: String(msg.chat.id),
      message_id: String(msg.message_id),
      user_id: String(msg.from.id),
      username: String(msg.from.id),
      text,
      telegram_ts: new Date(msg.date * 1000).toISOString(),
      forward_json: JSON.stringify(fwd),
      host: "h",
      project: "p",
      agent_id: "a",
      bot_token_hash: "b",
      raw_json: JSON.stringify(update),
    });
    expect(rowId).not.toBeNull();
    await insertAttachment(rowId!, {
      kind: "document",
      file_id: msg.document.file_id,
      file_unique_id: msg.document.file_unique_id,
      file_name: msg.document.file_name,
      mime_type: msg.document.mime_type,
      file_size: msg.document.file_size,
    });

    const rows = await getHistory(String(msg.chat.id));
    const row = rows.find((r) => r.id === rowId)!;
    expect(row.text).toContain("[forwarded from Frank Original,");
    expect(row.text).toContain("shared by Eve");
    const stored = JSON.parse(row.forward_json as string);
    expect(stored.kind).toBe("user");
    expect(stored.from_name).toBe("Frank Original");
  });
});
