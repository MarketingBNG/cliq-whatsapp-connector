import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import ExcelJS from "exceljs";
import { zipSync, strToU8 } from "fflate";
import { matcher, buildServer } from "../src/tools.js";
import { redact, redactAll } from "../src/redact.js";
import { toToolError, ToolError } from "../src/errors.js";
import { toMessage, withReplyPreviews, listChats, clearChatCache } from "../src/cliq/client.js";
import { documentText, kindOf } from "../src/files.js";

process.env.ZOHO_CLIENT_ID = "test-id";
process.env.ZOHO_CLIENT_SECRET = "test-secret";
const user = { refreshToken: "rt", accountsServer: "https://accounts.zoho.in" };

// Fake Cliq: token endpoint plus a handler for API paths.
function fakeFetch(api: (url: URL) => unknown) {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oauth/v2/token")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
    return new Response(JSON.stringify(api(url)));
  });
}

describe("search matcher", () => {
  it("needs every word, matches word starts, case-insensitive", () => {
    const m = matcher("invoice march");
    expect(m("Sent the INVOICES for March")).toBe(true);
    expect(m("invoice for april")).toBe(false);
    expect(m("reinvoice march")).toBe(false);
  });
  it("checks quoted phrases word-for-word", () => {
    const m = matcher('"by monday" report');
    expect(m("Report due by Monday")).toBe(true);
    expect(m("report by next monday")).toBe(false);
  });
  it("treats regex characters literally", () => {
    expect(matcher("c++ (draft)")("notes on c++ (draft) v2")).toBe(true);
  });
});

describe("redaction", () => {
  it("hides credentials and IDs", () => {
    const r = redact("password: hunter2 and PAN ABCDE1234F");
    expect(r.text).not.toContain("hunter2");
    expect(r.text).not.toContain("ABCDE1234F");
    expect(r.found.PAN).toBe(1);
  });
  it("leaves text alone when revealing", () => {
    expect(redactAll([{ text: "otp is 482913" }], true).items[0].text).toContain("482913");
  });
});

describe("error codes", () => {
  it("maps API failures to codes without leaking the body", () => {
    expect(toToolError(new Error("Zoho token refresh failed: invalid_client")).code).toBe("AUTH_FAILED");
    expect(toToolError(new Error("Cliq GET /chats -> 429: slow down")).code).toBe("RATE_LIMITED");
    expect(toToolError(new Error("Cliq GET /chats/x -> 404: nope")).code).toBe("CHAT_NOT_FOUND");
    const p = toToolError(new Error("Cliq GET -> 500: secret stack")).toClientPayload();
    expect(JSON.stringify(p)).not.toContain("secret stack");
  });
  it("keeps ToolErrors as they are", () => {
    expect(toToolError(new ToolError("INVALID_INPUT", "x")).code).toBe("INVALID_INPUT");
  });
});

describe("message parsing", () => {
  it("reads mentions, sender id, edits and reply ids", () => {
    const m = toMessage({ id: 2, time: 1700000000000, sender: { id: "u1", name: "Asha" }, content: { text: "hi {@u9} and {@all}" }, reply_to: { id: "1" }, is_edited: true }, "c1");
    expect(m.mentions).toEqual(["u9", "all"]);
    expect(m.senderId).toBe("u1");
    expect(m.edited).toBe(true);
    expect(m.replyTo?.id).toBe("1");
    expect(m.time).toBe(new Date(1700000000000).toISOString());
  });
  it("fills reply previews from the same page", () => {
    const a = toMessage({ id: 1, time: 1, sender: { name: "Ravi" }, content: { text: "Can you send the deck?" } }, "c");
    const b = toMessage({ id: 2, time: 2, sender: { name: "Asha" }, content: { text: "Sure" }, reply_to: "1" }, "c");
    const [, out] = withReplyPreviews([a, b]);
    expect(out.replyTo).toMatchObject({ id: "1", sender: "Ravi", preview: "Can you send the deck?" });
  });
  it("gives attachments a ref", () => {
    const m = toMessage({ id: 5, time: 1000, sender: { name: "A" }, content: { file: { name: "a.pdf", id: "f1" } } }, "c9");
    expect(m.attachments?.[0].ref).toBe("c9~5~1000~0");
  });
});

