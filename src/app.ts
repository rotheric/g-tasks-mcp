import express from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  config,
  MCP_SCOPE,
  assertConfig,
  accessProfilesFor,
  type Configuration,
} from "./config.js";
import { GoogleTasksOAuthProvider } from "./provider.js";
import { BrowserAuthorization } from "./auth/browser.js";
import { googlePort, type GooglePort } from "./auth/google-identity.js";
import { oauthRouter, browserAuthorizationRouter } from "./auth/router.js";
import { storage, Storage } from "./storage.js";
import { registerTools } from "./tools.js";

export interface AppOptions {
  store?: Storage;
  configuration?: Configuration;
  google?: GooglePort;
  now?: () => number;
  tools?: typeof registerTools;
}
export function createApp(options: AppOptions = {}): express.Express {
  const app = express(),
    c = options.configuration ?? config,
    store = options.store ?? storage;
  assertConfig(c);
  const browser = new BrowserAuthorization(
    store,
    c,
    options.google ?? googlePort(c),
    options.now,
  );
  const profiles = accessProfilesFor(c).map((profile) => {
    const provider = new GoogleTasksOAuthProvider(store, c, browser, profile);
    return {
      profile,
      provider,
      oauth: oauthRouter(provider, c.baseUrl),
      bearer: requireBearerAuth({
        verifier: provider,
        requiredScopes: [MCP_SCOPE],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(profile.resource)),
      }),
    };
  });
  const byAuthority = new Map(profiles.map((entry) => [new URL(entry.profile.origin).host, entry]));
  app.disable("x-powered-by");
  app.set("trust proxy", c.trustedProxies.length ? c.trustedProxies : false);
  const origin = new URL(c.baseUrl).origin,
    authority = new URL(c.baseUrl).host;
  app.use((req, res, next) => {
    if (c.mode === "hosted" && !req.secure) {
      res.status(400).json({ error: "HTTPS required" });
      return;
    }
    const access = byAuthority.get(req.headers.host ?? "");
    if (!access) {
      res.status(421).json({ error: "Unexpected host" });
      return;
    }
    res.set({
      "Cache-Control": "no-store",
      // no-referrer makes HTML form POSTs send Origin: null. Keep same-origin
      // form provenance while suppressing referrers to Google and MCP clients.
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    // Match Express's default case-insensitive routing and optional final slash.
    const requestPath = req.path.toLowerCase().replace(/\/+$/, "");
    const browserRoute = requestPath.startsWith("/authorize") ||
      requestPath === "/auth" || requestPath.startsWith("/auth/") ||
      requestPath.startsWith("/oauth/google/callback");
    if (browserRoute && req.headers.host !== authority) {
      res.status(421).json({ error: "Browser authorization requires canonical host" });
      return;
    }
    const requestOrigin = req.headers.origin;
    // OAuth callback navigations can carry an external or opaque Origin after
    // redirects. Their session-bound, single-use state authenticates the return.
    // Cookie-authenticated forms require Origin and CSRF. OAuth authorization
    // clients may POST without Origin; any supplied Origin must be canonical.
    const cookieMutation = requestPath.startsWith("/auth/");
    if (
      browserRoute &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (cookieMutation || requestOrigin !== undefined) &&
      requestOrigin !== origin
    ) {
      res.status(403).json({ error: "Unexpected origin" });
      return;
    }
    if (requestPath === "/mcp" && requestOrigin) {
      if (
        requestOrigin !== access.profile.origin &&
        !c.browserOrigins.includes(requestOrigin)
      ) {
        res.status(403).json({ error: "Unexpected origin" });
        return;
      }
      res.set({
        "Access-Control-Allow-Origin": requestOrigin,
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id",
        "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Session-Id",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        Vary: "Origin",
      });
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
    }
    next();
  });
  // Bounds precede SDK parsing/authentication to cover every route and secret check.
  const attempts = new Map<string, { start: number; count: number }>();
  const now = options.now ?? Date.now;
  app.use((req, res, next) => {
    for (const [k, v] of attempts)
      if (now() - v.start >= 60000) attempts.delete(k);
    const key = req.ip ?? "unknown";
    let v = attempts.get(key);
    if (!v) {
      if (attempts.size >= 1000) {
        res.sendStatus(429);
        return;
      }
      v = { start: now(), count: 0 };
      attempts.set(key, v);
    }
    if (++v.count > 120) {
      res.sendStatus(429);
      return;
    }
    next();
  });
  app.use(
    express.json({ limit: "16kb" }),
    express.urlencoded({ extended: false, limit: "8kb" }),
  );
  app.use(["/token", "/revoke"], (req, res, next) => {
    if (req.method !== "POST") {
      next();
      return;
    }
    const client =
      typeof req.body.client_id === "string"
        ? store.getClient(req.body.client_id)
        : undefined;
    if (client?.client_secret) {
      if (
        typeof req.body.client_secret !== "string" ||
        !store.verifySecret(client.client_id, req.body.client_secret)
      ) {
        res.status(400).json({ error: "invalid_client" });
        return;
      }
      req.body.client_secret = client.client_secret;
    }
    next();
  });
  // Longest authorization path first: /authorize is a prefix in Express.
  for (const entry of [...profiles].reverse())
    app.use(entry.profile.authorizationPath, browserAuthorizationRouter(entry.provider));
  app.use((req, res, next) => byAuthority.get(req.headers.host!)!.oauth(req, res, next));
  browser.install(app);
  const bearer: express.RequestHandler = (req, res, next) =>
    byAuthority.get(req.headers.host!)!.bearer(req, res, next);
  app.post("/mcp", bearer, async (req: Request, res: Response) => {
    const server = new McpServer({ name: "google-tasks", version: "0.2.0" });
    (options.tools ?? registerTools)(server, store, c);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
    }
  });
  app.get("/mcp", bearer, (_req, res) => res.sendStatus(405));
  app.delete("/mcp", bearer, (_req, res) => res.sendStatus(405));
  app.use(
    (
      _err: unknown,
      _req: Request,
      res: Response,
      _next: express.NextFunction,
    ) => {
      if (!res.headersSent) res.status(400).json({ error: "invalid_request" });
    },
  );
  return app;
}
