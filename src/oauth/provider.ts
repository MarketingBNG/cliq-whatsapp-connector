import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { env, allowSend, baseUrl } from "../config.js";
import { seal, unseal } from "../crypto.js";
import { accountsUrl, type ZohoUser } from "../zoho/auth.js";

// Claude (or any MCP client) talks OAuth to *this* server; we bounce the user to Zoho to sign in.
// Zoho has no dynamic client registration, so we act as the authorization server ourselves and wrap
// each user's Zoho refresh token inside our own sealed tokens, so no database is needed.
// The short-lived steps that travel in browser URLs (Zoho `state`, our auth code) are short random ids
// held in memory for a few minutes, like a normal OAuth server. Long opaque blobs in post-login URLs
// trip Chrome's phishing heuristics.

const ACCESS_TTL = 3600;
const CODE_TTL = 300;

const zohoScopes = () =>
  ["ZohoCliq.Chats.READ", "ZohoCliq.Messages.READ", "ZohoCliq.Channels.READ", "ZohoCliq.Users.READ"]
    .concat(allowSend() ? ["ZohoCliq.Webhooks.CREATE"] : [])
    .join(",");

export const zohoCallbackPath = "/callback";
export const legacyCallbackPath = "/oauth/zoho/callback";
const callbackUrl = () => baseUrl().replace(/\/$/, "") + zohoCallbackPath;
const now = () => Math.floor(Date.now() / 1000);

interface Pending { cid: string; ru: string; cc: string; st?: string; exp: number }
interface Code { cid: string; ru: string; cc: string; rt: string; as: string; exp: number }
interface Token { t: "access" | "refresh"; cid: string; rt: string; as: string; exp?: number }

// In-flight sign-ins and unredeemed codes. Lost on restart, which only means retrying that one sign-in.
const pendingLogins = new Map<string, Pending>();
const authCodes = new Map<string, Code>();
const newId = () => randomBytes(18).toString("base64url");
function sweep() {
  const t = now();
  for (const m of [pendingLogins, authCodes] as Map<string, { exp: number }>[]) for (const [k, v] of m) if (v.exp < t) m.delete(k);
}

const clientsStore: OAuthRegisteredClientsStore = {
  // The client id *is* the sealed registration, so no client table is needed.
  // Only the fields we need are sealed, to keep the id (which appears in /authorize URLs) short.
  getClient: (id) => {
    const c = unseal<{ r: string[]; m?: string; s?: string; i: number }>(id.replace(/^c_/, ""));
    return c && { client_id: id, redirect_uris: c.r, token_endpoint_auth_method: c.m, client_secret: c.s, client_id_issued_at: c.i };
  },
  registerClient: (client) => {
    const issued = { ...client, client_id_issued_at: now() } as OAuthClientInformationFull;
    issued.client_id = "c_" + seal({ r: client.redirect_uris, m: client.token_endpoint_auth_method, s: client.client_secret, i: issued.client_id_issued_at });
    return issued;
  },
};

function issueTokens(cid: string, rt: string, as: string): OAuthTokens {
  return {
    access_token: seal({ t: "access", cid, rt, as, exp: now() + ACCESS_TTL } satisfies Token),
    refresh_token: seal({ t: "refresh", cid, rt, as } satisfies Token),
    token_type: "bearer",
    expires_in: ACCESS_TTL,
  };
}

