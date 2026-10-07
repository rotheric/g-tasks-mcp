import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { loadConfig, assertConfig, accessProfilesFor, GOOGLE_TASKS_SCOPE } from "../src/config.js";
import { Storage } from "../src/storage.js";
import { getAuthorizedGoogleClient } from "../src/google.js";
import type { GooglePort } from "../src/auth/google-identity.js";

const local = "http://localhost:3789", vm = "http://host.lima.internal:3789";
const verifier = "A".repeat(43), challenge = createHash("sha256").update(verifier).digest("base64url");
const redirect = "http://127.0.0.1:9999/callback";
const baseConfig = { GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "fake", SEARCH_ENABLED: "false" };

async function fixture(enabled = true) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gtasks-vm-")));
  const c = loadConfig({ ...baseConfig, DATA_DIR: dir, ...(enabled ? { VM_ACCESS_ORIGIN: vm } : {}) });
  const store = new Storage(dir);
  store.acquire();
  store.pinOwner("owner");
  const googleStates = new Map<string, { purpose: string; nonce: string }>();
  let owner = "owner";
  const google: GooglePort = {
    url(purpose, state, nonce, callback) {
      assert.equal(callback, local + "/oauth/google/callback");
      googleStates.set(state, { purpose, nonce });
      const url = new URL("https://accounts.google.com/auth");
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", callback);
      return url.href;
    },
    async exchange(code, callback) {
      assert.equal(callback, local + "/oauth/google/callback");
      const t = googleStates.get(code)!;
      return { id_token: t.nonce, ...(t.purpose === "tasks" ? {
        refresh_token: "google-refresh", scope: GOOGLE_TASKS_SCOPE,
      } : {}) };
    },
    async identity(tokens, nonce) {
      assert.equal(tokens.id_token, nonce);
      return { sub: owner };
    },
  };
  const app = createApp({ store, configuration: c, google });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  let cookie = "";
  async function request(target: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(target, local), browser = url.origin === local;
    const headers = new Headers(init.headers);
    headers.set("host", headers.get("host") ?? url.host);
    if (browser && cookie) headers.set("cookie", cookie);
    const response = await new Promise<Response>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path: url.pathname + url.search,
        method: init.method ?? "GET", headers: Object.fromEntries(headers),
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers))
            if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(",") : value);
          resolve(new Response([204, 304].includes(incoming.statusCode!) ? null : Buffer.concat(chunks),
            { status: incoming.statusCode, headers: responseHeaders }));
        });
      });
      req.on("error", reject);
      if (init.body) req.write(String(init.body));
      req.end();
    });
    const nextCookie = response.headers.get("set-cookie");
    if (nextCookie) {
      assert.ok(browser, "VM endpoints must not create browser cookies");
      cookie = nextCookie.split(";")[0];
    }
    return response;
  }
  const post = (url: string, values: Record<string, string>) => request(url, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(url.startsWith(local) ? { origin: local } : {}) },
    body: new URLSearchParams(values),
  });
  async function register(origin: string, method = "none") {
    const response = await request(origin + "/register", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({
        client_name: "VM fixture", redirect_uris: [redirect], token_endpoint_auth_method: method,
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      }),
    });
    assert.equal(response.status, 201);
    return response.json();
  }
  const fields = (html: string) => Object.fromEntries(
    [...html.matchAll(/name="(id|csrf|session_csrf)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
  async function begin(origin: string, clientId: string, extra: Record<string, string | undefined> = {}) {
    const params: Record<string, string | undefined> = {
      client_id: clientId, response_type: "code", redirect_uri: redirect,
      code_challenge: challenge, code_challenge_method: "S256", state: "client-state",
      resource: origin + "/mcp", ...extra,
    };
    const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined));
    return request(local + (origin === vm ? "/authorize/vm" : "/authorize") + "?" + query);
  }
  async function googleCallback(response: Response) {
    const url = new URL(response.headers.get("location")!);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("redirect_uri"), local + "/oauth/google/callback");
    const state = url.searchParams.get("state")!;
    return request(local + "/oauth/google/callback?" + new URLSearchParams({ state, code: state }));
  }
  async function authorize(origin: string, clientId: string, omitted = false) {
    let response = await begin(origin, clientId, omitted ? { resource: undefined } : {});
    assert.equal(response.status, 302);
    if (response.headers.get("location")!.startsWith("https://accounts.google.com"))
      response = await googleCallback(response);
    if (response.headers.get("location")?.startsWith("/auth/consent"))
      response = await request(response.headers.get("location")!);
    if (response.status === 200) {
      response = await post(local + "/auth/approve", fields(await response.text()));
      if (response.headers.get("location")!.startsWith("https://accounts.google.com"))
        response = await googleCallback(response);
    }
    assert.equal(response.status, 302);
    const callback = new URL(response.headers.get("location")!);
    assert.equal(callback.origin + callback.pathname, redirect);
    assert.equal(callback.searchParams.get("state"), "client-state");
    assert.equal(callback.searchParams.get("iss"), origin + "/");
    return callback.searchParams.get("code")!;
  }
  const exchange = (origin: string, clientId: string, code: string, extra: Record<string, string> = {}) =>
    post(origin + "/token", { grant_type: "authorization_code", client_id: clientId, code,
      code_verifier: verifier, redirect_uri: redirect, ...extra });
  const refresh = (origin: string, clientId: string, token: string, extra: Record<string, string> = {}) =>
    post(origin + "/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: token, ...extra });
  async function connect(origin: string, token: string) {
    const client = new Client({ name: "vm-fixture", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(origin + "/mcp/"), {
      requestInit: { headers: { authorization: "Bearer " + token } },
      fetch: ((url: string | URL, init: RequestInit) => request(String(url), init)) as typeof fetch,
    });
    await client.connect(transport);
    return client;
  }
  return { c, store, request, post, register, fields, begin, googleCallback, authorize, exchange, refresh, connect,
    wrongOwner() { owner = "intruder"; },
    reload() { store.release(); store.acquire(); },
    async close() { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r()));
      store.release(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test("VM origin is narrowly opt-in and cannot change local listener or hosted policy", async () => {
  assertConfig(loadConfig({ ...baseConfig, VM_ACCESS_ORIGIN: vm }));
  assertConfig(loadConfig({ ...baseConfig, PORT: "4000", VM_ACCESS_ORIGIN: "http://host.lima.internal:4000/" }));
  for (const value of ["http://evil.example:3789", "https://host.lima.internal:3789", "http://host.lima.internal:4000",
    vm + "/path", vm + "?x=1", vm + "#x", "http://user:secret@host.lima.internal:3789", "http://host.lima.internal.evil:3789"])
    assert.throws(() => assertConfig(loadConfig({ ...baseConfig, VM_ACCESS_ORIGIN: value })), value);
  for (const patch of [{ HOST: "0.0.0.0" }, { DEPLOYMENT_MODE: "hosted", BASE_URL: "https://mcp.example", TRUST_PROXY: "127.0.0.1" }])
    assert.throws(() => assertConfig(loadConfig({ ...baseConfig, VM_ACCESS_ORIGIN: vm, ...patch })));
  const f = await fixture(false);
  try {
    assert.equal((await f.request(vm + "/mcp/")).status, 421);
    assert.equal((await f.request(local + "/authorize/vm")).status, 404);
    assert.equal((await f.request(local + "/mcp/")).status, 401);
  } finally { await f.close(); }
});

test("metadata and bearer challenges use fixed Host profiles and ignore forwarded identity", async () => {
  const f = await fixture();
  try {
    for (const p of accessProfilesFor(f.c)) {
      const headers = { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", forwarded: "host=evil.example;proto=https" };
      const challengeResponse = await f.request(p.origin + "/mcp/", { headers });
      assert.equal(challengeResponse.status, 401);
      assert.match(challengeResponse.headers.get("www-authenticate")!, new RegExp(p.origin.replaceAll(".", "\\.") + "/.well-known/oauth-protected-resource/mcp"));
      const prmResponse = await f.request(p.origin + "/.well-known/oauth-protected-resource/mcp", { headers });
      assert.equal(prmResponse.headers.get("access-control-allow-origin"), "*");
      const prm = await prmResponse.json();
      assert.equal(prm.resource, p.resource);
      assert.deepEqual(prm.authorization_servers, [p.issuer]);
      const metadata = await (await f.request(p.issuer + ".well-known/oauth-authorization-server", { headers })).json();
      assert.equal(metadata.issuer, p.issuer);
      assert.equal(metadata.authorization_endpoint, local + p.authorizationPath);
      for (const endpoint of ["token", "registration", "revocation"])
        assert.equal(metadata[endpoint + "_endpoint"], p.origin + "/" + ({ registration: "register", revocation: "revoke", token: "token" }[endpoint]));
      assert.equal((await f.request(p.origin + "/.well-known/oauth-authorization-server", { method: "OPTIONS" })).status, 204);
      assert.equal((await f.request(p.origin + "/.well-known/oauth-authorization-server", { method: "POST" })).status, 405);
    }
    for (const host of ["evil.example:3789", "host.lima.internal:9999", "host.lima.internal.evil:3789"])
      assert.equal((await f.request(local + "/mcp/", { headers: { host, "x-forwarded-host": "localhost:3789" } })).status, 421);
  } finally { await f.close(); }
});

for (const origin of [local, vm])
  test(`SDK initialization, real read-only tool, omitted resource, reload, refresh and revocation via ${origin}`, async () => {
    const f = await fixture();
    try {
      const registration = await f.register(origin, "client_secret_post");
      const code = await f.authorize(origin, registration.client_id, true);
      assert.equal(Object.keys(f.store.snapshot().grants).length, 0);
      const response = await f.exchange(origin, registration.client_id, code, { client_secret: registration.client_secret });
      assert.equal(response.status, 200);
      const tokens = await response.json();
      const grants = Object.values(f.store.snapshot().grants);
      assert.equal(grants.length, 1);
      assert.equal(grants[0].resource, origin + "/mcp");
      let taskRequests = 0;
      const stubTaskApi = () => {
        const google = getAuthorizedGoogleClient(f.store, f.c);
        google.request = (async (options: { url: string; method?: string }) => {
          assert.match(options.url, /tasks.googleapis.com/);
          assert.equal(options.method, "GET");
          taskRequests++;
          return { data: { items: [{ id: "fixture-list", title: "Read-only fixture" }] } };
        }) as typeof google.request;
      };
      stubTaskApi();
      const client = await f.connect(origin, tokens.access_token);
      try {
        const result = await client.callTool({ name: "list_task_lists", arguments: {} });
        assert.equal(result.isError, undefined);
        assert.match(JSON.stringify(result), /Read-only fixture/);
        assert.equal(taskRequests, 1);
      } finally { await client.close(); }
      f.reload();
      assert.ok(f.store.accessToken(tokens.access_token, origin + "/mcp"));
      const renewedResponse = await f.refresh(origin, registration.client_id, tokens.refresh_token,
        { client_secret: registration.client_secret, resource: origin + "/mcp" });
      assert.equal(renewedResponse.status, 200);
      const renewed = await renewedResponse.json();
      assert.notEqual(renewed.refresh_token, tokens.refresh_token);
      stubTaskApi();
      const refreshedClient = await f.connect(origin, renewed.access_token);
      await refreshedClient.close();
      assert.equal((await f.post(origin + "/revoke", { client_id: registration.client_id,
        client_secret: registration.client_secret, token: renewed.refresh_token })).status, 200);
      assert.equal((await f.request(origin + "/mcp/", { headers: { authorization: "Bearer " + renewed.access_token } })).status, 401);
    } finally { await f.close(); }
  });

for (const origin of [local, vm])
  test(`resource and profile binding rejects cross-profile codes, refresh and bearer for ${origin}`, async () => {
    const f = await fixture(), other = origin === local ? vm : local;
    try {
      const { client_id: id } = await f.register(origin);
      // Approve the same client for both resources so storage approval alone
      // cannot hide a missing authorization-code profile check.
      await f.authorize(other, id);
      const wrongProfileCode = await f.authorize(origin, id);
      const wrongCode = await f.exchange(other, id, wrongProfileCode);
      assert.equal(wrongCode.status, 400);
      assert.equal((await wrongCode.json()).error, "invalid_grant");
      assert.equal(Object.keys(f.store.snapshot().grants).length, 0);
      const wrongResource = await f.exchange(origin, id, await f.authorize(origin, id), { resource: other + "/mcp" });
      assert.equal(wrongResource.status, 400);
      assert.equal((await wrongResource.json()).error, "invalid_request");
      const invalidPkce = await f.exchange(origin, id, await f.authorize(origin, id), { code_verifier: "B".repeat(43) });
      assert.equal(invalidPkce.status, 400);
      const wrongRedirect = await f.exchange(origin, id, await f.authorize(origin, id), { redirect_uri: "http://127.0.0.1:9999/other" });
      assert.equal(wrongRedirect.status, 400);
      const tokens = await (await f.exchange(origin, id, await f.authorize(origin, id))).json();
      assert.equal((await f.request(other + "/mcp/", { headers: { authorization: "Bearer " + tokens.access_token } })).status, 401);
      for (const token of [tokens.access_token, tokens.refresh_token]) {
        assert.equal((await f.post(other + "/revoke", { client_id: id, token })).status, 200);
        assert.ok(f.store.accessToken(tokens.access_token, origin + "/mcp"));
      }
      const before = f.store.snapshot();
      assert.equal((await f.refresh(other, id, tokens.refresh_token)).status, 400);
      assert.equal((await f.refresh(origin, id, tokens.refresh_token, { resource: "http://unrelated.example/mcp" })).status, 400);
      assert.deepEqual(f.store.snapshot(), before);
      assert.equal((await f.request(origin + "/mcp/", { headers: { authorization: "Bearer invalid" } })).status, 401);
      assert.equal((await f.refresh(origin, id, tokens.refresh_token)).status, 200);
      assert.equal((await f.refresh(origin, id, tokens.refresh_token)).status, 400);
      assert.equal((await f.request(origin + "/mcp/", { headers: { authorization: "Bearer " + tokens.access_token } })).status, 401);
      for (const resource of [other + "/mcp", "http://unrelated.example/mcp"])
        assert.equal(new URL((await f.begin(origin, id, { resource })).headers.get("location")!).searchParams.get("error"), "invalid_request");
    } finally { await f.close(); }
  });

test("browser authority, slash MCP Origin checks and CSRF stay enforced for both profiles", async () => {
  const f = await fixture();
  try {
    for (const origin of [local, vm])
      for (const route of ["/mcp", "/mcp/", "/MCP", "/Mcp/"])
        for (const method of ["GET", "POST", "OPTIONS"])
          assert.equal((await f.request(origin + route, { method, headers: { origin: "https://evil.example" } })).status, 403);
    for (const origin of [local, vm]) {
      assert.equal((await f.request(origin + "/mcp/", { method: "OPTIONS", headers: { origin } })).status, 204);
      assert.equal((await f.request(origin + "/mcp/", { headers: { origin } })).status, 401);
    }
    for (const route of ["/authorize", "/Authorize/VM/", "/authorize/vm", "/auth/consent", "/AUTH/APPROVE/", "/auth/approve/", "/auth/logout", "/oauth/google/callback/", "/OAUTH/GOOGLE/CALLBACK"])
      assert.equal((await f.request(vm + route)).status, 421);
    for (const route of ["/authorize", "/authorize/vm", "/auth/approve", "/auth/logout"])
      assert.equal((await f.request(local + route, { method: "POST", headers: { origin: vm } })).status, 403);
    for (const route of ["/auth/approve", "/auth/deny", "/auth/logout"])
      for (const origin of [undefined, "null", "https://evil.example"])
        assert.equal((await f.request(local + route, { method: "POST",
          headers: origin ? { origin } : {},
        })).status, 403);
    const { client_id: id } = await f.register(vm);
    const consent = await f.googleCallback(await f.begin(vm, id));
    const body = f.fields(await consent.text());
    assert.equal((await f.post(local + "/auth/approve", { ...body, csrf: "wrong" })).status, 400);
    assert.equal(Object.keys(f.store.snapshot().grants).length, 0);
    const approved = await f.post(local + "/auth/approve", body);
    const callback = await f.googleCallback(approved);
    assert.equal(new URL(callback.headers.get("location")!).searchParams.get("iss"), vm + "/");
    assert.equal((await f.post(local + "/auth/approve", body)).status, 400);
  } finally { await f.close(); }
});

test("both authorization paths preserve strict redirects, fixed error issuer and owner checks", async () => {
  for (const origin of [local, vm]) {
    const f = await fixture();
    try {
      const { client_id: id } = await f.register(origin);
      const wrongCallback = await f.begin(origin, id, { redirect_uri: "http://localhost:9999/callback" });
      assert.equal(wrongCallback.status, 400);
      assert.equal(wrongCallback.headers.get("location"), null);
      for (const extra of [{ response_type: "token" }, { resource: "http://unrelated.example/mcp" }]) {
        const result = await f.begin(origin, id, extra);
        const callback = new URL(result.headers.get("location")!);
        assert.equal(callback.searchParams.get("error"), "invalid_request");
        assert.equal(callback.searchParams.get("iss"), origin + "/");
        assert.equal(callback.searchParams.get("state"), "client-state");
      }
      const consent = await f.googleCallback(await f.begin(origin, id));
      const denied = await f.post(local + "/auth/deny", f.fields(await consent.text()));
      const deniedCallback = new URL(denied.headers.get("location")!);
      assert.equal(deniedCallback.searchParams.get("error"), "access_denied");
      assert.equal(deniedCallback.searchParams.get("iss"), origin + "/");
      f.wrongOwner();
      // Logout forces a new owner identity check instead of using the owner session.
      const next = await f.begin(origin, id);
      const html = await (await f.request(next.headers.get("location")!)).text();
      await f.post(local + "/auth/logout", { session_csrf: f.fields(html).session_csrf });
      assert.equal((await f.googleCallback(await f.begin(origin, id))).status, 400);
      assert.equal(Object.keys(f.store.snapshot().grants).length, 0);
    } finally { await f.close(); }
  }
});
