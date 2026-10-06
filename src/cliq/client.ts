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
  time: string;
  text: string;
  attachments?: Attachment[];
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

export async function listChats(user: ZohoUser, limit = 100): Promise<Chat[]> {
  const body = await call(user, `/chats?limit=${Math.min(limit, MAX_PAGE)}`);
  return (body.chats ?? body.data ?? []).map((c: any) => ({
    id: c.chat_id ?? c.id,
    name: c.name ?? c.title,
    type: c.chat_type ?? c.type,
    lastActivity: iso(c.last_modified_time ?? c.last_message_info?.time ?? c.last_message_time),
  }));
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
  return (body.data ?? body.messages ?? []).map((m: any) => {
    const time = iso(m.time) ?? "";
    return {
      id: String(m.id),
      chatId,
      sender: m.sender?.name ?? m.sender?.id ?? "unknown",
      time,
      text: m.content?.text ?? m.content?.comment ?? (typeof m.content === "string" ? m.content : ""),
      attachments: attachmentsOf(m)?.map((a, i) => ({ ...a, ref: [chatId, m.id, Date.parse(time) || 0, i].join("~") })),
    };
  });
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
      return { messages: sortAsc([...seen.values()]), truncated: false };
    }
    if (opts.from && oldest <= opts.from.getTime()) break;
    to = new Date(oldest - 1);
  }
  const messages = sortAsc([...seen.values()]).slice(-opts.max);
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
