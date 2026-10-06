import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { allowSend } from "./config.js";
import type { ZohoUser } from "./zoho/auth.js";
import { listChats, listChannels, getMessages, getHistory, sendMessage, mapLimit, findAttachment, downloadFile, type Message } from "./cliq/client.js";
import { toContent, MAX_FILE_BYTES } from "./files.js";
import { redactAll, redactionNotice } from "./redact.js";

// Works out which Zoho user a tool call runs as: from the OAuth token (remote) or from .env (local stdio).
export type UserResolver = (authInfo?: AuthInfo) => ZohoUser;

// Sent to Claude once per connection; it shapes every answer built from this connector.
const INSTRUCTIONS = `Zoho Cliq connector. Rules for answers built from Cliq data:

STYLE
- Be brief. Lead with the answer in one line, then short bullets. No long paragraphs, no filler, no restating the request.
- Summaries: group by chat or topic; one bullet per decision, action item or open question; name who owns each action and any date.
- Quote a message only when exact wording matters, and keep quotes short.
- Mention how many messages or which period you covered in one short line, not a paragraph.

FILES
- Messages may carry screenshots, PDFs or documents, shown as [file: name ref=...]. If they could hold tasks, decisions or numbers relevant to the request, open them with read_attachments (batch up to 10 refs) instead of skipping them. Say briefly if some files couldn't be read.

SENSITIVE DATA
- Secrets and personal IDs (API keys, tokens, passwords, OTPs, private keys, card numbers, SSN, PAN, Aadhaar) are replaced with [REDACTED: type] before you see them.
- Never try to guess, reconstruct or work around a redaction.
- When redactions appear, tell the user briefly that credentials were shared in plain text and should be rotated.
- Only set reveal_sensitive=true if the user explicitly asks to see the hidden values AND confirms after you warn them. Never set it on your own initiative, and never include revealed values in summaries.`;

const ok = (data: unknown, notice = "") => ({
  content: [
    ...(notice ? [{ type: "text" as const, text: notice }] : []),
    { type: "text" as const, text: JSON.stringify(data, null, 2) },
  ],
});

const reveal = z
  .boolean()
  .default(false)
  .describe("Show hidden secrets/IDs. ONLY true after the user explicitly asked AND confirmed after a warning.");

const line = (m: Message) =>
  `[${m.time.slice(0, 16).replace("T", " ")}] ${m.sender}: ${m.text}` +
  (m.attachments ?? []).map((a) => ` [file: ${a.name} ref=${a.ref}]`).join("");

