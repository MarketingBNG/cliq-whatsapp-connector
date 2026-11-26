import { extractText as pdfText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import type { Attachment } from "./cliq/client.js";
import { redact } from "./redact.js";

// Turns a downloaded attachment into MCP content Claude can read: images as images, documents as text.
// Document formats and zip/xlsx limits follow the WhatsApp connector (src/mcp/documents.ts there).

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's per-image limit
const MAX_TEXT_CHARS = 60_000;
const MAX_SHEET_ROWS = 2_000;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type Kind = "image" | "pdf" | "docx" | "xlsx" | "zip" | "text" | "audio" | "video" | "other";

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const TEXT_EXT = ["txt", "csv", "md", "json", "log", "tsv", "xml", "html"];

export function kindOf(name: string, contentType = ""): Kind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const ct = contentType.toLowerCase();
  if (ct.startsWith("image/") || ext in IMAGE_TYPES) return "image";
  if (ct === "application/pdf" || ext === "pdf") return "pdf";
  if (ext === "docx" || ct.includes("wordprocessingml")) return "docx";
  if (ext === "xlsx" || ct.includes("spreadsheetml")) return "xlsx";
  // After docx/xlsx: those are zip files too.
  if (ext === "zip" || /^application\/(x-)?zip(-compressed)?$/.test(ct)) return "zip";
  if (ct.startsWith("audio/") || ["mp3", "m4a", "ogg", "opus", "wav", "aac"].includes(ext)) return "audio";
  if (ct.startsWith("video/") || ["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (ct.startsWith("text/") || ct === "application/json" || TEXT_EXT.includes(ext)) return "text";
  return "other";
}

const clip = (s: string) =>
  s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) + `\n[... truncated, ${s.length - MAX_TEXT_CHARS} more characters]` : s;

// Plain text of a document, or null when the kind isn't a readable document. Throws on damaged files.
export async function documentText(data: Buffer, kind: Kind): Promise<string | null> {
  switch (kind) {
    case "text":
      return data.toString("utf8");
    case "pdf": {
      const out = await pdfText(await getDocumentProxy(new Uint8Array(data)), { mergePages: true });
      return String(out.text).trim() || "[This PDF has no text layer (probably a scan). Ask the user to share it as an image if needed.]";
    }
    case "docx":
      await assertOfficeSize(data);
      return (await mammoth.extractRawText({ buffer: data })).value.trim();
    case "xlsx":
      return xlsxText(data);
    case "zip":
      return zipText(data);
    default:
      return null;
  }
}

async function xlsxText(data: Buffer): Promise<string> {
  await assertOfficeSize(data);
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((sheet) => {
    out.push(`# Sheet: ${sheet.name}`);
    let rows = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (++rows > MAX_SHEET_ROWS) return;
      out.push((row.values as unknown[]).slice(1).map(cellText).join("\t"));
    });
    if (rows > MAX_SHEET_ROWS) out.push(`... ${rows - MAX_SHEET_ROWS} more rows not shown`);
  });
  return out.join("\n");
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return cellText(o.result);
    return "";
  }
  return String(v).replace(/[\t\n]/g, " ");
}

// Word/Excel files are zips: refuse ones whose directory says they unpack to more than this (zip bombs).
const OFFICE_MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
async function assertOfficeSize(data: Buffer): Promise<void> {
  const { unzipSync } = await import("fflate");
  let total = 0;
  try {
    unzipSync(new Uint8Array(data), { filter: (f) => ((total += f.originalSize), false) });
  } catch {
    throw new Error("unreadable file");
  }
  if (total > OFFICE_MAX_UNPACKED_BYTES) throw new Error("too large when unpacked");
}

// Zip limits: sizes are checked from the directory before anything is unpacked; one level only.
const ZIP_MAX_ENTRIES = 500;
const ZIP_MAX_FILES_READ = 50;
const ZIP_MAX_ENTRY_BYTES = 15 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 60 * 1024 * 1024;

async function zipText(data: Buffer): Promise<string> {
  const { unzipSync } = await import("fflate");
  const names: string[] = [];
  const wanted: { name: string; kind: Kind }[] = [];
  let total = 0;
  const pick = (f: { name: string; originalSize: number }) => {
    if (names.length >= ZIP_MAX_ENTRIES || f.name.endsWith("/")) return false;
    names.push(f.name);
    const kind = kindOf(f.name);
    if (!["pdf", "docx", "xlsx", "text"].includes(kind) || wanted.length >= ZIP_MAX_FILES_READ) return false;
    if (f.originalSize > ZIP_MAX_ENTRY_BYTES || total + f.originalSize > ZIP_MAX_TOTAL_BYTES) return false;
    total += f.originalSize;
    wanted.push({ name: f.name, kind });
    return true;
  };
  const out: string[] = [];
  let files: Record<string, Uint8Array> = {};
  try {
    files = unzipSync(new Uint8Array(data), { filter: pick });
  } catch {
    out.push("(the files in this zip could not be unpacked: damaged or password-protected)");
  }
  for (const w of wanted) {
    const body = files[w.name];
    if (!body) continue;
    try {
      out.push(`# File: ${w.name}`, ((await documentText(Buffer.from(body), w.kind)) ?? "").trim(), "");
    } catch {
      out.push(`# File: ${w.name}`, "(unreadable)", "");
    }
  }
  const read = new Set(wanted.filter((w) => files[w.name]).map((w) => w.name));
  const others = names.filter((n) => !read.has(n));
  if (others.length) out.push(`# Other files in the zip (not read): ${others.join(", ")}${names.length >= ZIP_MAX_ENTRIES ? ", ..." : ""}`);
  return out.join("\n").trim();
}

export async function toContent(
  f: Attachment,
  file: { data: Buffer; contentType: string },
  reveal: boolean,
): Promise<{ content: Content[]; found: Record<string, number> }> {
  const head = `--- ${f.name}`;
  const kind = kindOf(f.name, file.contentType);
  const note = (t: string) => ({ content: [{ type: "text" as const, text: `${head}: ${t}` }], found: {} });

  if (kind === "image") {
    if (file.data.length > MAX_IMAGE_BYTES) return note(`image too large to show (${(file.data.length / 1e6).toFixed(1)} MB)`);
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = file.contentType.startsWith("image/") ? file.contentType : IMAGE_TYPES[ext] ?? "image/png";
    return {
      content: [
        { type: "text", text: `${head} (image). Images can't be auto-redacted: if it shows passwords, keys or IDs, do not repeat them; tell the user to rotate them.` },
        { type: "image", data: file.data.toString("base64"), mimeType },
      ],
      found: {},
    };
  }
  if (kind === "audio") return note("voice note / audio. It can't be transcribed here; ask the user what it says or to share a transcript.");
  if (kind === "video") return note("video. It can't be played here; describe it from its name and size only.");

  const text = await documentText(file.data, kind);
  if (text === null) return note(`file type not supported for reading (${file.contentType || "unknown"}).`);
  const r = reveal ? { text, found: {} } : redact(text);
  return { content: [{ type: "text", text: `${head} (${kind})\n${clip(r.text)}` }], found: r.found };
}