describe("listChats paging", () => {
  beforeEach(() => clearChatCache());
  afterEach(() => vi.unstubAllGlobals());

  it("pages past 100 chats and stops when Cliq runs out", async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({ chat_id: `c${i}`, name: `Chat ${i}`, chat_type: "dm", last_modified_time: 10_000_000 - i * 1000 }));
    const f = fakeFetch((url) => {
      const before = Number(url.searchParams.get("modified_before") ?? Infinity);
      return { chats: all.filter((c) => c.last_modified_time <= before).slice(0, 100) };
    });
    vi.stubGlobal("fetch", f);
    const chats = await listChats(user);
    expect(chats).toHaveLength(230);
    expect(new Set(chats.map((c) => c.id)).size).toBe(230);
    // Second call within a minute is served from cache.
    const calls = f.mock.calls.length;
    await listChats(user);
    expect(f.mock.calls.length).toBe(calls);
  });

  it("keeps the first page if Cliq rejects the paging parameter", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ chat_id: `c${i}`, name: `C${i}`, last_modified_time: 5_000_000 - i }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/oauth/v2/token")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
        if (url.searchParams.has("modified_before")) return new Response('{"code":"invalid_param"}', { status: 400 });
        return new Response(JSON.stringify({ chats: page }));
      }),
    );
    expect(await listChats(user)).toHaveLength(100);
  });

  it("stops if Cliq ignores the paging parameter", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ chat_id: `c${i}`, name: `C${i}`, last_modified_time: 5_000_000 - i }));
    vi.stubGlobal("fetch", fakeFetch(() => ({ chats: page })));
    expect(await listChats(user)).toHaveLength(100);
  });
});

describe("documents", () => {
  it("knows file kinds", () => {
    expect(kindOf("a.xlsx")).toBe("xlsx");
    expect(kindOf("a.zip")).toBe("zip");
    expect(kindOf("note.m4a")).toBe("audio");
    expect(kindOf("x", "application/pdf")).toBe("pdf");
  });
  it("reads Excel sheets", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Budget").addRows([["Item", "Cost"], ["Laptop", 1200]]);
    const text = await documentText(Buffer.from(await wb.xlsx.writeBuffer()), "xlsx");
    expect(text).toContain("# Sheet: Budget");
    expect(text).toContain("Laptop\t1200");
  });
  it("reads text files inside zips and lists the rest", async () => {
    const zip = zipSync({ "notes.txt": strToU8("pay vendor by Friday"), "photo.png": new Uint8Array([1, 2, 3]) });
    const text = await documentText(Buffer.from(zip), "zip");
    expect(text).toContain("# File: notes.txt");
    expect(text).toContain("pay vendor by Friday");
    expect(text).toContain("not read): photo.png");
  });
});

describe("tools", () => {
  const server = buildServer(() => user) as any;
  const call = (name: string, args: object) => server._registeredTools[name].handler(args, {});

  it("registers the full read-only tool set", () => {
    const names = Object.keys(server._registeredTools);
    expect(names).toEqual(expect.arrayContaining(["summarize_chat", "search_messages", "needs_attention", "connection_status", "read_attachments", "get_messages"]));
    expect(names).not.toContain("send_message");
    for (const n of names) expect(server._registeredTools[n].annotations?.readOnlyHint).toBe(true);
  });
  it("rejects reversed date ranges with a coded error", async () => {
    const r = await call("get_messages", { chat_id: "c", from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z", limit: 5 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("INVALID_DATE_RANGE");
  });
  it("search needs a query or a sender", async () => {
    const r = await call("search_messages", { limit: 5 });
    expect(r.content[0].text).toContain("INVALID_INPUT");
  });
});
