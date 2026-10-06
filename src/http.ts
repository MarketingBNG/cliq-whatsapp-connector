#!/usr/bin/env node
// Multi-user remote connector: Streamable HTTP + OAuth. Each person signs in with their own Zoho account.
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { baseUrl as getBaseUrl } from "./config.js";
import { provider, zohoCallback, zohoCallbackPath, userFromAuth } from "./oauth/provider.js";
import { buildServer } from "./tools.js";

const baseUrl = new URL(getBaseUrl());
const mcpUrl = new URL("/mcp", baseUrl);

const app = express();
app.set("trust proxy", 1); // behind the hosting platform's HTTPS proxy

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: baseUrl,
    resourceServerUrl: mcpUrl,
    scopesSupported: [],
    resourceName: "Zoho Cliq",
  }),
);
app.get(zohoCallbackPath, (req, res, next) => zohoCallback(req, res).catch(next));
app.get("/", (_req, res) => res.send(`Zoho Cliq MCP connector. Add ${mcpUrl} as a custom connector in Claude.`));

const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

// Claude checks the server from the browser, so /mcp needs CORS, and the client must be able to read
// WWW-Authenticate to discover sign-in.
const mcpCors = cors({
  origin: true,
  exposedHeaders: ["WWW-Authenticate", "Mcp-Session-Id", "Mcp-Protocol-Version"],
  allowedHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
});
app.options("/mcp", mcpCors);

// Stateless: a fresh server + transport per request, bound to the caller's Zoho identity via req.auth.
app.post("/mcp", mcpCors, auth, express.json(), async (req, res) => {
  const server = buildServer(userFromAuth);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
// Any other method: still answer 401 + WWW-Authenticate when signed out, so clients can find sign-in.
app.all("/mcp", mcpCors, auth, (_req, res) => res.status(405).set("Allow", "POST").send("Method not allowed"));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Zoho Cliq MCP listening on :${port}, connector URL ${mcpUrl}`));
