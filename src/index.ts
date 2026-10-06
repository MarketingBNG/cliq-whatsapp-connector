#!/usr/bin/env node
// Local single-user mode: runs over stdio as the account whose refresh token is in .env.
// For the shared multi-user connector, run src/http.ts instead.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { env } from "./config.js";
import { accountsUrl } from "./zoho/auth.js";
import { buildServer } from "./tools.js";

const user = { refreshToken: env("ZOHO_REFRESH_TOKEN"), accountsServer: accountsUrl() };
await buildServer(() => user).connect(new StdioServerTransport());
