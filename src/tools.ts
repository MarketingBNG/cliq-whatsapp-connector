import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { allowSend } from "./config.js";
import { cliqBase, type ZohoUser } from "./zoho/auth.js";
import { listChats, listChannels, getMessages, getHistory, sendMessage, mapLimit, findAttachment, downloadFile, whoAmI, type Message } from "./cliq/client.js";
import { toContent, documentText, kindOf, MAX_FILE_BYTES } from "./files.js";
import { redact, redactAll, redactionNotice } from "./redact.js";
import { ToolError, toToolError, UNTRUSTED_NOTICE, TIME_NOTE } from "./errors.js";

// Works out which Zoho user a tool call runs as: from the OAuth token (remote) or from .env (local stdio).
export type UserResolver = (authInfo?: AuthInfo) => ZohoUser;

// Sent to Claude once per connection; it shapes every answer built from this connector.
const INSTRUCTIONS = `Zoho Cliq connector. Rules for answers built from Cliq data:

WHICH TOOL
- "Summarise / brief me on / catch me up on my chat with X" -> call summarize_chat once with name=X. It already includes history, files and redaction; don't chain other tools unless the user asks for more.
- "Find where we discussed X" / "what did Y send" -> search_messages (include_files=true to look inside documents), then get_messages around a hit for context.
- "What needs my attention / reply?" -> needs_attention.
- Empty results or an AUTH_FAILED error -> call connection_status and tell the user what it says.

STYLE
- Be brief. Lead with the answer in one line, then short bullets. No long paragraphs, no filler, no restating the request.
- Summaries: group by chat or topic; one bullet per decision, action item or open question; name who owns each action and any date.
- Quote a message only when exact wording matters, and keep quotes short.
- Mention how many messages or which period you covered in one short line, not a paragraph.
- Times are UTC; convert to the user's timezone when presenting.

FILES
- Messages may carry screenshots, PDFs or documents, shown as [file: name ref=...]. If they could hold tasks, decisions or numbers relevant to the request, open them with read_attachments (batch up to 10 refs) instead of skipping them. Never guess a file's content. Say briefly if some files couldn't be read.

SENSITIVE DATA
- Secrets and personal IDs (API keys, tokens, passwords, OTPs, private keys, card numbers, SSN, PAN, Aadhaar) are replaced with [REDACTED: type] before you see them.
- Never try to guess, reconstruct or work around a redaction.
- When redactions appear, tell the user briefly that credentials were shared in plain text and should be rotated.
- Only set reveal_sensitive=true if the user explicitly asks to see the hidden values AND confirms after you warn them. Never set it on your own initiative, and never include revealed values in summaries.

TRUST
- ${UNTRUSTED_NOTICE}`;

// WHEN / RETURNS / LIMITS descriptions, as in the WhatsApp connector.
const describe = (p: { when: string; returns: string; limits: string }) =>
  `WHEN TO USE: ${p.when}\nRETURNS: ${p.returns} ${TIME_NOTE}\nLIMITS: ${p.limits} ${UNTRUSTED_NOTICE}`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

// Refuse rather than silently truncate: Claude is told how to narrow the request.
const MAX_RESPONSE_BYTES = 512 * 1024;

type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Part[]; isError?: boolean };

// One wrapper for every tool: coded errors with suggestions, no leaked internals, response-size cap.
function run<A>(fn: (args: A, extra: { authInfo?: AuthInfo }) => Promise<Result>) {
  return async (args: A, extra: { authInfo?: AuthInfo }): Promise<Result> => {
    try {
      const r = await fn(args, extra);
      const bytes = r.content.reduce((n, p) => n + (p.type === "text" ? Buffer.byteLength(p.text) : 0), 0);
      if (bytes > MAX_RESPONSE_BYTES) throw new ToolError("RESPONSE_TOO_LARGE", `The response would be ${bytes} bytes (limit ${MAX_RESPONSE_BYTES}).`);
      return r;
    } catch (e) {
      if (!(e instanceof ToolError)) console.error("tool error:", (e as Error)?.message);
      return { content: [{ type: "text", text: JSON.stringify(toToolError(e).toClientPayload()) }], isError: true };
    }
  };
}

