/**
 * MCP tool definitions and handlers for the Telegram MCP server.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { assertAllowedChat } from "./access.js";
import { tgApi, sendMessage } from "./telegram-api.js";
import { saveOutbound } from "./store.js";

export function registerTools(mcp: Server): void {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description:
          "Reply on Telegram. Pass chat_id from the inbound message. " +
          "Optionally pass reply_to (message_id) for threading.",
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
          assertAllowedChat(chatId);
          const msgId = await sendMessage(chatId, text, replyTo);
          try {
            saveOutbound(chatId, text, String(msgId));
          } catch (err) {
            // Log but don't fail the reply if store write fails
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`failed to save outbound to store: ${errMsg}`);
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
