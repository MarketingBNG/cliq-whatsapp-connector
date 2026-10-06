import { config as load } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load .env from the project root even when Claude launches us from another cwd (we run from dist/src).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
load({ path: path.join(root, ".env"), quiet: true } as any);

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

// Render sets RENDER_EXTERNAL_URL automatically, so BASE_URL is optional there.
export const baseUrl = () => process.env.BASE_URL || env("RENDER_EXTERNAL_URL");
export const allowSend = () => process.env.CLIQ_ALLOW_SEND === "true";
