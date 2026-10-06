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

WHICH TOOL
- "Summarise / brief me on / catch me up on my chat with X" -> call summarize_chat once with name=X. It already includes history, files and redaction; don't chain other tools unless the user asks for more.

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

// Fixed answer shape for summarize_chat, so summaries come out short and consistent.
const SUMMARY_FORMAT = `HOW TO ANSWER (keep it short, bullets only, no paragraphs):
**<Chat name>** - <one-line gist> (<N> messages, <first date> to <last date>)
**Decisions** - one bullet each
**Action items** - "<owner>: <task> (due <date>)", one bullet each; include tasks found in screenshots/files
**Open questions / waiting on** - one bullet each
**Files** - one bullet per file that mattered, with what it contained (skip trivial ones)
**Security** - only if redactions were reported: "Credentials were shared in plain text; rotate them." (never show values)
Omit any section that would be empty.`;

type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// Open attachments as the user and convert them; failures become a one-line note instead of an error.
async function readFiles(user: ZohoUser, refs: string[], reveal: boolean): Promise<{ parts: Part[]; found: Record<string, number> }> {
  const found: Record<string, number> = {};
  const parts = await mapLimit(refs, 3, async (ref): Promise<Part[]> => {
    try {
      const a = await findAttachment(user, ref);
      const r = await toContent(a, await downloadFile(user, a, MAX_FILE_BYTES), reveal);
      for (const [k, v] of Object.entries(r.found)) found[k] = (found[k] ?? 0) + v;
      return r.content;
    } catch (e) {
      return [{ type: "text", text: `--- ${ref}: could not read (${(e as Error).message})` }];
    }
  });
  return { parts: parts.flat(), found };
}

const merge = (a: Record<string, number>, b: Record<string, number>) => {
  for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v;
  return a;
};

export function buildServer(resolve: UserResolver): McpServer {
  const server = new McpServer({ name: "zoho-cliq", version: "0.4.0" }, { instructions: INSTRUCTIONS });

  server.tool(
    "summarize_chat",
    "ONE-STEP chat summary. Use this whenever the user asks to summarise / brief / catch up on a chat with a person, group or channel. " +
      "Finds the chat by name, pulls its history, automatically opens screenshots and files, redacts secrets, and returns everything with the answer format to follow.",
    {
      name: z.string().min(1).describe("Person, group or channel name, e.g. 'Karan'"),
      from: z.string().optional().describe("ISO start time; default: last 30 days"),
      to: z.string().optional().describe("ISO end time; default: now"),
      max_messages: z.number().int().min(1).max(3000).default(1000),
      max_files: z.number().int().min(0).max(25).default(15).describe("How many attachments to open (newest first)"),
    },
    async ({ name, from, to, max_messages, max_files }, { authInfo }) => {
      const user = resolve(authInfo);
      const text = (t: string): Part => ({ type: "text", text: t });

      // 1. Find the chat. Prefer an exact name match; if still ambiguous, ask instead of guessing.
      const q = name.toLowerCase();
      const all = await listChats(user, 100);
      const hits = all.filter((c) => c.name?.toLowerCase().includes(q));
      const exact = hits.filter((c) => c.name?.toLowerCase() === q);
      const pick = exact.length === 1 ? exact : hits;
      if (pick.length === 0) return { content: [text(`No chat matching "${name}" among your 100 most recent chats. Ask the user for the exact chat name.`)] };
      if (pick.length > 1)
        return { content: [text(`Several chats match "${name}". Ask the user which one (one short question), then call again with the exact name:\n` + pick.map((c) => `- ${c.name} (${c.type})`).join("\n"))] };
      const chat = pick[0];

      // 2. History for the period (default: last 30 days), redacted.
      const fromD = from ? new Date(from) : new Date(Date.now() - 30 * 86400_000);
      const h = await getHistory(user, chat.id, { from: fromD, to: to ? new Date(to) : undefined, max: max_messages });
      const msgs = redactAll(h.messages, false);
      const found = { ...msgs.found };

      // 3. Open attachments automatically, newest first.
      const refs = msgs.items.flatMap((m) => (m.attachments ?? []).map((a) => a.ref!)).filter(Boolean);
      const chosen = refs.slice(-max_files).reverse();
      const files = chosen.length ? await readFiles(user, chosen, false) : { parts: [], found: {} };
      merge(found, files.found);

      const period = msgs.items.length
        ? `${msgs.items[0].time.slice(0, 10)} to ${msgs.items.at(-1)!.time.slice(0, 10)}`
        : `${fromD.toISOString().slice(0, 10)} to now`;
      const skipped = refs.length - chosen.length;
      const header =
        `CHAT: ${chat.name} | ${msgs.items.length} messages | ${period}` +
        (h.truncated ? " | older messages exist (call again with an earlier `from` if the user wants them)" : "") +
        ` | files: ${chosen.length} opened` + (skipped > 0 ? `, ${skipped} older not opened` : "");

      const notice = redactionNotice(found);
      return {
        content: [
          text(SUMMARY_FORMAT),
          ...(notice ? [text(notice)] : []),
          text(`${header}\n\n${msgs.items.map(line).join("\n") || "(no messages in this period)"}`),
          ...(files.parts.length ? [text("ATTACHMENTS:"), ...files.parts] : []),
        ],
      };
    },
  );

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
      const r = await readFiles(resolve(authInfo), refs, reveal_sensitive);
      const notice = redactionNotice(r.found);
      return { content: [...(notice ? [{ type: "text" as const, text: notice }] : []), ...r.parts] };
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
