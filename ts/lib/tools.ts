/**
 * MCP tool definitions and handlers for the Telegram MCP server.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { assertAllowedChat } from "./access.js";
import {
  tgApi,
  sendMessage,
  sendDocument,
  editMessageText,
} from "./telegram-api.js";
import {
  saveOutbound,
  markRead,
  markAllRead,
  searchMessages,
  getConversationContext,
} from "./store.js";
import { HOST_NAME, PROJECT, AGENT_ID, BOT_TOKEN_HASH } from "./config.js";
import { log } from "./log.js";
import {
  handleGetHistory,
  handleGetUnread,
  handleDownloadAttachment,
} from "./tools-messages.js";
import { runHealth, serializeHealthReport } from "./health-adapters.js";

export function registerTools(mcp: Server): void {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description:
          "Reply on Telegram. Pass chat_id from the inbound message. " +
          "Optionally pass reply_to (message_id) for threading. " +
          "Set mark_read=false to keep the inbound message unread.",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: { type: "string" },
            text: { type: "string" },
            reply_to: {
              type: "string",
              description:
                "Message ID to thread under. Use message_id from the inbound <channel> block.",
            },
            row_id: {
              type: "number",
              description:
                "DB row ID of the inbound message being replied to (from row_id in meta). " +
                "Sets replied_at on that message and links the outbound row.",
            },
            mark_read: {
              type: "boolean",
              description:
                "Mark the inbound message (row_id) as read. Default: true.",
            },
          },
          required: ["chat_id", "text"],
        },
      },
      {
        name: "react",
        description:
          "Add an emoji reaction to a Telegram message. " +
          "Telegram only accepts a fixed whitelist.",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: { type: "string" },
            message_id: { type: "string" },
            emoji: { type: "string" },
          },
          required: ["chat_id", "message_id", "emoji"],
        },
      },
      {
        name: "edit_message",
        description:
          "Edit a message the bot previously sent. " +
          "Edits don't trigger push notifications.",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: { type: "string" },
            message_id: { type: "string" },
            text: { type: "string" },
          },
          required: ["chat_id", "message_id", "text"],
        },
      },
      {
        name: "get_history",
        description:
          "Get message history for a chat from the local DB. " +
          "Returns {coverage, count, messages} — messages are inbound and " +
          "outbound in chronological order, and `coverage` states whether " +
          "this store can VOUCH for that window: coverage.verdict is " +
          "'covered' (ingestion is live, so what you see is what arrived) or " +
          "'unverifiable' (the poller was not demonstrably alive, or a gap " +
          "in Telegram's update_id sequence was recorded — read " +
          "coverage.reason before concluding anything from an empty result). " +
          "Messages with stored attachments include an `attachments` array " +
          "({kind, file_id, file_name, mime_type, local_path, downloaded_at}); " +
          "local_path is set once the background auto-download completed.",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: { type: "string" },
            limit: {
              type: "number",
              description: "Max messages to return. Default: 20.",
            },
            offset: {
              type: "number",
              description: "Number of messages to skip. Default: 0.",
            },
          },
          required: ["chat_id"],
        },
      },
      {
        name: "get_unread",
        description:
          "Get unread inbound messages, optionally filtered by chat_id. " +
          "Returns {coverage, count, messages}. An EMPTY messages array is " +
          "only evidence that nothing was sent when coverage.verdict is " +
          "'covered'; when it is 'unverifiable' the store could not observe " +
          "that window at all, so treat the silence as UNKNOWN and act on " +
          "coverage.reason (this is the restart-protocol case: a quiet inbox " +
          "must never be mistaken for an unobserved one). " +
          "Messages with stored attachments include an `attachments` array " +
          "(see get_history).",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: {
              type: "string",
              description: "Filter by chat. Omit to get all unread.",
            },
          },
        },
      },
      {
        name: "mark_read",
        description:
          "Mark messages as read. Pass either chat_id (marks all unread in that chat) " +
          "or message_ids (array of DB row IDs to mark individually).",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: {
              type: "string",
              description: "Mark all unread in this chat as read.",
            },
            message_ids: {
              type: "array",
              items: { type: "number" },
              description: "Array of DB row IDs to mark as read.",
            },
          },
        },
      },
      {
        name: "download_attachment",
        description:
          "Get the local path of a Telegram file attachment. Pass EITHER " +
          "file_id (from the inbound [attachment …] content line) OR row_id " +
          "(the inbound message's DB row id). If the attachment was already " +
          "downloaded (auto-download or a previous call) the existing local " +
          "path is returned immediately without re-downloading; otherwise " +
          "the file is fetched now. Errors clearly when row_id has no " +
          "stored attachment.",
        inputSchema: {
          type: "object" as const,
          properties: {
            file_id: {
              type: "string",
              description:
                "Telegram file_id from the attachment. Optional when row_id is given.",
            },
            row_id: {
              type: "number",
              description:
                "DB row id of the inbound message carrying the attachment " +
                "(row_id from the <channel> meta or get_history).",
            },
            chat_id: {
              type: "string",
              description:
                "Chat ID for organizing downloads. Defaults to the attachment's " +
                "own chat when resolvable, else 'unknown'.",
            },
          },
        },
      },
      {
        name: "send_document",
        description: "Upload a file to a Telegram chat via sendDocument API.",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: {
              type: "string",
              description: "Target chat ID.",
            },
            file_path: {
              type: "string",
              description: "Absolute path to the local file to upload.",
            },
            caption: {
              type: "string",
              description: "Optional caption for the document.",
            },
          },
          required: ["chat_id", "file_path"],
        },
      },
      {
        name: "search_messages",
        description:
          "Text search across stored messages using LIKE matching. " +
          "Returns matching messages in reverse chronological order.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Search text (matched with LIKE %query%).",
            },
            chat_id: {
              type: "string",
              description: "Filter by chat. Omit to search all chats.",
            },
            limit: {
              type: "number",
              description: "Max results. Default: 20.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "health",
        description:
          "Run the claude-code-telegrammer health check (doctor). Returns a JSON report " +
          "{package, ok, checks[], summary} — env hygiene, bot token presence/validity, " +
          "webhook absence, poller liveness, allowlist, state dir, and DB schema/offset. " +
          "Every failing check carries an actionable hint. Takes no parameters.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "get_context",
        description:
          "Get recent conversation context for a chat, formatted as compact text for LLM consumption. " +
          "Returns messages in chronological order with timestamps and sender info.",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: {
              type: "string",
              description: "Chat to get context for.",
            },
            max_messages: {
              type: "number",
              description: "Max messages to include. Default: 10.",
            },
          },
          required: ["chat_id"],
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (req.params.name) {
        case "reply": {
          const chatId = args.chat_id as string;
          const text = args.text as string;
          // Hard length cap (operator 2026-06-04, raised to 512 on
          // 2026-06-06 per operator request): the operator reads on a
          // phone and cannot scan walls of text. REJECT over-limit messages
          // here at the send boundary instead of letting the API layer auto-
          // chunk them — this forces the caller (lead or any agent) to be
          // brief and split. Counts Unicode code points (CJK == Latin).
          // Read PER CALL (not at module load) so a running process picks
          // up CCT_TG_MAX_CHARS if it's set in its environment at spawn.
          const TG_LIMIT = Number(process.env.CCT_TG_MAX_CHARS ?? "512");
          if (
            typeof text === "string" &&
            [...text].length > TG_LIMIT &&
            process.env.CCT_TG_ALLOW_LONG !== "1"
          ) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `BLOCKED: message is ${[...text].length} chars > ${TG_LIMIT}-char limit. ` +
                    `Keep every Telegram message short (<=${TG_LIMIT} chars). ` +
                    `1) SPLIT a long update into MULTIPLE short messages, one point each. ` +
                    `2) Write ONLY what the operator must act on — no filler, no trivia, ` +
                    `no process-narration, no markdown bold. ` +
                    `If it is not worth ${TG_LIMIT} chars to the operator, do not send it. ` +
                    `Override (rare): set env CCT_TG_ALLOW_LONG=1.`,
                },
              ],
              isError: true,
            };
          }
          const replyTo =
            args.reply_to != null ? Number(args.reply_to) : undefined;
          const rowId = args.row_id != null ? Number(args.row_id) : undefined;
          const shouldMarkRead = args.mark_read !== false;
          assertAllowedChat(chatId);
          const msgId = await sendMessage(chatId, text, replyTo);
          try {
            saveOutbound(chatId, text, String(msgId), rowId, {
              host: HOST_NAME,
              project: PROJECT,
              agent_id: AGENT_ID,
              bot_token_hash: BOT_TOKEN_HASH,
            });
            // Mark the inbound as read if requested
            if (shouldMarkRead && rowId) {
              markRead(rowId);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log("tools", "failed to save outbound to store", {
              error: errMsg,
            });
          }
          return { content: [{ type: "text", text: `sent (id: ${msgId})` }] };
        }
        case "react": {
          const chatId = args.chat_id as string;
          assertAllowedChat(chatId);
          await tgApi("setMessageReaction", {
            chat_id: chatId,
            message_id: Number(args.message_id),
            reaction: [{ type: "emoji", emoji: args.emoji as string }],
          });
          return { content: [{ type: "text", text: "reacted" }] };
        }
        case "edit_message": {
          const chatId = args.chat_id as string;
          assertAllowedChat(chatId);
          // editMessageText() applies the agent signature (idempotent).
          const result = await editMessageText(
            chatId,
            Number(args.message_id),
            args.text as string,
          );
          const id =
            typeof result === "object" ? result.message_id : args.message_id;
          return { content: [{ type: "text", text: `edited (id: ${id})` }] };
        }
        // Handler bodies live in tools-messages.ts (unit-testable without
        // an MCP server; keeps this file under the repo line cap).
        case "get_history":
          return handleGetHistory(args);
        case "get_unread":
          return handleGetUnread(args);
        case "mark_read": {
          const chatId = args.chat_id as string | undefined;
          const messageIds = args.message_ids as number[] | undefined;
          if (chatId) {
            assertAllowedChat(chatId);
            markAllRead(chatId);
            return {
              content: [
                {
                  type: "text",
                  text: `marked all unread in ${chatId} as read`,
                },
              ],
            };
          }
          if (messageIds && messageIds.length > 0) {
            for (const id of messageIds) {
              markRead(id);
            }
            return {
              content: [
                {
                  type: "text",
                  text: `marked ${messageIds.length} message(s) as read`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: "provide chat_id or message_ids to mark as read",
              },
            ],
            isError: true,
          };
        }
        case "download_attachment":
          return await handleDownloadAttachment(args);
        case "send_document": {
          const chatId = args.chat_id as string;
          const filePath = args.file_path as string;
          const caption = args.caption as string | undefined;
          assertAllowedChat(chatId);
          const msgId = await sendDocument(chatId, filePath, caption);
          return {
            content: [{ type: "text", text: `document sent (id: ${msgId})` }],
          };
        }
        case "search_messages": {
          const query = args.query as string;
          const chatId = args.chat_id as string | undefined;
          const limit = (args.limit as number) ?? 20;
          if (chatId) assertAllowedChat(chatId);
          const rows = searchMessages(query, chatId, limit);
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          };
        }
        case "health": {
          // Architecture fix (incident-cct-inbound-dies-silently-with-mcp-
          // server-20260711 follow-up, 2026-07): this server process is NO
          // LONGER the poller — the getUpdates loop now runs in a separate,
          // standalone process (ts/telegram-poller.ts; see
          // docs/architecture.md). "self" would report OUR OWN pid, which
          // is always trivially alive and tells you nothing about whether
          // the actual poller process is up. Use "external" — the same
          // lockfile/pidfile round-trip the CLI probe does (reads the
          // per-token pidfile via lib/takeover.ts and kill-0s the recorded
          // PID) — so this tool reports the REAL poller's liveness. The
          // serialized report has the raw token redacted (belt-and-braces —
          // the checks never include it in the first place).
          const report = await runHealth({ poller: "external" });
          return {
            content: [{ type: "text", text: serializeHealthReport(report) }],
          };
        }
        case "get_context": {
          const chatId = args.chat_id as string;
          const maxMessages = (args.max_messages as number) ?? 10;
          assertAllowedChat(chatId);
          const context = getConversationContext(chatId, maxMessages);
          return {
            content: [{ type: "text", text: context }],
          };
        }
        default:
          return {
            content: [
              { type: "text", text: `unknown tool: ${req.params.name}` },
            ],
            isError: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `${req.params.name} failed: ${msg}` }],
        isError: true,
      };
    }
  });
}