// Download URLs stay server-side; Claude only needs the name, type and ref.
const publicMsg = (m: Message) => ({ ...m, attachments: m.attachments?.map(({ url, id, ...a }) => a) });

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
  const server = new McpServer({ name: "zoho-cliq", version: "0.3.0" }, { instructions: INSTRUCTIONS });

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
    "Get up to 100 messages from one Cliq chat. Times are ISO 8601. Sensitive values are redacted.",
    {
      chat_id: z.string(),
      from: z.string().optional().describe("ISO start time"),
      to: z.string().optional().describe("ISO end time"),
      limit: z.number().int().min(1).max(100).default(50),
      reveal_sensitive: reveal,
    },
    async ({ chat_id, from, to, limit, reveal_sensitive }, { authInfo }) => {
      const msgs = await getMessages(resolve(authInfo), chat_id, {
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        limit,
      });
      const r = redactAll(msgs, reveal_sensitive);
      return ok(r.items.map(publicMsg), redactionNotice(r.found));
    },
  );

  server.tool(
    "get_chat_history",
    "Full message history of one or more Cliq chats (use list_chats with `name` to find chat ids). " +
      "Pages back through the whole chat, oldest first. If a chat is truncated, call again with `to` set to its `continue_before` value to get older messages. " +
      "Sensitive values are redacted.",
    {
      chat_ids: z.array(z.string()).min(1).max(10),
      from: z.string().optional().describe("ISO start time; omit for the whole history"),
      to: z.string().optional().describe("ISO end time; omit for up to now"),
      max_per_chat: z.number().int().min(1).max(5000).default(1000),
      format: z.enum(["text", "json"]).default("text").describe("text = one compact line per message (saves space)"),
      reveal_sensitive: reveal,
    },
    async ({ chat_ids, from, to, max_per_chat, format, reveal_sensitive }, { authInfo }) => {
      const user = resolve(authInfo);
      const names = new Map((await listChats(user, 100).catch(() => [])).map((c) => [c.id, c.name]));
      const found: Record<string, number> = {};
      const results = await mapLimit(chat_ids, 3, async (id) => {
        try {
          const h = await getHistory(user, id, { from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined, max: max_per_chat });
          const r = redactAll(h.messages, reveal_sensitive);
          for (const [k, v] of Object.entries(r.found)) found[k] = (found[k] ?? 0) + v;
          return { chat_id: id, chat: names.get(id), count: r.items.length, truncated: h.truncated, continue_before: h.before, messages: r.items };
        } catch (e) {
          return { chat_id: id, chat: names.get(id), error: String((e as Error).message ?? e) };
        }
      });
      const notice = redactionNotice(found);
      if (format === "json") return ok(results.map((r) => (r.messages ? { ...r, messages: r.messages.map(publicMsg) } : r)), notice);
      const text = results
        .map((r) => {
          const head = `=== ${r.chat ?? r.chat_id} (${r.chat_id})`;
          if ("error" in r) return `${head}\nERROR: ${r.error}`;
          const more = r.truncated ? `\n[truncated: older messages exist, call again with to=${r.continue_before}]` : "";
          return `${head}: ${r.count} messages${more}\n${r.messages.map(line).join("\n")}`;
        })
        .join("\n\n");
      return { content: [...(notice ? [{ type: "text" as const, text: notice }] : []), { type: "text" as const, text }] };
    },
  );

  server.tool(
    "recent_activity",
    "All Cliq messages across every active chat in the last N hours. Good for daily summaries. Sensitive values are redacted.",
    {
      hours: z.number().positive().max(168).default(24),
      per_chat: z.number().int().min(1).max(100).default(50),
      reveal_sensitive: reveal,
    },
    async ({ hours, per_chat, reveal_sensitive }, { authInfo }) => {
      const r = redactAll(await recent(resolve(authInfo), hours, per_chat), reveal_sensitive);
      return ok(r.items.map(publicMsg), redactionNotice(r.found));
    },
  );

  server.tool(
    "search_messages",
    "Search recent Cliq messages by text or sender (case-insensitive). Cliq has no global search API, so this scans the last N hours. " +
      "Sensitive values are redacted and cannot be searched for unless revealed.",
    { query: z.string().min(1), hours: z.number().positive().max(720).default(72), reveal_sensitive: reveal },
    async ({ query, hours, reveal_sensitive }, { authInfo }) => {
      const q = query.toLowerCase();
      // Redact first, so a search can't be used to probe hidden values.
      const r = redactAll(await recent(resolve(authInfo), hours, 100), reveal_sensitive);
      const hits = r.items.filter((m) => m.text.toLowerCase().includes(q) || m.sender.toLowerCase().includes(q));
      const found: Record<string, number> = {};
      for (const m of hits) for (const [, k] of m.text.matchAll(/\[REDACTED: ([^\]]+)\]/g)) found[k] = (found[k] ?? 0) + 1;
      return ok(hits.map(publicMsg), redactionNotice(found));
    },
  );

  server.tool(
    "read_attachments",
    "Open files attached to Cliq messages (screenshots/images are returned as images; PDF, Word, text and CSV as extracted text). " +
      "Pass the `ref` values shown as [file: name ref=...] in message results. Text is redacted like messages.",
    { refs: z.array(z.string()).min(1).max(10), reveal_sensitive: reveal },
    async ({ refs, reveal_sensitive }, { authInfo }) => {
      const user = resolve(authInfo);
      const found: Record<string, number> = {};
      const parts = await mapLimit(refs, 3, async (ref) => {
        try {
          const a = await findAttachment(user, ref);
          const r = await toContent(a, await downloadFile(user, a, MAX_FILE_BYTES), reveal_sensitive);
          for (const [k, v] of Object.entries(r.found)) found[k] = (found[k] ?? 0) + v;
          return r.content;
        } catch (e) {
          return [{ type: "text" as const, text: `--- ${ref}: could not read (${(e as Error).message})` }];
        }
      });
      const notice = redactionNotice(found);
      return { content: [...(notice ? [{ type: "text" as const, text: notice }] : []), ...parts.flat()] };
    },
  );

  if (allowSend()) {
    server.tool(
      "send_message",
      "Post a message to a Cliq chat as the signed-in user. Show the user the exact text and get their OK before sending.",
      { chat_id: z.string(), text: z.string().min(1) },
      async ({ chat_id, text }, { authInfo }) => ok(await sendMessage(resolve(authInfo), chat_id, text)),
    );
  }

  return server;
}
