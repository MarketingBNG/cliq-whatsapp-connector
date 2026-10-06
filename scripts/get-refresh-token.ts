// Local single-user mode only. Usage: npm run token -- <grant_code>
// Exchanges a Zoho Self Client grant code for a refresh token to put in .env.
import { env } from "../src/config.js";
import { accountsUrl } from "../src/zoho/auth.js";

const code = process.argv[2];
if (!code) {
  console.error("Usage: npm run token -- <grant_code>");
  process.exit(1);
}
const res = await fetch(`${accountsUrl()}/oauth/v2/token`, {
  method: "POST",
  body: new URLSearchParams({
    code,
    client_id: env("ZOHO_CLIENT_ID"),
    client_secret: env("ZOHO_CLIENT_SECRET"),
    grant_type: "authorization_code",
  }),
});
const body = (await res.json()) as { refresh_token?: string };
if (body.refresh_token) console.log(`ZOHO_REFRESH_TOKEN=${body.refresh_token}`);
else console.error("Failed:", body);
