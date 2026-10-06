import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { allowSend } from "./config.js";
import type { ZohoUser } from "./zoho/auth.js";
import { listChats, listChannels, getMessages, getHistory, sendMessage, mapLimit, type Message } from "./cliq/client.js";

// Works out which Zoho user a tool call runs as: from the OAuth token (remote) or from .env (local stdio).
export type UserResolver = (authInfo?: AuthInfo) => ZohoUser;

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

// Messages from every chat active in the last `hours`, tagged with the chat name, newest first.
async function recent(user: ZohoUser, hours: number, perChat: number): Promise<Message[]> {
  const since = new Date(Date.now() - hours * 3600_000);
  const chats = (await listChats(user, 100)).filter((c) => !c.lastActivity || new Date(c.lastActivity) >= since);
  const batches = await mapLimit(chats, 4, async (c) => {
    try {
      return (await getMessages(user, c.id, { from: since, limit: perChat })).map((m) => ({ ...m, chat: c.name }));
    } catch {
      return [];
    }
  });
  return batches.flat().sort((a, b) => b.time.localeCompare(a.time));
}

export function buildServer(resolve: UserResolver): McpServer {
  const server = new McpServer({ name: "zoho-cliq", version: "0.2.0" });

  server.tool(
    "list_chats",
    "List Zoho Cliq chats (DMs, groups, channels) the signed-in user belongs to, most recent first.",
    {
      name: z.string().optional().describe("Filter by chat or person name (case-insensitive, partial match)"),
      type: z.string().optional().describe("Filter by chat type, e.g. dm, chat, channel"),
      limit: z.number().int().min(1).max(100).default(100),
    },
    async ({ name, type, limit }, { authInfo }) => {
      let chats = await listChats(resolve(authInfo), limit);
      if (name) chats = chats.filter((c) => c.name?.toLowerCase().includes(name.toLowerCase()));
      if (type) chats = chats.filter((c) => c.type?.toLowerCase().includes(type.toLowerCase()));
      return ok(chats);
    },
  );

  server.tool("list_channels", "List Zoho Cliq channels.", {}, async (_, { authInfo }) => ok(await listChannels(resolve(authInfo))));

  server.tool(
    "get_messages",
    "Get messages from one Cliq chat. Times are ISO 8601.",
    {
      chat_id: z.string(),
      from: z.string().optional().describe("ISO start time"),
      to: z.string().optional().describe("ISO end time"),
      limit: z.number().int().max(100).default(50),
    },
    async ({ chat_id, from, to, limit }, { authInfo }) =>
      ok(
        await getMessages(resolve(authInfo), chat_id, {
          from: from ? new Date(from) : undefined,
          to: to ? new Date(to) : undefined,
          limit,
        }),
      ),
  );

  server.tool(
    "get_chat_history",
    "Full message history of one or more Cliq chats (use list_chats with `name` to find chat ids). " +
      "Pages back through the whole chat, oldest first. If a chat is truncated, call again with `to` set to its `continue_before` value to get older messages.",
    {
      chat_ids: z.array(z.string()).min(1).max(10),
      from: z.string().optional().describe("ISO start time; omit for the whole history"),
      to: z.string().optional().describe("ISO end time; omit for up to now"),
      max_per_chat: z.number().int().min(1).max(5000).default(1000),
      format: z.enum(["text", "json"]).default("text").describe("text = one compact line per message (saves space)"),
    },
    async ({ chat_ids, from, to, max_per_chat, format }, { authInfo }) => {
      const user = resolve(authInfo);
      const names = new Map((await listChats(user, 100).catch(() => [])).map((c) => [c.id, c.name]));
      const results = await mapLimit(chat_ids, 3, async (id) => {
        try {
          const h = await getHistory(user, id, { from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined, max: max_per_chat });
          return { chat_id: id, chat: names.get(id), count: h.messages.length, truncated: h.truncated, continue_before: h.before, messages: h.messages };
        } catch (e) {
          return { chat_id: id, chat: names.get(id), error: String((e as Error).message ?? e) };
        }
      });
      if (format === "json") return ok(results);
      const text = results
        .map((r) => {
          const head = `=== ${r.chat ?? r.chat_id} (${r.chat_id})`;
          if ("error" in r) return `${head}\nERROR: ${r.error}`;
          const more = r.truncated ? `\n[truncated: older messages exist, call again with to=${r.continue_before}]` : "";
          const lines = r.messages.map((m) => `[${m.time.slice(0, 16).replace("T", " ")}] ${m.sender}: ${m.text}${m.attachments ? ` [file: ${m.attachments.join(", ")}]` : ""}`);
          return `${head}: ${r.count} messages${more}\n${lines.join("\n")}`;
        })
        .join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "recent_activity",
    "All Cliq messages across every active chat in the last N hours. Good for daily summaries.",
    { hours: z.number().positive().max(168).default(24), per_chat: z.number().int().max(100).default(50) },
    async ({ hours, per_chat }, { authInfo }) => ok(await recent(resolve(authInfo), hours, per_chat)),
  );

  server.tool(
    "search_messages",
    "Search recent Cliq messages by text or sender (case-insensitive). Cliq has no global search API, so this scans the last N hours.",
    { query: z.string().min(1), hours: z.number().positive().max(720).default(72) },
    async ({ query, hours }, { authInfo }) => {
      const q = query.toLowerCase();
      const msgs = await recent(resolve(authInfo), hours, 100);
      return ok(msgs.filter((m) => m.text.toLowerCase().includes(q) || m.sender.toLowerCase().includes(q)));
    },
  );

  if (allowSend()) {
    server.tool(
      "send_message",
      "Post a message to a Cliq chat as the signed-in user.",
      { chat_id: z.string(), text: z.string().min(1) },
      async ({ chat_id, text }, { authInfo }) => ok(await sendMessage(resolve(authInfo), chat_id, text)),
    );
  }

  return server;
}
