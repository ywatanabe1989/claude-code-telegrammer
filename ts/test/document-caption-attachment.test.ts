/**
 * Regression test for the document+caption bug (operator-confirmed 2026-06-07).
 *
 * Repro: a .md sent ALONE arrives at the agent as "(document: foo.md)" — agent
 * sees the document. The SAME .md sent WITH a caption used to arrive as just
 * "please review" — the document was silently dropped from the agent's view.
 *
 * Why it matters most for SDK-runner agents: an IDLE agent is woken via
 * POST /v1/turn (lib/wake.ts), whose body is a `<channel …>` framing of the
 * rendered text string. It does NOT include meta.attachment_kind /
 * attachment_file_id — those only ride along inside the in-process MCP
 * notification for an INTERACTIVE Claude Code session. So if `text` doesn't
 * mention the document, a woken agent literally has no signal that a file
 * was attached.
 *
 * Root cause was in lib/forward.ts buildInboundText:
 *   text = text || "(document: …)"     ← short-circuit
 * When `text` was the caption (truthy), the placeholder was dropped.
 *
 * Fix: concatenate placeholder THEN caption so the agent reads
 *   "(document: foo.md) please review"
 *
 * This test exercises the SAME pipeline as poller.ts (buildInboundText →
 * saveInbound → insertAttachment → getHistory) against a real in-memory
 * Telegram update fixture. No mocks.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  initStore,
  saveInbound,
  insertAttachment,
  getHistory,
} from "../lib/store.js";
import { buildInboundText, parseForward } from "../lib/forward.js";

describe("regression: document+caption preserves BOTH placeholder AND caption", () => {
  beforeAll(async () => {
    await initStore();
  });

  test("plain document + caption (the operator-confirmed repro)", async () => {
    // Real Telegram update shape: a .md file sent with a caption.
    const update = {
      update_id: 700001,
      message: {
        message_id: 8001,
        from: { id: 99, is_bot: false, first_name: "Op" },
        chat: { id: 8000, type: "private" },
        date: 1717700000,
        document: {
          file_id: "BQACDoc_MARKDOWN_FILE_ID",
          file_unique_id: "md_u1",
          file_name: "design-notes.md",
          mime_type: "text/markdown",
          file_size: 4321,
        },
        caption: "please review",
      },
    };

    const msg = update.message;
    const text = buildInboundText(msg);

    // ─── ASSERTION A: text contains BOTH the document placeholder
    //                  AND the caption, in that order. ──────────────
    expect(text).toBe("(document: design-notes.md) please review");
    expect(text).toContain("(document: design-notes.md)");
    expect(text).toContain("please review");
    expect(text.indexOf("(document: design-notes.md)")).toBeLessThan(
      text.indexOf("please review"),
    );

    // Not a forward.
    expect(parseForward(msg)).toBeNull();

    // ─── ASSERTION B: round-trip through saveInbound + insertAttachment
    //                  + getHistory — the SAME pipeline poller.ts uses.
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

    // ─── ASSERTION C: stored row carries the combined text — what
    //                  get_context / get_history return to the agent.
    expect(row.text).toBe("(document: design-notes.md) please review");
    expect(row.forward_json).toBeNull();
  });

  test("document-only (control): placeholder appears alone, unchanged", () => {
    // Confirms we did NOT regress the document-only case — operator says
    // this case ALREADY works ("a .md sent alone forwards fine").
    const msg = {
      message_id: 8002,
      from: { id: 99, first_name: "Op" },
      chat: { id: 8000, type: "private" },
      date: 1717700100,
      document: {
        file_id: "BQACDoc_ALONE",
        file_unique_id: "md_u2",
        file_name: "alone.md",
        mime_type: "text/markdown",
        file_size: 100,
      },
    };
    expect(buildInboundText(msg)).toBe("(document: alone.md)");
  });

  test("document + caption + forwarded: banner + placeholder + caption", () => {
    // Stack the bug onto a forwarded message and confirm all three
    // pieces survive together — the wake-POST body still tells the
    // agent everything it needs.
    const msg = {
      message_id: 8003,
      from: { id: 99, first_name: "Op" },
      chat: { id: 8000, type: "private" },
      date: 1717700200,
      document: {
        file_id: "BQACDoc_FWDED",
        file_unique_id: "md_u3",
        file_name: "fwd.md",
        mime_type: "text/markdown",
        file_size: 200,
      },
      caption: "review when you can",
      forward_origin: {
        type: "user",
        date: 1717690000,
        sender_user: { id: 7777, first_name: "Sender" },
      },
    };
    const text = buildInboundText(msg);
    expect(text).toContain("[forwarded from Sender,");
    expect(text).toContain("(document: fwd.md)");
    expect(text).toContain("review when you can");
    // Order: banner FIRST, then placeholder, then caption
    expect(text.indexOf("[forwarded")).toBe(0);
    expect(text.indexOf("[forwarded")).toBeLessThan(
      text.indexOf("(document: fwd.md)"),
    );
    expect(text.indexOf("(document: fwd.md)")).toBeLessThan(
      text.indexOf("review when you can"),
    );
  });

  test("photo + caption: placeholder AND caption (symmetric fix)", () => {
    // Same root cause, same fix — verified for photos too.
    const msg = {
      message_id: 8004,
      from: { id: 99, first_name: "Op" },
      chat: { id: 8000, type: "private" },
      date: 1717700300,
      photo: [
        { file_id: "P_S", file_unique_id: "ps", file_size: 100 },
        { file_id: "P_L", file_unique_id: "pl", file_size: 50000 },
      ],
      caption: "see this graph",
    };
    expect(buildInboundText(msg)).toBe("(photo) see this graph");
  });

  test("voice + caption: placeholder AND caption (symmetric fix)", () => {
    const msg = {
      message_id: 8005,
      from: { id: 99, first_name: "Op" },
      chat: { id: 8000, type: "private" },
      date: 1717700400,
      voice: { file_id: "V_ID", file_unique_id: "v1", duration: 5 },
      caption: "quick note",
    };
    expect(buildInboundText(msg)).toBe("(voice message) quick note");
  });
});
