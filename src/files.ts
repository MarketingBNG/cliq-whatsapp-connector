import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import type { Attachment } from "./cliq/client.js";
import { redact } from "./redact.js";

// Turns a downloaded attachment into MCP content Claude can read: images as images, documents as text.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's per-image limit
const MAX_TEXT_CHARS = 60_000;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function kindOf(f: Attachment, contentType: string): string {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (contentType.startsWith("image/") || ext in IMAGE_TYPES) return "image";
  if (contentType === "application/pdf" || ext === "pdf") return "pdf";
  if (ext === "docx" || contentType.includes("wordprocessingml")) return "docx";
  if (contentType.startsWith("text/") || ["txt", "csv", "md", "json", "log", "tsv", "xml", "html"].includes(ext)) return "text";
  return "other";
}

const clip = (s: string) =>
  s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) + `\n[... truncated, ${s.length - MAX_TEXT_CHARS} more characters]` : s;

export async function toContent(
  f: Attachment,
  file: { data: Buffer; contentType: string },
  reveal: boolean,
): Promise<{ content: Content[]; found: Record<string, number> }> {
  const head = `--- ${f.name}`;
  const kind = kindOf(f, file.contentType);

  if (kind === "image") {
    if (file.data.length > MAX_IMAGE_BYTES) return { content: [{ type: "text", text: `${head}: image too large to show (${(file.data.length / 1e6).toFixed(1)} MB)` }], found: {} };
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

  let text: string;
  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(file.data));
    const out = await extractText(pdf, { mergePages: true });
    text = String(out.text).trim();
    if (!text) text = "[This PDF has no text layer (probably a scan). Ask the user to share it as an image if needed.]";
  } else if (kind === "docx") {
    text = (await mammoth.extractRawText({ buffer: file.data })).value.trim();
  } else if (kind === "text") {
    text = file.data.toString("utf8");
  } else {
    return { content: [{ type: "text", text: `${head}: file type not supported for reading (${file.contentType || "unknown"}).` }], found: {} };
  }

  const r = reveal ? { text, found: {} } : redact(text);
  return { content: [{ type: "text", text: `${head} (${kind})\n${clip(r.text)}` }], found: r.found };
}