export const provider: OAuthServerProvider = {
  clientsStore,

  async authorize(client, params: AuthorizationParams, res: Response) {
    sweep();
    const state = newId();
    pendingLogins.set(state, { cid: client.client_id, ru: params.redirectUri, cc: params.codeChallenge, st: params.state, exp: now() + 600 });
    const url = new URL(`${accountsUrl()}/oauth/v2/auth`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: env("ZOHO_CLIENT_ID"),
      scope: zohoScopes(),
      redirect_uri: callbackUrl(),
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    res.redirect(url.toString());
  },

  async challengeForAuthorizationCode(client, code) {
    const c = authCodes.get(code);
    if (!c || c.cid !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return c.cc;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const c = authCodes.get(code);
    authCodes.delete(code); // single use
    if (!c || c.cid !== client.client_id || c.exp < now()) throw new InvalidGrantError("Invalid or expired code");
    if (redirectUri && redirectUri !== c.ru) throw new InvalidGrantError("redirect_uri mismatch");
    return issueTokens(c.cid, c.rt, c.as);
  },

  async exchangeRefreshToken(client, refreshToken) {
    const t = unseal<Token>(refreshToken);
    if (t?.t !== "refresh" || t.cid !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    return issueTokens(t.cid, t.rt, t.as);
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    const t = unseal<Token>(token);
    if (t?.t !== "access" || !t.exp || t.exp < now()) throw new InvalidTokenError("Invalid or expired token");
    return { token, clientId: t.cid, scopes: [], expiresAt: t.exp, extra: { zoho: { refreshToken: t.rt, accountsServer: t.as } } };
  },

  // Signing out in Claude revokes the underlying Zoho refresh token too.
  async revokeToken(_client, req: OAuthTokenRevocationRequest) {
    const t = unseal<Token>(req.token);
    if (!t) return;
    await fetch(`${t.as}/oauth/v2/token/revoke?token=${encodeURIComponent(t.rt)}`, { method: "POST" }).catch(() => {});
  },
};

// Zoho redirects here after the user signs in. We swap Zoho's code for a refresh token,
// then send the user back to Claude with our own sealed authorization code.
export async function zohoCallback(req: Request, res: Response) {
  const stateId = String(req.query.state ?? "");
  const pending = pendingLogins.get(stateId);
  pendingLogins.delete(stateId);
  if (!pending || pending.exp < now()) {
    console.error("zoho callback: unknown or expired state (server restarted mid sign-in?)");
    return void res.status(400).send("Sign-in expired. Please try connecting again.");
  }

  const back = new URL(pending.ru);
  if (pending.st) back.searchParams.set("state", pending.st);
  if (req.query.error || !req.query.code) {
    console.error(`zoho callback: Zoho returned error=${req.query.error ?? "no code"}`);
    back.searchParams.set("error", "access_denied");
    return void res.redirect(back.toString());
  }

  // Zoho tells us which data centre the user's account lives in (multi-DC must be enabled on the client).
  // Only ever send our client secret to a real Zoho accounts server.
  const as = String(req.query["accounts-server"] ?? accountsUrl()).replace(/\/$/, "");
  if (!/^https:\/\/accounts\.zoho\.(com|in|eu|com\.au|jp|ca|sa|uk|com\.cn)$/.test(as)) {
    console.error(`zoho callback: rejected unexpected accounts-server ${as}`);
    return void res.status(400).send("Unexpected Zoho accounts server.");
  }
  const r = await fetch(`${as}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({
      code: String(req.query.code),
      client_id: env("ZOHO_CLIENT_ID"),
      client_secret: env("ZOHO_CLIENT_SECRET"),
      redirect_uri: callbackUrl(),
      grant_type: "authorization_code",
    }),
  });
  const body = (await r.json()) as { refresh_token?: string; error?: string };
  if (!body.refresh_token) {
    console.error(`zoho callback: token exchange at ${as} failed: status=${r.status} error=${body.error ?? "no refresh_token"}`);
    back.searchParams.set("error", "server_error");
    back.searchParams.set("error_description", `Zoho sign-in failed: ${body.error ?? r.status}`);
    return void res.redirect(back.toString());
  }

  const code = newId();
  authCodes.set(code, { cid: pending.cid, ru: pending.ru, cc: pending.cc, rt: body.refresh_token, as, exp: now() + CODE_TTL });
  console.log(`zoho callback: signed in via ${as}, returning to ${back.origin}${back.pathname}`);
  back.searchParams.set("code", code);
  res.redirect(back.toString());
}

export const userFromAuth = (auth?: AuthInfo): ZohoUser => {
  const u = auth?.extra?.zoho as ZohoUser | undefined;
  if (!u) throw new Error("Not signed in to Zoho");
  return u;
};
