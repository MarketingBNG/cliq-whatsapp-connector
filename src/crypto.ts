import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "./config.js";

// Everything we hand out (client ids, auth codes, access/refresh tokens) is an AES-256-GCM sealed
// JSON blob, so the server stays stateless: no database, and tokens can't be read or forged without SECRET_KEY.
const key = () => createHash("sha256").update(env("SECRET_KEY")).digest();

export function seal(data: object): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

export function unseal<T>(token: string): T | undefined {
  try {
    const buf = Buffer.from(token, "base64url");
    const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")) as T;
  } catch {
    return undefined;
  }
}
