import { createHash } from "node:crypto";
import { env } from "../config.js";

// A signed-in Zoho user: their refresh token plus the accounts server of their data centre
// (e.g. https://accounts.zoho.in), which Zoho reports at login time.
export interface ZohoUser {
  refreshToken: string;
  accountsServer: string;
}

const cache = new Map<string, { token: string; expires: number }>();
const keyOf = (u: ZohoUser) => createHash("sha256").update(u.refreshToken).digest("hex");

export async function getAccessToken(user: ZohoUser, force = false): Promise<string> {
  const k = keyOf(user);
  const hit = cache.get(k);
  if (!force && hit && Date.now() < hit.expires) return hit.token;
  const params = new URLSearchParams({
    refresh_token: user.refreshToken,
    client_id: env("ZOHO_CLIENT_ID"),
    client_secret: env("ZOHO_CLIENT_SECRET"),
    grant_type: "refresh_token",
  });
  const res = await fetch(`${user.accountsServer}/oauth/v2/token`, { method: "POST", body: params });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!body.access_token) throw new Error(`Zoho token refresh failed: ${body.error ?? res.status}`);
  // Refresh a minute early so a token never expires mid-request.
  cache.set(k, { token: body.access_token, expires: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 });
  return body.access_token;
}

// accounts.zoho.in -> cliq.zoho.in
export const cliqBase = (u: ZohoUser) => u.accountsServer.replace("://accounts.", "://cliq.") + "/api/v2";

export const accountsUrl = () => `https://accounts.zoho.${env("ZOHO_DC", "com")}`;
