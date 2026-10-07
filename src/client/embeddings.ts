import { z } from "zod";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { OAuthClientInformationFullSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config, issuerFor, resourceFor, type Configuration } from "../config.js";
import { ClientCache } from "./cache.js";

export function embeddingCountsMessage(value: unknown): string {
  const counts = z.object({ indexedTasks: z.number().int().nonnegative(), embeddedTasks: z.number().int().nonnegative(),
    reusedTasks: z.number().int().nonnegative() }).safeParse(value);
  if (!counts.success) return "Task counts unavailable; restart the server to load the current version.";
  const { indexedTasks, embeddedTasks, reusedTasks } = counts.data;
  return `${embeddedTasks} tasks embedded, ${reusedTasks} tasks reused, ${indexedTasks} tasks indexed in total.`;
}

export function callbackHandler(expected: { state: string; issuer: string; url: URL },
  finish: (code: string) => void, fail: (error: Error) => void) {
  let consumed = false;
  return (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Referrer-Policy", "no-referrer");
    let url: URL;
    try { url = new URL(req.url ?? "/", expected.url); }
    catch { res.writeHead(400).end("Invalid authorization callback."); return; }
    if (consumed || req.method !== "GET" || req.headers.host !== expected.url.host ||
        url.pathname !== expected.url.pathname || url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.getAll("iss").length !== 1 || url.searchParams.getAll("code").length > 1 ||
        url.searchParams.get("state") !== expected.state ||
        url.searchParams.get("iss") !== expected.issuer) {
      res.writeHead(400).end("Invalid authorization callback."); return;
    }
    consumed = true;
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code) {
      res.writeHead(400).end("Authorization denied. Return to the terminal.");
      fail(new Error("MCP authorization denied. Retry and approve the embeddings CLI.")); return;
    }
    res.end("Embeddings CLI authorized. You can close this tab.");
    finish(code);
  };
}

export async function embeddingsCommand(rebuild: boolean, c: Configuration = config): Promise<void> {
  const endpoint = new URL(resourceFor(c));
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      (endpoint.protocol === "http:" && !["localhost", "127.0.0.1"].includes(endpoint.hostname)))
    throw new Error("MCP CLI requires a loopback HTTP or HTTPS BASE_URL.");
  const cache = new ClientCache(path.join(c.dataDir, "mcp-cli"), endpoint.href);
  cache.acquire();
  const client = new Client({ name: "g-tasks-embeddings-cli", version: "0.2.0" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: (code: string) => void, fail!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  // Rejection can precede discovery completing or a browser authorization being needed.
  void code.catch(() => {});
  const state = randomBytes(32).toString("base64url");
  const callback = new URL("http://127.0.0.1/oauth/callback");
  const server = createServer(callbackHandler({ state, issuer: issuerFor(c), url: callback }, finish, fail));
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    fail(new Error("Embeddings command cancelled."));
    void client.close();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    callback.port = String((server.address() as { port: number }).port);
    let verifier = "";
    let acceptingAuthorization = true;
    const provider: OAuthClientProvider = {
      redirectUrl: callback.href,
      clientMetadata: { client_name: "Task embeddings CLI", redirect_uris: [callback.href],
        token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"], scope: "tasks" },
      state: () => state,
      clientInformation: () => cache.state.client,
      saveClientInformation(info) { cache.state.client = OAuthClientInformationFullSchema.parse(info); cache.save(); },
      tokens: () => cache.state.tokens,
      saveTokens(tokens) { cache.state.tokens = tokens; cache.save(); },
      saveCodeVerifier(value) { verifier = value; },
      codeVerifier() { return verifier; },
      redirectToAuthorization(url) {
        if (!acceptingAuthorization) throw new Error("MCP authorization expired. Retry make embeddings to authorize again.");
        console.log(`Approve the embeddings CLI in your host browser:\n${url.href}`);
        timer = setTimeout(() => fail(new Error("MCP authorization timed out. Retry make embeddings.")), 10 * 60000);
      },
      invalidateCredentials(scope) {
        if (scope === "all" || scope === "client") cache.state.client = undefined;
        if (scope === "all" || scope === "tokens") cache.state.tokens = undefined;
        if (scope === "all" || scope === "verifier") verifier = "";
        cache.save();
      },
      async validateResourceURL(_server, resource) {
        if (resource && new URL(resource).href !== endpoint.href) throw new Error("Unexpected MCP OAuth resource.");
        return endpoint;
      },
    };
    const authFetch: typeof fetch = (url, options) => fetch(url, {
      ...options, signal: controller.signal,
    });
    const authOptions = { serverUrl: endpoint, scope: "tasks", fetchFn: authFetch };
    let authorized = await auth(provider, authOptions);
    if (authorized === "REDIRECT")
      authorized = await auth(provider, { ...authOptions, authorizationCode: await code });
    if (authorized !== "AUTHORIZED") throw new Error("MCP authorization did not complete.");
    if (timer) clearTimeout(timer);
    acceptingAuthorization = false;
    server.close(); server.closeAllConnections();
    const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
    await client.connect(transport);
    const result = CallToolResultSchema.parse(await client.callTool({ name: rebuild ? "rebuild_search_index" : "sync_search_index", arguments: {} },
      CallToolResultSchema, { timeout: 60 * 60000 }));
    if (result.isError) {
      const message = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      throw new Error(message || "Server could not synchronize embeddings.");
    }
    const summary = result.content.find(item => item.type === "text");
    let counts: unknown;
    try { counts = summary?.type === "text" ? JSON.parse(summary.text) : undefined; } catch { /* Older servers may return plain text. */ }
    console.log(embeddingCountsMessage(counts));
    console.log(`Task embeddings ${rebuild ? "rebuilt" : "synchronized"} by the running server.`);
  } catch (error) {
    if (error instanceof TypeError && /fetch/i.test(error.message))
      throw new Error("Cannot reach the MCP server. Start it on the host and check BASE_URL.");
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (timer) clearTimeout(timer);
    server.close(); server.closeAllConnections();
    try { await client.close(); } finally { cache.release(); }
  }
}
