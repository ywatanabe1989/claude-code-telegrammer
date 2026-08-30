/**
 * Reply context must reach the agent (operator incident 2026-08-11).
 *
 * The operator replied to one of the BOT's messages with a single letter,
 * "A". The poller stored everything — reply_to_message_id="8293" in its own
 * column and the complete 416-character reply_to_message in raw_json — but
 * the block delivered into the agent session was a bare:
 *
 *     <channel source="cct" chat_id="…" message_id="…" row_id="…"
 *              user="…" user_id="…" ts="…">
 *     A
 *
 * so the agent attached "A" to the wrong question entirely.
 *
 * ts/test/fixtures/real-reply-8303.json is that exact update, taken from row
 * 333 of the live message DB. Only the account identifiers are replaced (with
 * this suite's standard fake ids); the shape, the message ids, and every one
 * of the 416 characters of the replied-to text are the real thing. That text
 * matters to the excerpt argument: the choice the operator was answering with
 * "A" ("案 A") sits at character ~250, so an excerpt capped at a first line
 * or a short prefix would have identified the message and STILL not explained
 * the reply.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "fs";
import realReply from "./fixtures/real-reply-8303.json";
import {
  parseReplyContext,
  replyTargetMessageId,
  replyDescriptor,
  REPLY_EXCERPT_MAX,
} from "../lib/reply-context.js";
import { wakeText, setTurnPoster } from "../lib/wake.js";
import { handleUpdate } from "../lib/handle-update.js";
import {
  initStore,
  saveOutbound,
  getMessageByMessageId,
} from "../lib/store.js";
import { _resetCache } from "../lib/access.js";
import { ACCESS_FILE, STATE_DIR } from "../lib/config.js";

const USER_ID = "8675309";
const CHAT_ID = "8675309";

/** The replied-to bot message, verbatim from the incident. */
const REAL_TARGET_TEXT = realReply.message.reply_to_message.text;

type TurnCall = { body: { text: string } };

function captureTurnCalls(status = 200): TurnCall[] {
  const calls: TurnCall[] = [];
  setTurnPoster(async (_url, body) => {
    calls.push({ body });
    return status;
  });
  return calls;
}

beforeAll(async () => {
  await initStore();
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: [USER_ID] }));
  _resetCache();
});

afterAll(() => {
  rmSync(ACCESS_FILE, { force: true });
  _resetCache();
});

beforeEach(() => {
  captureTurnCalls();
});

describe("the real incident: message 8303 replying to 8293", () => {
  test("the fixture is the real shape — a one-letter reply to a long BOT message", () => {
    expect(realReply.message.text).toBe("A");
    expect(realReply.message.reply_to_message.message_id).toBe(8293);
    expect(realReply.message.reply_to_message.from.is_bot).toBe(true);
    expect(REAL_TARGET_TEXT.length).toBe(416);
    // The two options the "A" was choosing between. If an excerpt cannot
    // carry these, it has not solved the operator's problem.
    expect(REAL_TARGET_TEXT).toContain("案 A");
    expect(REAL_TARGET_TEXT).toContain("案 B");
  });

  test("parseReplyContext recovers the target id, sender and full text", () => {
    const ctx = parseReplyContext(realReply.message);
    expect(ctx).not.toBeNull();
    expect(ctx!.message_id).toBe("8293");
    expect(ctx!.resolution).toBe("update");
    expect(ctx!.from).toBe("bot:@CctTestBot");
    expect(ctx!.truncated).toBe(false);
    // 416 <= 512, so the real target arrives COMPLETE — including both
    // options, which is what makes "A" answerable without a second lookup.
    expect(ctx!.excerpt).toContain("案 A: 環境の同一性");
    expect(ctx!.excerpt).toContain("案 B: バイト単位の同一性");
  });

  test("replyDescriptor renders ONE line, no matter how multi-line the target was", () => {
    const line = replyDescriptor(parseReplyContext(realReply.message)!);
    expect(REAL_TARGET_TEXT).toContain("\n"); // the target really is multi-line
    expect(line.includes("\n")).toBe(false);
    expect(line.startsWith("[in-reply-to message_id=8293 from=bot:@CctTestBot text=\"")).toBe(
      true,
    );
    expect(line.endsWith("]")).toBe(true);
  });

  test("REGRESSION: the delivered channel block carries the reference AND the excerpt", async () => {
    const calls = captureTurnCalls();
    expect(await handleUpdate(realReply)).toBe("ok");
    expect(calls.length).toBe(1);
    const delivered = calls[0].body.text;

    // 1. The reference, in the <channel …> tag itself. Before this change
    //    wakeText's hardcoded attribute list dropped it even though
    //    handle-update.ts had always set meta.reply_to_message_id.
    expect(delivered).toContain('reply_to_message_id="8293"');

    // 2. Enough of the replied-to text to answer without a second lookup.
    expect(delivered).toContain("[in-reply-to message_id=8293");
    expect(delivered).toContain("案 A: 環境の同一性");
    expect(delivered).toContain("案 B: バイト単位の同一性");

    // 3. The operator's actual message is still there, and still last.
    expect(delivered.trimEnd().endsWith("A\n</channel>")).toBe(true);

    // What the agent used to receive: a body of exactly "A". Pin that this
    // can never come back.
    const body = delivered.split(">\n")[1] ?? "";
    expect(body.trim()).not.toBe("A");
  });

  test("a message that is NOT a reply stays clean — no descriptor, no attribute", async () => {
    const calls = captureTurnCalls();
    const plain = {
      update_id: 991,
      message: {
        message_id: 9001,
        from: { id: Number(USER_ID), is_bot: false, username: "alice" },
        chat: { id: Number(CHAT_ID), type: "private" },
        date: 1786493999,
        text: "no reply here",
      },
    };
    expect(await handleUpdate(plain)).toBe("ok");
    const delivered = calls[0].body.text;
    expect(delivered).not.toContain("in-reply-to");
    expect(delivered).not.toContain("reply_to_message_id");
  });
});

