import express from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  config,
  MCP_SCOPE,
  issuerFor,
  resourceFor,
  type Configuration,
} from "./config.js";
import { GoogleTasksOAuthProvider } from "./provider.js";
import { BrowserAuthorization } from "./auth/browser.js";
import { googlePort, type GooglePort } from "./auth/google-identity.js";
import { redirectMatches } from "./auth/policy.js";
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
  const browser = new BrowserAuthorization(
    store,
    c,
    options.google ?? googlePort(c),
    options.now,
  );
  const provider = new GoogleTasksOAuthProvider(store, c, browser),
    mcpUrl = new URL(resourceFor(c));
  app.disable("x-powered-by");
  app.set("trust proxy", c.trustedProxies.length ? c.trustedProxies : false);
  const origin = new URL(c.baseUrl).origin,
    authority = new URL(c.baseUrl).host;
  app.use((req, res, next) => {
    if (c.mode === "hosted" && !req.secure) {
      res.status(400).json({ error: "HTTPS required" });
      return;
    }
    if (req.headers.host !== authority) {
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
    const browserRoute =
      req.path.startsWith("/auth/") || req.path === "/oauth/google/callback";
    const requestOrigin = req.headers.origin;
    // OAuth callback navigations can carry an external or opaque Origin after
    // redirects. Their session-bound, single-use state authenticates the return.
    // Enforce Origin for browser mutations; those also require CSRF tokens.
    if (
      browserRoute &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      requestOrigin &&
      requestOrigin !== origin
    ) {
      res.status(403).json({ error: "Unexpected origin" });
      return;
    }
    if (req.path === "/mcp" && requestOrigin) {
      if (
        requestOrigin !== origin &&
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
  app.use("/authorize", (req, res, next) => {
    const input = req.method === "POST" ? req.body : req.query;
    const client =
      typeof input.client_id === "string"
        ? store.getClient(input.client_id)
        : undefined;
    if (
      client &&
      typeof input.redirect_uri === "string" &&
      !client.redirect_uris.some((uri) =>
        redirectMatches(input.redirect_uri, uri),
      )
    ) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const redirect = res.redirect.bind(res);
    res.redirect = ((a: number | string, b?: string) => {
      const target = typeof a === "string" ? a : b!;
      if (client && /^https?:\/\//.test(target)) {
        const u = new URL(target);
        const callback = new URL(
          typeof input.redirect_uri === "string"
            ? input.redirect_uri
            : client.redirect_uris[0],
        );
        // Successful client callbacks already include iss. Adapt only SDK
        // errors returning to the client, never upstream Google authorization.
        if (
          u.searchParams.has("error") &&
          u.origin === callback.origin &&
          u.pathname === callback.pathname
        ) {
          u.searchParams.set("iss", issuerFor(c));
          return redirect(typeof a === "number" ? a : 302, u.href);
        }
      }
      return redirect(typeof a === "number" ? a : 302, target);
    }) as typeof res.redirect;
    next();
  });
  // Advertise only implemented capabilities; SDK's router supplies the handlers.
  app.use("/.well-known/oauth-authorization-server", (req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
      issuer: issuerFor(c),
      authorization_endpoint: new URL("/authorize", c.baseUrl).href,
      token_endpoint: new URL("/token", c.baseUrl).href,
      registration_endpoint: new URL("/register", c.baseUrl).href,
      revocation_endpoint: new URL("/revoke", c.baseUrl).href,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [MCP_SCOPE],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
      ],
      authorization_response_iss_parameter_supported: true,
    }),
  );
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(c.baseUrl),
      scopesSupported: [MCP_SCOPE],
      resourceName: "Google Tasks",
      resourceServerUrl: mcpUrl,
    }),
  );
  browser.install(app);
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
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
