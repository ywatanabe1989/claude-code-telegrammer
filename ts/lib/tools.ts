/**
 * MCP tool definitions and handlers for the Telegram MCP server.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { assertAllowedChat } from "./access.js";
import { tgApi, sendMessage, sendDocument } from "./telegram-api.js";
import {
  saveOutbound,
  getHistory,
  getUnread,
  markRead,
  markAllRead,
  searchMessages,
  getConversationContext,
} from "./store.js";
import { HOST_NAME, PROJECT, AGENT_ID, BOT_TOKEN_HASH } from "./config.js";
import { log } from "./log.js";
import { downloadNow } from "./attachments.js";

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
          "Returns both inbound and outbound messages in chronological order.",
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
          "Get unread inbound messages, optionally filtered by chat_id.",
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
          "Download a Telegram file attachment immediately. Returns the local file path.",
        inputSchema: {
          type: "object" as const,
          properties: {
            file_id: {
              type: "string",
              description: "Telegram file_id from the attachment.",
            },
            chat_id: {
              type: "string",
              description:
                "Chat ID for organizing downloads. Defaults to 'unknown'.",
            },
          },
          required: ["file_id"],
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
          const result = await tgApi("editMessageText", {
            chat_id: chatId,
            message_id: Number(args.message_id),
            text: args.text as string,
          });
          const id =
            typeof result === "object" ? result.message_id : args.message_id;
          return { content: [{ type: "text", text: `edited (id: ${id})` }] };
        }
        case "get_history": {
          const chatId = args.chat_id as string;
          const limit = (args.limit as number) ?? 20;
          const offset = (args.offset as number) ?? 0;
          assertAllowedChat(chatId);
          const rows = getHistory(chatId, limit, offset);
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          };
        }
        case "get_unread": {
          const chatId = args.chat_id as string | undefined;
          if (chatId) assertAllowedChat(chatId);
          const rows = getUnread(chatId);
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          };
        }
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
        case "download_attachment": {
          const fileId = args.file_id as string;
          const chatId = (args.chat_id as string) ?? "unknown";
          const localPath = await downloadNow(fileId, chatId);
          return {
            content: [{ type: "text", text: `downloaded to: ${localPath}` }],
          };
        }
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
