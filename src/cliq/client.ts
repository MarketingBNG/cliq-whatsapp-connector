import { getAccessToken, cliqBase, type ZohoUser } from "../zoho/auth.js";

export interface Chat {
  id: string;
  name: string;
  type: string;
  lastActivity?: string;
}

export interface Message {
  id: string;
  chatId: string;
  chat?: string;
  sender: string;
  senderId?: string;
  time: string;
  text: string;
  attachments?: Attachment[];
  // Set when the message answers another one (Cliq "reply"/quote). preview is filled when that message is known.
  replyTo?: { id?: string; sender?: string; preview?: string };
  // User ids mentioned in the text ({@id} in Cliq's markup).
  mentions?: string[];
  edited?: boolean;
}

export interface Attachment {
  id?: string;
  name: string;
  type?: string;
  size?: number;
  url?: string;
  // Short handle Claude passes to read_attachments: chatId~messageId~timeMs~index.
  ref?: string;
}

// Cliq puts uploaded files under content.file (sometimes content.files / attachments); read them all.
function attachmentsOf(m: any): Attachment[] | undefined {
  const raw = [m.content?.file, ...(m.content?.files ?? []), ...(m.attachments ?? []), m.file].filter(Boolean);
  const list = raw.map((f: any) => ({
    id: f.id ?? f.file_id,
    name: f.name ?? f.file_name ?? "file",
    type: f.type ?? f.content_type ?? f.mime_type,
    size: f.size ?? f.file_size,
    url: f.url ?? f.download_url,
  }));
  return list.length ? list : undefined;
}