const ok = (data: unknown, notice = ""): Result => ({
  content: [...(notice ? [{ type: "text" as const, text: notice }] : []), { type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const date = (s: string | undefined, field: string) => {
  if (!s) return undefined;
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new ToolError("INVALID_INPUT", `\`${field}\` is not a valid ISO-8601 time: ${s}`);
  return d;
};
function range(from?: string, to?: string, names = ["from", "to"]) {
  const a = date(from, names[0]);
  const b = date(to, names[1]);
  if (a && b && a >= b) throw new ToolError("INVALID_DATE_RANGE", "The date range is empty or reversed.");
  return { from: a, to: b };
}

const reveal = z
  .boolean()
  .default(false)
  .describe("Show hidden secrets/IDs. ONLY true after the user explicitly asked AND confirmed after a warning.");

const line = (m: Message) =>
  `[${m.time.slice(0, 16).replace("T", " ")}] ${m.sender}` +
  (m.replyTo ? ` (reply to ${m.replyTo.sender ?? "a message"}${m.replyTo.preview ? `: "${m.replyTo.preview.slice(0, 60)}"` : ""})` : "") +
  `: ${m.text}` + (m.edited ? " (edited)" : "") +
  (m.attachments ?? []).map((a) => ` [file: ${a.name} ref=${a.ref}]`).join("");

// Download URLs stay server-side; Claude only needs the name, type and ref.
const publicMsg = (m: Message) => ({ ...m, attachments: m.attachments?.map(({ url, id, ...a }) => a) });

// Messages from every chat active in [since, until] (or just one chat), tagged with the chat name, newest first.
// At most this many chats are read per call, most recently active first, so one request can't fan out into
// hundreds of Cliq calls (rate limits, timeouts). Callers report chatsSkipped so Claude can say coverage was partial.
export const MAX_SCAN_CHATS = 120;

async function recent(user: ZohoUser, since: Date, perChat: number, until?: Date, onlyChat?: string) {
  const all = await listChats(user);
  const active = onlyChat
    ? all.filter((c) => c.id === onlyChat)
    : all.filter((c) => c.lastActivity && new Date(c.lastActivity) >= since);
  if (onlyChat && active.length === 0) active.push({ id: onlyChat, name: onlyChat, type: "" }); // not listed: let Cliq decide
  const chats = active.slice(0, MAX_SCAN_CHATS);
  const batches = await mapLimit(chats, 4, async (c) => {
    try {
      return (await getMessages(user, c.id, { from: since, to: until, limit: perChat })).map((m) => ({ ...m, chat: c.name }));
    } catch {
      return [];
    }
  });
  return {
    messages: batches.flat().sort((a, b) => b.time.localeCompare(a.time)),
    chatsScanned: chats.length,
    chatsSkipped: active.length - chats.length,
  };
}

// Search terms: "quoted phrases" must appear as written; other words must all appear, each matching the
// start of a word (so "invoice" also finds "invoices"). Case-insensitive.
export function matcher(query: string): (text: string) => boolean {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase().trim()).filter(Boolean);
  const words = query.replace(/"[^"]*"/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const res = words.map((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}`, "u"));
  return (text) => {
    const t = text.toLowerCase();
    return phrases.every((p) => t.includes(p)) && res.every((r) => r.test(t));
  };
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
      return [{ type: "text", text: `--- ${ref}: could not read (${(e as Error).message.slice(0, 120)})` }];
    }
  });
  return { parts: parts.flat(), found };
}

const merge = (a: Record<string, number>, b: Record<string, number>) => {
  for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v;
  return a;
};

