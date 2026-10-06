# Zoho Cliq MCP connector

A shared Claude connector for Zoho Cliq. Each person adds it in Claude and signs in with **their own Zoho account**. Claude then reads that person's Cliq chats **live from the Cliq API**.

The server keeps no database. Each person's Zoho sign-in is encrypted inside the token that Claude holds, so the server stores nothing.

WhatsApp support will be added later.

## Tools
| Tool | What it does |
|---|---|
| `list_chats` | DMs, groups and channels the signed-in user is in; filter by `name` |
| `list_channels` | Cliq channels |
| `get_messages` | Up to 100 messages from one chat (optional from/to window) |
| `get_chat_history` | **Full history** of 1–10 chats, paged back automatically (up to 5,000 per chat per call; continue for more) |
| `recent_activity` | Every message across active chats in the last N hours |
| `search_messages` | Text or sender search over the last N hours |
| `send_message` | Post to a chat. Only available when `CLIQ_ALLOW_SEND=true` |

## Sensitive data and answer style
- **Hidden by default:** API keys, tokens, passwords, OTPs, private keys, card numbers, SSN, PAN and Aadhaar are replaced with `[REDACTED: type]` before Claude sees them. Claude is told to warn you to rotate exposed credentials.
- **Revealing values:** Claude only gets the real values by calling a tool with `reveal_sensitive=true`. The connector instructs it to do that only after you ask explicitly and confirm. Search runs on the redacted text, so it can't be used to dig out hidden values.
- **Answer style:** the server sends Claude standing instructions: answer briefly, use bullets and avoid long paragraphs.
- Detection rules live in `src/redact.ts`, and the instructions in `src/tools.ts`.

## How sign-in works
```
Claude ──► /authorize (this server) ──► Zoho login & consent ──► /callback
       ◄── our code ◄────────────────────────────────────────────┘
Claude ──► /token  →  access/refresh token (encrypted, contains the user's Zoho refresh token)
Claude ──► /mcp  (Bearer token)  →  Cliq API as that user
```
Zoho doesn't let Claude register itself as a client, so this server acts as the OAuth server and hands the actual login to Zoho. When someone disconnects the connector in Claude, their Zoho token is revoked as well.

## Admin setup (one time)
1. **Create a Zoho client.** At https://api-console.zoho.com, choose **Add Client → Server-based Applications**.
   - Homepage URL: your `BASE_URL`.
   - Authorized Redirect URI: `<BASE_URL>/callback`.
   - In the client's **Settings**, turn on **multi-DC** so people with accounts in other data centres (.in, .com, .eu and so on) can sign in.
2. **Host the server** anywhere that gives you a public HTTPS URL, such as Render, Railway, Fly.io, a VPS or Azure App Service.
   - Build: `npm install && npm run build`
   - Start: `npm start`
   - Environment variables (see `.env.example`): `BASE_URL`, `SECRET_KEY` (a long random string), `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_DC`.
   **On Render:** push this folder to GitHub, then in Render choose **New → Blueprint** and pick the repo. `render.yaml` sets up the build and start commands and generates `SECRET_KEY`. Render then asks you for `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET`. You don't need `BASE_URL` on Render because it's taken from `RENDER_EXTERNAL_URL`. After the first deploy, copy the `https://<name>.onrender.com` URL into the Zoho client's redirect URI.
3. Share the connector URL with your team: `<BASE_URL>/mcp`.

## Each user
In Claude, open **Settings → Connectors → Add custom connector** and paste `<BASE_URL>/mcp`. Click **Connect**, sign in to Zoho and approve.
In Claude Code, run `claude mcp add --transport http zoho-cliq <BASE_URL>/mcp` and then `/mcp` to sign in.

People only see chats they are members of in Cliq.

## Local testing
- **Hosted mode on your machine:** set `BASE_URL=http://localhost:3000` and add `http://localhost:3000/callback` as a redirect URI on the Zoho client. Run `npm start`, then `npm run inspect` and connect to `http://localhost:3000/mcp`.
- **Single-user stdio mode, no hosting:** create a Self Client and generate a code with the `ZohoCliq.*.READ` scopes. Run `npm run token -- <code>`, put the refresh token in `.env`, then run `npm run start:local`.

## Notes
- Changing `SECRET_KEY` signs everyone out.
- Codes are single-use only within one running server instance. If you run several instances, put them behind sticky sessions or run just one.