// All calls run as one signed-in Zoho user, so each person only ever sees their own chats.
async function call(user: ZohoUser, path: string, init: RequestInit = {}, attempt = 0): Promise<any> {
  const token = await getAccessToken(user, attempt > 0);
  const res = await fetch(cliqBase(user) + path, {
    ...init,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  if ((res.status === 401 || res.status === 429 || res.status >= 500) && attempt < 3) {
    if (res.status !== 401) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return call(user, path, init, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Cliq ${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Cliq sends times as epoch millis (number or numeric string) or as date strings; never throw on odd values.
const iso = (t: unknown): string | undefined => {
  if (t === null || t === undefined || t === "") return undefined;
  const d = typeof t === "number" || /^\d+$/.test(String(t)) ? new Date(Number(t)) : new Date(String(t));
  return isNaN(d.getTime()) ? undefined : d.toISOString();
};

// Cliq caps page size at 100.
const MAX_PAGE = 100;

const toChat = (c: any): Chat => ({
  id: c.chat_id ?? c.id,
  name: c.name ?? c.title,
  type: c.chat_type ?? c.type,
  lastActivity: iso(c.last_modified_time ?? c.last_message_info?.time ?? c.last_message_time),
});

// The chat list changes slowly but many tools need it, so keep it for a minute per user (fewer Cliq calls).
const CHAT_CACHE_MS = 60_000;
const chatCache = new Map<string, { at: number; max: number; chats: Chat[] }>();
export const clearChatCache = () => chatCache.clear();

// Chats newest first. Cliq returns at most 100 per call, so this pages back (next_token when Cliq gives one,
// otherwise modified_before the oldest chat seen) until `max` chats or no more.
export async function listChats(user: ZohoUser, max = 1000): Promise<Chat[]> {
  const key = user.refreshToken;
  const hit = chatCache.get(key);
  if (hit && Date.now() - hit.at < CHAT_CACHE_MS && (hit.max >= max || hit.chats.length < hit.max)) return hit.chats.slice(0, max);

  const seen = new Map<string, Chat>();
  let next: string | undefined;
  let before: number | undefined;
  for (let page = 0; page < 50 && seen.size < max; page++) {
    const q = new URLSearchParams({ limit: String(MAX_PAGE) });
    if (next) q.set("next_token", next);
    else if (before) q.set("modified_before", String(before));
    let body: any;
    try {
      body = await call(user, `/chats?${q}`);
    } catch (e) {
      // The first page must work; a later page failing (e.g. Cliq rejects the paging parameter) keeps what we have.
      if (page === 0) throw e;
      break;
    }
    const raw: any[] = body.chats ?? body.data ?? [];
    const fresh = raw.map(toChat).filter((c) => c.id && !seen.has(c.id));
    fresh.forEach((c) => seen.set(c.id, c));
    next = body.next_token ?? undefined;
    const oldest = fresh.map((c) => Date.parse(c.lastActivity ?? "")).filter((t) => !isNaN(t)).sort((a, b) => a - b)[0];
    // Stop on a short page, no new chats (the paging param was ignored) or nothing to page by.
    if (raw.length < MAX_PAGE || fresh.length === 0 || (!next && oldest === undefined)) break;
    before = oldest - 1;
  }
  const chats = [...seen.values()].sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  chatCache.set(key, { at: Date.now(), max, chats });
  return chats.slice(0, max);
}

export async function listChannels(user: ZohoUser, limit = 100): Promise<any[]> {
  const body = await call(user, `/channels?limit=${Math.min(limit, MAX_PAGE)}`);
  return (body.channels ?? body.data ?? []).map((c: any) => ({
    id: c.channel_id ?? c.id,
    chatId: c.chat_id,
    name: c.name,
    description: c.description,
    members: c.participant_count,
  }));
}

export async function getMessages(user: ZohoUser, chatId: string, opts: { from?: Date; to?: Date; limit?: number } = {}): Promise<Message[]> {
  const q = new URLSearchParams({ limit: String(Math.min(opts.limit ?? 50, MAX_PAGE)) });
  if (opts.from) q.set("fromtime", String(opts.from.getTime()));
  if (opts.to) q.set("totime", String(opts.to.getTime()));
  const body = await call(user, `/chats/${encodeURIComponent(chatId)}/messages?${q}`);
  return withReplyPreviews((body.data ?? body.messages ?? []).map((m: any) => toMessage(m, chatId)));
}

// Cliq marks mentions in text as {@<user id>}; channels/groups use {@all}, {@participants} etc.
const mentionsOf = (text: string) => [...text.matchAll(/\{@([^}\s]+)\}/g)].map((x) => x[1]);

// Reply/quote info appears under different keys depending on message type; read whichever is there.
function replyOf(m: any): Message["replyTo"] {
  const r = m.reply_to ?? m.replied_message ?? m.quoted_message ?? m.content?.reply_to ?? m.content?.quote ?? m.meta?.reply_to;
  const id = typeof r === "object" && r ? r.id ?? r.message_id ?? r.msgid : r ?? m.reply_message_id ?? m.parent_message_id;
  if (!id && !(r && typeof r === "object")) return undefined;
  const text = typeof r === "object" && r ? r.content?.text ?? r.text ?? r.message : undefined;
  return { id: id ? String(id) : undefined, sender: typeof r === "object" && r ? r.sender?.name : undefined, preview: text ? String(text).slice(0, 120) : undefined };
}

export function toMessage(m: any, chatId: string): Message {
  const time = iso(m.time) ?? "";
  const text: string = m.content?.text ?? m.content?.comment ?? (typeof m.content === "string" ? m.content : "") ?? "";
  const mentions = mentionsOf(text);
  return {
    id: String(m.id),
    chatId,
    sender: m.sender?.name ?? m.sender?.id ?? "unknown",
    senderId: m.sender?.id ? String(m.sender.id) : undefined,
    time,
    text,
    attachments: attachmentsOf(m)?.map((a, i) => ({ ...a, ref: [chatId, m.id, Date.parse(time) || 0, i].join("~") })),
    replyTo: replyOf(m),
    mentions: mentions.length ? mentions : undefined,
    edited: m.is_edited || m.edited || m.revision > 0 ? true : undefined,
  };
}

// Fill reply previews from messages in the same page when Cliq only gave the replied-to id.
export function withReplyPreviews(msgs: Message[]): Message[] {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  for (const m of msgs) {
    if (!m.replyTo?.id || m.replyTo.preview) continue;
    const o = byId.get(m.replyTo.id);
    if (o) m.replyTo = { ...m.replyTo, sender: o.sender, preview: o.text.slice(0, 120) };
  }
  return msgs;
}

// Re-fetch the message a ref points at (refs carry its time, so one small page finds it) and return the file.
export async function findAttachment(user: ZohoUser, ref: string): Promise<Attachment> {
  const [chatId, msgId, t, idx] = ref.split("~");
  if (!chatId || !msgId) throw new Error(`Bad attachment ref: ${ref}`);
  const page = await getMessages(user, chatId, { to: t && Number(t) ? new Date(Number(t) + 1000) : undefined, limit: 50 });
  const a = page.find((m) => m.id === msgId)?.attachments?.[Number(idx) || 0];
  if (!a) throw new Error(`Attachment not found for ref ${ref}`);
  return a;
}

// Full history of one chat: pages backwards from `to` in 100-message steps until it reaches `from`,
// runs out of messages, or hits `max`. Returned oldest first. `before` lets the caller continue.
export async function getHistory(
  user: ZohoUser,
  chatId: string,
  opts: { from?: Date; to?: Date; max: number },
): Promise<{ messages: Message[]; truncated: boolean; before?: string }> {
  const seen = new Map<string, Message>();
  let to = opts.to;
  while (seen.size < opts.max) {
    const page = await getMessages(user, chatId, { from: opts.from, to, limit: MAX_PAGE });
    const fresh = page.filter((m) => !seen.has(m.id));
    fresh.forEach((m) => seen.set(m.id, m));
    const oldest = fresh.map((m) => Date.parse(m.time)).filter((t) => !isNaN(t)).sort((a, b) => a - b)[0];
    // Stop when Cliq has nothing older for us (short page, no new ids, or no usable timestamps).
    if (page.length < MAX_PAGE || fresh.length === 0 || oldest === undefined) {
      return { messages: withReplyPreviews(sortAsc([...seen.values()])), truncated: false };
    }
    if (opts.from && oldest <= opts.from.getTime()) break;
    to = new Date(oldest - 1);
  }
  const messages = withReplyPreviews(sortAsc([...seen.values()]).slice(-opts.max));
  const truncated = !opts.from || Date.parse(messages[0]?.time) > opts.from.getTime();
  return { messages, truncated, before: truncated ? messages[0]?.time : undefined };
}

const sortAsc = (ms: Message[]) => ms.sort((a, b) => a.time.localeCompare(b.time));

// Download an attachment's bytes as the signed-in user. Uses the file's own URL when Cliq gives one,
// otherwise the files endpoint.
export async function downloadFile(user: ZohoUser, f: Attachment, maxBytes: number): Promise<{ data: Buffer; contentType: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(user, attempt > 0);
    const url = f.url ?? `${cliqBase(user)}/files/${encodeURIComponent(f.id ?? "")}`;
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) throw new Error(`Download of ${f.name} failed: ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > maxBytes) throw new Error(`${f.name} is ${(len / 1e6).toFixed(1)} MB; the limit is ${maxBytes / 1e6} MB`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > maxBytes) throw new Error(`${f.name} is too large (${(data.length / 1e6).toFixed(1)} MB)`);
    return { data, contentType: (res.headers.get("content-type") ?? f.type ?? "").split(";")[0] };
  }
  throw new Error(`Download of ${f.name} failed`);
}

export async function sendMessage(user: ZohoUser, chatId: string, text: string) {
  return call(user, `/chats/${encodeURIComponent(chatId)}/message`, { method: "POST", body: JSON.stringify({ text }) });
}

// The signed-in user's Cliq id. Inferred from direct chats: in a DM named after the other person, the
// sender who isn't that person is you. Cached per user.
const selfCache = new Map<string, { id?: string; name?: string }>();
export async function whoAmI(user: ZohoUser): Promise<{ id?: string; name?: string }> {
  const key = user.refreshToken;
  const hit = selfCache.get(key);
  if (hit?.id) return hit;
  const dms = (await listChats(user, 200)).filter((c) => /^(dm|direct)/i.test(c.type ?? "")).slice(0, 5);
  const votes = new Map<string, { n: number; name: string }>();
  await mapLimit(dms, 3, async (c) => {
    const msgs = await getMessages(user, c.id, { limit: 30 }).catch(() => [] as Message[]);
    for (const m of msgs) {
      if (!m.senderId || m.sender === c.name) continue;
      const v = votes.get(m.senderId) ?? { n: 0, name: m.sender };
      v.n++;
      votes.set(m.senderId, v);
    }
  });
  const best = [...votes.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  const me = best ? { id: best[0], name: best[1].name } : {};
  selfCache.set(key, me);
  return me;
}

// Run fn over items with at most `n` requests in flight, to stay under Cliq rate limits.
export async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}