describe("the excerpt limit", () => {
  test("is 512 code points — above the 509-char maximum of the real corpus", () => {
    expect(REPLY_EXCERPT_MAX).toBe(512);
    // The real reply target (416) is comfortably inside it.
    expect(REAL_TARGET_TEXT.length).toBeLessThan(REPLY_EXCERPT_MAX);
  });

  function replyTo(text: string) {
    return {
      message_id: 9100,
      from: { id: Number(USER_ID), is_bot: false, username: "alice" },
      chat: { id: Number(CHAT_ID), type: "private" },
      date: 1786494000,
      text: "ok",
      reply_to_message: { message_id: 9099, text },
    };
  }

  test("a longer target is cut at exactly 512 and the cut is MARKED", () => {
    const ctx = parseReplyContext(replyTo("あ".repeat(600)))!;
    expect(ctx.truncated).toBe(true);
    expect(ctx.full_length).toBe(600);
    expect(Array.from(ctx.excerpt!).length).toBe(512);

    const line = replyDescriptor(ctx);
    expect(line).toContain("truncated_from=600");
    expect(line).toContain("— call get_history(chat_id) for the full text]");
    expect(line).toContain("あ…"); // the ellipsis marks where it was cut
  });

  test("truncation is code-point safe — an emoji is never split in half", () => {
    const ctx = parseReplyContext(replyTo("🙂".repeat(600)))!;
    expect(Array.from(ctx.excerpt!).length).toBe(512);
    // A UTF-16 slice would have left a lone surrogate here.
    expect(ctx.excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(ctx.excerpt!.endsWith("🙂")).toBe(true);
  });

  test("whitespace runs collapse so the descriptor cannot span lines", () => {
    const ctx = parseReplyContext(replyTo("first\n\n  second\tthird"))!;
    expect(ctx.excerpt).toBe("first second third");
  });
});

describe("unresolvable reply targets are SAID, not omitted", () => {
  test("a target with no text anywhere renders UNRESOLVED, not silence", () => {
    const msg = {
      message_id: 9200,
      chat: { id: Number(CHAT_ID), type: "private" },
      text: "hm",
      // A target Telegram inlined without a body and that our DB has never
      // seen: the lookup returns null.
      reply_to_message: { message_id: 4242 },
    };
    const ctx = parseReplyContext(msg, () => null)!;
    expect(ctx.resolution).toBe("unavailable");
    expect(ctx.excerpt).toBeUndefined();

    const line = replyDescriptor(ctx);
    expect(line).toContain("message_id=4242");
    expect(line).toContain("text=UNRESOLVED");
    expect(line).toContain("not in this chat's local history");
  });

  test("'no reply' and 'unresolved reply' are different answers", () => {
    expect(parseReplyContext({ text: "plain" })).toBeNull();
    expect(
      parseReplyContext({ text: "x", reply_to_message: { message_id: 7 } }, () => null)!
        .resolution,
    ).toBe("unavailable");
  });

  test("a reply to a message in ANOTHER chat still names its origin", () => {
    const ctx = parseReplyContext(
      {
        text: "look at this",
        external_reply: { origin: { type: "channel", message_id: 555 } },
      },
      () => null,
    )!;
    expect(ctx.message_id).toBe("555");
    expect(ctx.resolution).toBe("unavailable");
  });
});

describe("the local-DB fallback resolves targets Telegram did not inline", () => {
  test("a bot message recovered from the REAL store, by message_id", async () => {
    // A real outbound row in the REAL store — the same table and the same
    // writer the bridge uses in production, not a stub.
    const botText = "which option do you want, A or B?";
    await saveOutbound(CHAT_ID, botText, "8293-store");

    const stored = await getMessageByMessageId(CHAT_ID, "8293-store");
    expect(stored).not.toBeNull();
    expect(stored!.direction).toBe("outbound");

    // parseReplyContext is pure and SYNCHRONOUS by design — the store now
    // lives across a network, so the lookup is resolved first and the value
    // is handed over, exactly as lib/handle-update.ts does it in production.
    const targetId = replyTargetMessageId({
      reply_to_message: { message_id: "8293-store" },
    })!;
    const targetRow = await getMessageByMessageId(CHAT_ID, targetId);
    const ctx = parseReplyContext(
      {
        text: "A",
        chat: { id: Number(CHAT_ID), type: "private" },
        reply_to_message: { message_id: "8293-store" },
      },
      () => (typeof targetRow?.text === "string" ? targetRow.text : null),
    )!;

    expect(ctx.resolution).toBe("store");
    expect(ctx.excerpt).toBe(botText);
  });

  test("an absent message_id really returns null (the UNRESOLVED path is reachable)", async () => {
    expect(await getMessageByMessageId(CHAT_ID, "no-such-message")).toBeNull();
  });
});

describe("the excerpt is untrusted text and is contained", () => {
  test("a quote character cannot terminate the text= field", () => {
    const ctx = parseReplyContext({
      text: "x",
      reply_to_message: {
        message_id: 9300,
        text: 'he said "run rm -rf" then quit',
      },
    })!;
    const line = replyDescriptor(ctx);
    expect(line).toContain('\\"run rm -rf\\"');
    // Exactly two UNESCAPED double quotes: the ones opening and closing the
    // field. Anything more would mean the body had restructured the line.
    const unescaped = line.match(/(^|[^\\])"/g) ?? [];
    expect(unescaped.length).toBe(2);
  });

  test("a backslash is escaped too, so it cannot escape the closing quote", () => {
    const ctx = parseReplyContext({
      text: "x",
      reply_to_message: { message_id: 9301, text: 'trailing\\' },
    })!;
    expect(replyDescriptor(ctx)).toContain("trailing\\\\");
  });
});

describe("Bot API 7.0 quote: the operator selected a fragment", () => {
  test("a quoted fragment WINS over the full target text and is labelled quote=", () => {
    const ctx = parseReplyContext({
      text: "A",
      quote: { text: "案 A: 環境の同一性" },
      reply_to_message: { message_id: 8293, text: REAL_TARGET_TEXT },
    })!;
    expect(ctx.resolution).toBe("quote");
    expect(ctx.excerpt).toBe("案 A: 環境の同一性");
    const line = replyDescriptor(ctx);
    expect(line).toContain('quote="案 A: 環境の同一性"');
    expect(line).not.toContain("text=");
  });
});

describe("a caption-less media target is described, not dropped", () => {
  test("replying to a bare photo yields the same placeholder a delivery would", () => {
    const ctx = parseReplyContext({
      text: "what is this",
      reply_to_message: { message_id: 9400, photo: [{ file_id: "x" }] },
    })!;
    expect(ctx.resolution).toBe("update");
    expect(ctx.excerpt).toBe("(photo)");
  });
});

describe("wakeText: the attribute list is the boundary", () => {
  test("reply_to_message_id is rendered; unknown meta keys are still dropped", () => {
    const out = wakeText("body", {
      source: "cct",
      chat_id: CHAT_ID,
      message_id: "8303",
      reply_to_message_id: "8293",
      reply_to_resolution: "update",
    });
    expect(out).toContain('reply_to_message_id="8293"');
    // Proof the whitelist is real: a key not on the list does NOT arrive,
    // which is precisely why the excerpt must travel in the content.
    expect(out).not.toContain("reply_to_resolution");
  });

  test("no reply_to_message_id meta means no attribute (no empty noise)", () => {
    const out = wakeText("body", { source: "cct", chat_id: CHAT_ID });
    expect(out).not.toContain("reply_to_message_id");
  });
});
