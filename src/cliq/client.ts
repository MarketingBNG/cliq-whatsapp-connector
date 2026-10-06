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
  attachments?: string[];
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

const iso = (t: unknown) => (t ? new Date(Number(t)).toISOString() : undefined);

export async function listChats(user: ZohoUser, limit = 100): Promise<Chat[]> {
  const body = await call(user, `/chats?limit=${limit}`);
  return (body.chats ?? body.data ?? []).map((c: any) => ({
    id: c.chat_id ?? c.id,
    name: c.name ?? c.title,
    type: c.chat_type ?? c.type,
    lastActivity: iso(c.last_modified_time ?? c.last_message_time),
  }));
}

export async function listChannels(user: ZohoUser, limit = 100): Promise<any[]> {
  const body = await call(user, `/channels?limit=${limit}`);
  return (body.channels ?? body.data ?? []).map((c: any) => ({
    id: c.channel_id ?? c.id,
    chatId: c.chat_id,
    name: c.name,
    description: c.description,
    members: c.participant_count,
  }));
}

export async function getMessages(user: ZohoUser, chatId: string, opts: { from?: Date; to?: Date; limit?: number } = {}): Promise<Message[]> {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.from) q.set("fromtime", String(opts.from.getTime()));
  if (opts.to) q.set("totime", String(opts.to.getTime()));
  const body = await call(user, `/chats/${encodeURIComponent(chatId)}/messages?${q}`);
  return (body.data ?? body.messages ?? []).map((m: any) => ({
    id: String(m.id),
    chatId,
    sender: m.sender?.name ?? m.sender?.id ?? "unknown",
    time: iso(m.time) ?? "",
    text: m.content?.text ?? m.content?.comment ?? (typeof m.content === "string" ? m.content : ""),
    attachments: m.content?.file ? [m.content.file.name] : undefined,
  }));
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