export function buildServer(resolve: UserResolver): McpServer {
  const server = new McpServer({ name: "zoho-cliq", version: "0.6.0" }, { instructions: INSTRUCTIONS });
  const text = (t: string): Part => ({ type: "text", text: t });

  server.registerTool(
    "summarize_chat",
    {
      description: describe({
        when: 'The user asks to summarise / brief / catch up on a chat with a person, group or channel ("catch me up with Karan"). One call is enough.',
        returns: "The answer format to follow, the chat's messages for the period (default last 30 days), then the newest screenshots/files already opened. Secrets are redacted.",
        limits: "Looks through all your chats (up to 1,000); if several match it returns the candidates so you can ask which one.",
      }),
      inputSchema: {
        name: z.string().min(1).describe("Person, group or channel name, e.g. 'Karan'"),
        from: z.string().optional().describe("ISO start time; default: last 30 days"),
        to: z.string().optional().describe("ISO end time; default: now"),
        max_messages: z.number().int().min(1).max(3000).default(1000),
        max_files: z.number().int().min(0).max(25).default(15).describe("How many attachments to open (newest first)"),
      },
      annotations: READ_ONLY,
    },
    run(async ({ name, from, to, max_messages, max_files }, { authInfo }) => {
      const user = resolve(authInfo);
      const r = range(from, to);

      // 1. Find the chat. Prefer an exact name match; if still ambiguous, ask instead of guessing.
      const q = name.toLowerCase();
      const hits = (await listChats(user)).filter((c) => c.name?.toLowerCase().includes(q));
      const exact = hits.filter((c) => c.name?.toLowerCase() === q);
      const pick = exact.length === 1 ? exact : hits;
      if (pick.length === 0) return { content: [text(`No chat matching "${name}" among your chats. Ask the user for the exact chat name.`)] };
      if (pick.length > 1)
        return { content: [text(`Several chats match "${name}". Ask the user which one (one short question), then call again with the exact name:\n` + pick.map((c) => `- ${c.name} (${c.type})`).join("\n"))] };
      const chat = pick[0];

      // 2. History for the period, redacted.
      const fromD = r.from ?? new Date(Date.now() - 30 * 86400_000);
      const h = await getHistory(user, chat.id, { from: fromD, to: r.to, max: max_messages });
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
    }),
  );

  server.registerTool(
    "list_chats",
    {
      description: describe({
        when: "To find a chat id by person, group or channel name, or to see which chats were active recently.",
        returns: "Chats newest-first: id, name, type (dm, chat, channel), lastActivity. Next: get_messages or get_chat_history with the id.",
        limits: "Searches all your chats (up to 1,000); returns up to `limit` of the matches.",
      }),
      inputSchema: {
        name: z.string().optional().describe("Filter by chat or person name (case-insensitive, partial match)"),
        type: z.string().optional().describe("Filter by chat type, e.g. dm, chat, channel"),
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: READ_ONLY,
    },
    run(async ({ name, type, limit }, { authInfo }) => {
      let chats = await listChats(resolve(authInfo));
      if (name) chats = chats.filter((c) => c.name?.toLowerCase().includes(name.toLowerCase()));
      if (type) chats = chats.filter((c) => c.type?.toLowerCase().includes(type.toLowerCase()));
      return ok({ total: chats.length, shown: Math.min(limit, chats.length), chats: chats.slice(0, limit) });
    }),
  );

  server.registerTool(
    "list_channels",
    {
      description: describe({
        when: "To list Cliq channels with descriptions and member counts.",
        returns: "id, chatId (use with get_messages), name, description, members.",
        limits: "Up to 100 channels.",
      }),
      inputSchema: {},
      annotations: READ_ONLY,
    },
    run(async (_args, { authInfo }) => ok(await listChannels(resolve(authInfo)))),
  );

  server.registerTool(
    "get_messages",
    {
      description: describe({
        when: "To read a short stretch of one chat, e.g. around a search hit (set from/to around its time).",
        returns: "Up to 100 messages (oldest first) with sender, time, text, replyTo (what a reply answers), mentions and attachments (each with a ref for read_attachments); the window used is echoed back. Pass olderCursor as `cursor` for the page before. Secrets are redacted.",
        limits: "Max 100; for longer periods use get_chat_history. An empty list means no messages in that window, not an error.",
      }),
      inputSchema: {
        chat_id: z.string().min(1),
        from: z.string().optional().describe("ISO start time"),
        to: z.string().optional().describe("ISO end time"),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional().describe("olderCursor from a previous call: returns the page before it"),
        reveal_sensitive: reveal,
      },
      annotations: READ_ONLY,
    },
    run(async ({ chat_id, from, to, limit, cursor, reveal_sensitive }, { authInfo }) => {
      const r = range(from, cursor ?? to, ["from", cursor ? "cursor" : "to"]);
      const msgs = (await getMessages(resolve(authInfo), chat_id, { ...r, limit })).sort((a, b) => a.time.localeCompare(b.time));
      const red = redactAll(msgs, reveal_sensitive);
      const oldest = Date.parse(msgs[0]?.time ?? "");
      const olderCursor = msgs.length >= limit && !isNaN(oldest) ? new Date(oldest - 1).toISOString() : undefined;
      return ok(
        { window: { from: r.from?.toISOString(), to: r.to?.toISOString() }, count: red.items.length, olderCursor, messages: red.items.map(publicMsg) },
        redactionNotice(red.found),
      );
    }),
  );

  server.registerTool(
    "get_chat_history",
    {
      description: describe({
        when: "To read a long period or the whole history of 1-10 chats (get ids from list_chats).",
        returns: "Messages oldest first, one compact line each (or JSON). If a chat is truncated, call again with `to` set to its `continue_before` value for older messages. Secrets are redacted.",
        limits: "Up to 5,000 messages per chat per call; very large results are refused with a hint to narrow the range.",
      }),
      inputSchema: {
        chat_ids: z.array(z.string()).min(1).max(10),
        from: z.string().optional().describe("ISO start time; omit for the whole history"),
        to: z.string().optional().describe("ISO end time; omit for up to now"),
        max_per_chat: z.number().int().min(1).max(5000).default(1000),
        format: z.enum(["text", "json"]).default("text").describe("text = one compact line per message (saves space)"),
        reveal_sensitive: reveal,
      },
      annotations: READ_ONLY,
    },
    run(async ({ chat_ids, from, to, max_per_chat, format, reveal_sensitive }, { authInfo }) => {
      const user = resolve(authInfo);
      const r = range(from, to);
      const names = new Map((await listChats(user).catch(() => [])).map((c) => [c.id, c.name]));
      const found: Record<string, number> = {};
      const results = await mapLimit(chat_ids, 3, async (id) => {
        try {
          const h = await getHistory(user, id, { from: r.from, to: r.to, max: max_per_chat });
          const red = redactAll(h.messages, reveal_sensitive);
          merge(found, red.found);
          return { chat_id: id, chat: names.get(id), count: red.items.length, truncated: h.truncated, continue_before: h.before, messages: red.items };
        } catch (e) {
          return { chat_id: id, chat: names.get(id), error: toToolError(e).toClientPayload().error };
        }
      });
      const notice = redactionNotice(found);
      if (format === "json") return ok(results.map((x) => ("messages" in x && x.messages ? { ...x, messages: x.messages.map(publicMsg) } : x)), notice);
      const body = results
        .map((x) => {
          const head = `=== ${x.chat ?? x.chat_id} (${x.chat_id})`;
          if ("error" in x && x.error) return `${head}\nERROR ${x.error.code}: ${x.error.message} ${x.error.suggestion}`;
          const more = x.truncated ? `\n[truncated: older messages exist, call again with to=${x.continue_before}]` : "";
          return `${head}: ${x.count} messages${more}\n${x.messages.map(line).join("\n")}`;
        })
        .join("\n\n");
      return { content: [...(notice ? [text(notice)] : []), text(body)] };
    }),
  );

  server.registerTool(
    "recent_activity",
    {
      description: describe({
        when: 'Daily or weekly round-ups ("what happened in Cliq today?").',
        returns: "Messages from every chat active in the last N hours, newest first, each tagged with its chat name. Secrets are redacted.",
        limits: "Up to 168 hours; per_chat caps messages per chat.",
      }),
      inputSchema: {
        hours: z.number().positive().max(168).default(24),
        per_chat: z.number().int().min(1).max(100).default(50),
        reveal_sensitive: reveal,
      },
      annotations: READ_ONLY,
    },
    run(async ({ hours, per_chat, reveal_sensitive }, { authInfo }) => {
      const rec = await recent(resolve(authInfo), new Date(Date.now() - hours * 3600_000), per_chat);
      const red = redactAll(rec.messages, reveal_sensitive);
      return ok(
        { hours, chatsScanned: rec.chatsScanned, chatsSkipped: rec.chatsSkipped, count: red.items.length, messages: red.items.map(publicMsg) },
        redactionNotice(red.found),
      );
    }),
  );

  server.registerTool(
    "search_messages",
    {
      description: describe({
        when: 'To find messages about a topic, an exact phrase (in double quotes: "final invoice"), or everything one person sent (from: "Shweta", query optional).',
        returns: "Matches newest-first with chat, chatId, time, sender, text and file refs, plus the window searched and the total. Next: get_messages with that chatId and from/to around the time, for context.",
        limits:
          "Cliq has no search API, so this scans chats active in the window (default last 3 days, max 30 days). All words must match (case-insensitive; a word also matches longer words starting with it). " +
          "Matches message text and file names; with include_files=true also the text inside PDF, Word, Excel, zip and text files in the window (up to max_files, newest first; not images or audio). Try synonyms in separate calls. Redacted values can't be searched. Default 20 results, max 50.",
      }),
      inputSchema: {
        query: z.string().max(200).optional().describe('Words to find; "double quotes" for an exact phrase. Optional when `from` is given.'),
        from: z.string().min(2).max(100).optional().describe("Only messages from senders whose name contains this"),
        chat_id: z.string().optional().describe("Only search this chat"),
        after: z.string().optional().describe("ISO start time; default 3 days ago"),
        before: z.string().optional().describe("ISO end time; default now"),
        hours: z.number().positive().max(720).optional().describe("Alternative to `after`: look back this many hours"),
        limit: z.number().int().min(1).max(50).default(20),
        include_files: z.boolean().default(false).describe("Also search the text inside documents (slower)"),
        max_files: z.number().int().min(1).max(30).default(15).describe("With include_files: how many documents to open, newest first"),
        reveal_sensitive: reveal,
      },
      annotations: READ_ONLY,
    },
    run(async ({ query, from, chat_id, after, before, hours, limit, include_files, max_files, reveal_sensitive }, { authInfo }) => {
      const user = resolve(authInfo);
      if (!query?.trim() && !from) throw new ToolError("INVALID_INPUT", "Give `query`, `from`, or both.");
      const r = range(after, before, ["after", "before"]);
      const since = r.from ?? new Date((r.to?.getTime() ?? Date.now()) - (hours ?? 72) * 3600_000);
      if (Date.now() - since.getTime() > 30 * 86400_000) throw new ToolError("INVALID_INPUT", "The search window can reach back at most 30 days; move `after` later.");
      // Redact first, so a search can't be used to probe hidden values.
      const rec = await recent(user, since, 100, r.to, chat_id);
      const red = redactAll(rec.messages, reveal_sensitive);
      const match = query?.trim() ? matcher(query) : () => true;
      const who = from?.toLowerCase();
      const bySender = red.items.filter((m) => !who || m.sender.toLowerCase().includes(who));
      const all: (Message & { matchedIn?: string; snippet?: string })[] = bySender.filter((m) =>
        match([m.text, ...(m.attachments ?? []).map((a) => a.name)].join(" ")),
      );
      let filesOpened = 0;
      if (include_files && query?.trim()) {
        // Open documents (newest first) on messages that didn't already match, and search their redacted text.
        const done = new Set(all.map((m) => m.id));
        const docs = bySender
          .filter((m) => !done.has(m.id))
          .flatMap((m) => (m.attachments ?? []).filter((a) => ["pdf", "docx", "xlsx", "zip", "text"].includes(kindOf(a.name, a.type))).map((a) => ({ m, a })))
          .slice(0, max_files);
        filesOpened = docs.length;
        const first = query.replace(/"/g, " ").toLowerCase().split(/\s+/).filter(Boolean)[0] ?? "";
        const opened = await mapLimit(docs, 3, async ({ m, a }) => {
          try {
            const f = await downloadFile(user, a, MAX_FILE_BYTES);
            const t = await documentText(f.data, kindOf(a.name, f.contentType));
            if (!t) return null;
            const safe = reveal_sensitive ? t : redact(t).text;
            if (!match(safe)) return null;
            const i = Math.max(0, safe.toLowerCase().indexOf(first));
            return { ...m, matchedIn: `file: ${a.name}`, snippet: safe.slice(Math.max(0, i - 80), i + 160).replace(/\s+/g, " ") };
          } catch {
            return null;
          }
        });
        for (const h of opened) if (h && !done.has(h.id)) (all.push(h), done.add(h.id));
        all.sort((a, b) => b.time.localeCompare(a.time));
      }
      const hits = all.slice(0, limit);
      const found: Record<string, number> = {};
      for (const m of hits) for (const [, k] of m.text.matchAll(/\[REDACTED: ([^\]]+)\]/g)) found[k] = (found[k] ?? 0) + 1;
      return ok(
        {
          window: { after: since.toISOString(), before: (r.to ?? new Date()).toISOString() },
          total: all.length,
          shown: hits.length,
          hasMore: all.length > hits.length,
          chatsScanned: rec.chatsScanned,
          ...(rec.chatsSkipped ? { chatsSkipped: rec.chatsSkipped, note: "Older-active chats were not scanned; narrow the window or pass chat_id." } : {}),
          ...(include_files ? { filesOpened } : {}),
          matches: hits.map((m) => ({ ...publicMsg(m), ...(m.matchedIn ? { matchedIn: m.matchedIn, snippet: m.snippet } : {}) })),
        },
        redactionNotice(found),
      );
    }),
  );

  server.registerTool(
    "read_attachments",
    {
      description: describe({
        when: "The user asks what a screenshot or file in a chat says, or files could hold tasks, decisions or numbers. Pass the `ref` values shown as [file: name ref=...].",
        returns: "Images as images; PDF, Word, text and CSV as extracted text (redacted). A file that can't be read becomes a one-line note.",
        limits: `Up to 10 refs per call; files up to ${MAX_FILE_BYTES / 1e6} MB.`,
      }),
      inputSchema: { refs: z.array(z.string()).min(1).max(10), reveal_sensitive: reveal },
      annotations: READ_ONLY,
    },
    run(async ({ refs, reveal_sensitive }, { authInfo }) => {
      const r = await readFiles(resolve(authInfo), refs, reveal_sensitive);
      const notice = redactionNotice(r.found);
      return { content: [...(notice ? [text(notice)] : []), ...r.parts] };
    }),
  );

  server.registerTool(
    "needs_attention",
    {
      description: describe({
        when: 'The user asks what needs their attention or reply ("what am I missing?", "who is waiting on me?", "where was I mentioned?").',
        returns:
          "mentions: messages that @mention you (or @all) after your last message in that chat; waitingOnYou: direct chats whose last message is from the other person, with that message. Newest first. Secrets are redacted.",
        limits: "Chats active in the last N hours (default 72, max 336). Who 'you' are is inferred from your direct chats; if it can't be, waitingOnYou is empty.",
      }),
      inputSchema: { hours: z.number().positive().max(336).default(72), per_chat: z.number().int().min(5).max(100).default(30) },
      annotations: READ_ONLY,
    },
    run(async ({ hours, per_chat }, { authInfo }) => {
      const user = resolve(authInfo);
      const since = new Date(Date.now() - hours * 3600_000);
      const [me, chats] = await Promise.all([whoAmI(user), listChats(user)]);
      const allActive = chats.filter((c) => c.lastActivity && new Date(c.lastActivity) >= since);
      const active = allActive.slice(0, MAX_SCAN_CHATS);
      const mine = (m: Message) => (me.id ? m.senderId === me.id : false);
      const per = await mapLimit(active, 4, async (c) => {
        const msgs = (await getMessages(user, c.id, { from: since, limit: per_chat }).catch(() => [] as Message[])).sort((a, b) => a.time.localeCompare(b.time));
        const lastMine = msgs.map(mine).lastIndexOf(true);
        const after = msgs.slice(lastMine + 1).map((m) => ({ ...m, chat: c.name }));
        const mentions = after.filter((m) => m.mentions?.some((x) => x === me.id || /^(all|participants|channel|here)$/i.test(x)));
        const last = msgs.at(-1);
        const isDm = /^(dm|direct)/i.test(c.type ?? "");
        const waiting = isDm && last && me.id && !mine(last) ? [{ ...last, chat: c.name }] : [];
        return { mentions, waiting };
      });
      const newest = (xs: Message[]) => redactAll(xs.sort((a, b) => b.time.localeCompare(a.time)), false);
      const m = newest(per.flatMap((p) => p.mentions));
      const w = newest(per.flatMap((p) => p.waiting));
      return ok(
        {
          window: { after: since.toISOString() },
          you: me.name ?? "(could not be inferred)",
          chatsChecked: active.length,
          ...(allActive.length > active.length ? { chatsSkipped: allActive.length - active.length } : {}),
          mentions: m.items.map(publicMsg),
          waitingOnYou: w.items.map((x) => ({ chat: x.chat, chatId: x.chatId, from: x.sender, time: x.time, lastMessage: x.text.slice(0, 300) })),
        },
        redactionNotice(merge({ ...m.found }, w.found)),
      );
    }),
  );

  server.registerTool(
    "connection_status",
    {
      description:
        "WHEN TO USE: Results look empty or wrong, a call failed with AUTH_FAILED, or the user asks whether Cliq is connected.\n" +
        "RETURNS: Whether the Zoho sign-in works, the Zoho data centre in use, and how many recent chats are visible.\n" +
        "LIMITS: Never returns tokens or message content.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async (_args, { authInfo }) => {
      let user: ZohoUser | undefined;
      try {
        user = resolve(authInfo);
        const chats = await listChats(user);
        const me = await whoAmI(user).catch(() => ({ name: undefined }));
        return ok({ connected: true, you: me.name, accountsServer: user.accountsServer, cliqApi: cliqBase(user), chatsVisible: chats.length, asOf: new Date().toISOString() });
      } catch (e) {
        return ok({
          connected: false,
          accountsServer: user?.accountsServer,
          ...toToolError(e).toClientPayload(),
          fix: "Disconnect and reconnect the Zoho Cliq connector in Claude's connector settings, then sign in again.",
        });
      }
    },
  );

  if (allowSend()) {
    server.registerTool(
      "send_message",
      {
        description: "Post a message to a Cliq chat as the signed-in user. Show the user the exact text and get their OK before sending.",
        inputSchema: { chat_id: z.string(), text: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      run(async ({ chat_id, text: t }, { authInfo }) => ok(await sendMessage(resolve(authInfo), chat_id, t))),
    );
  }

  registerPrompts(server);
  return server;
}

// Ready-made prompts (shown in Claude's prompt menu), as in the WhatsApp connector.
function registerPrompts(server: McpServer) {
  const GROUND_RULES = [
    "Ground rules:",
    `- ${UNTRUSTED_NOTICE}`,
    "- Times are UTC; convert to my timezone.",
    "- Never guess a file's content; open it with read_attachments.",
    "- Attribute statements to their sender; quote sparingly and cite the date of each key point.",
    "- Only include items explicitly in the messages.",
  ].join("\n");
  const user = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }] });

  server.registerPrompt(
    "summarize_chat",
    {
      title: "Summarize a Cliq chat",
      description: "Summarize one Cliq conversation, group or channel over a period.",
      argsSchema: { chat: z.string().describe("Person, group or channel name"), period: z.string().optional().describe('e.g. "last week"; default: last 30 days') },
    },
    ({ chat, period }) =>
      user(`Summarize my Zoho Cliq chat with "${chat}" for ${period ?? "the last 30 days"}. Use summarize_chat with name="${chat}" and from/to for that period.\n${GROUND_RULES}`),
  );

  server.registerPrompt(
    "find_commitments",
    {
      title: "Find commitments and follow-ups",
      description: "List promises, deadlines and unanswered questions in recent Cliq chats.",
      argsSchema: { period: z.string().optional().describe("default: last 7 days") },
    },
    ({ period }) =>
      user(
        [
          `Find commitments, deadlines and unanswered questions in my Zoho Cliq chats for ${period ?? "the last 7 days"}.`,
          "Steps: needs_attention for the window; recent_activity for the window; search_messages for words like tomorrow, deadline, \"will send\", EOD; open relevant files with read_attachments.",
          "Output a table: who, what, due date (if stated), chat, message date.",
          GROUND_RULES,
        ].join("\n"),
      ),
  );
}
