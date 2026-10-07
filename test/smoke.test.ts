import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { getAuthorizedGoogleClient } from "../src/google.js";
import { Storage } from "../src/storage.js";
import {
  loadConfig,
  resourceFor,
  issuerFor,
  GOOGLE_TASKS_SCOPE,
} from "../src/config.js";
import type { GooglePort } from "../src/auth/google-identity.js";
import type { Auth } from "googleapis";

const verifier = "A".repeat(43),
  challenge = createHash("sha256").update(verifier).digest("base64url");
const redirect = "http://127.0.0.1:9999/callback";
async function fixture(
  seed = true,
  productionTools = false,
  extraConfig: Record<string, string> = {},
  forwardHttps = false,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtasks-auth-"));
  let time = Date.now();
  const store = new Storage(dir, { now: () => time });
  store.acquire();
  store.pinOwner("owner");
  const c = loadConfig({
    GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fake",
    PORT: "3789",
    DATA_DIR: dir,
    // Auth smoke tests stub Google task calls; search.test.ts covers search dependencies.
    SEARCH_ENABLED: "false",
    ...extraConfig,
  });
  if (seed)
    store.provision(
      "owner",
      { access_token: "google-access", refresh_token: "google-refresh" },
      store.revision("initial"),
      "initial",
    );
  let nonce = "",
    purpose = "identity",
    sub = "owner";
  let pause: Promise<void> | undefined;
  let outcome = "success";
  const googleTransactions = new Map<
    string,
    { nonce: string; purpose: string }
  >();
  let release: () => void = () => {};
  let notify: () => void = () => {};
  let entered = Promise.resolve();
  const google: GooglePort = {
    url(p, s, n, callback) {
      nonce = n;
      purpose = p;
      googleTransactions.set(s, { nonce: n, purpose: p });
      const u = new URL("https://accounts.google.com/auth");
      u.searchParams.set("state", s);
      u.searchParams.set("nonce", n);
      u.searchParams.set("redirect_uri", callback);
      u.searchParams.set("purpose", p);
      return u.href;
    },
    async exchange(code) {
      const transaction = googleTransactions.get(code);
      const pending = pause,
        capturedNonce = transaction?.nonce ?? nonce,
        capturedPurpose = transaction?.purpose ?? purpose,
        capturedOutcome = outcome;
      if (pending) {
        notify();
        await pending;
      }
      if (capturedOutcome !== "success") throw new Error(capturedOutcome);
      return {
        id_token: capturedNonce,
        refresh_token:
          capturedPurpose === "tasks" ? "new-google-refresh" : undefined,
        scope: capturedPurpose === "tasks" ? GOOGLE_TASKS_SCOPE : undefined,
      };
    },
    async identity(t, n) {
      assert.equal(t.id_token, n);
      return { sub };
    },
  };
  let effects = 0;
  const buildApp = () =>
    createApp({
      store,
      configuration: c,
      google,
      now: () => time,
      ...(productionTools
        ? {}
        : {
            tools(
              server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
            ) {
              server.registerTool(
                "create_task",
                { description: "test external Tasks port", inputSchema: {} },
                async () => {
                  effects++;
                  return { content: [{ type: "text", text: "created" }] };
                },
              );
            },
          }),
    });
  let server = buildApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  async function request(url: string, init: RequestInit = {}) {
    const res = await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        new URL(url, base),
        {
          method: init.method ?? "GET",
          headers: {
            host: "localhost:3789",
            ...(forwardHttps ? { "x-forwarded-proto": "https" } : {}),
            ...(cookie ? { cookie } : {}),
            ...Object.fromEntries(new Headers(init.headers)),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (b) => chunks.push(b));
          incoming.on("end", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(incoming.headers))
              if (v !== undefined)
                headers.set(k, Array.isArray(v) ? v.join(",") : v);
            resolve(
              new Response(
                incoming.statusCode === 204 ? null : Buffer.concat(chunks),
                { status: incoming.statusCode, headers },
              ),
            );
          });
        },
      );
      req.on("error", reject);
      if (init.body) req.write(String(init.body));
      req.end();
    });
    const next = res.headers.get("set-cookie");
    if (next) cookie = next.split(";")[0];
    return res;
  }
  async function register(method = "none") {
    const res = await request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test client",
        redirect_uris: [redirect],
        token_endpoint_auth_method: method,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.equal(res.status, 201);
    return await res.json();
  }
  function fields(html: string) {
    return {
      id: html.match(/name="id" value="([^"]+)"/)![1],
      csrf: html.match(/name="csrf" value="([^"]+)"/)![1],
      session_csrf: html.match(/name="session_csrf" value="([^"]+)"/)![1],
    };
  }
  const post = (url: string, body: Record<string, string | undefined>) =>
    request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded",
        ...(url.startsWith("/auth/") ? { origin: new URL(c.baseUrl).origin } : {}),
      },
      body: new URLSearchParams(
        Object.entries(body).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });
  async function begin(clientId: string, extra: Record<string, string> = {}) {
    const q = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "client-state",
      resource: resourceFor(c),
      ...extra,
    });
    return request("/authorize?" + q);
  }
  async function identityLogin(clientId: string, first?: Response) {
    first ??= await begin(clientId);
    assert.equal(first.status, 302);
    const location = first.headers.get("location")!;
    if (location.startsWith("/auth/consent"))
      return fields(await (await request(location)).text());
    const g = new URL(location);
    let html: string;
    let f: ReturnType<typeof fields>;
    assert.equal(g.searchParams.get("purpose"), "identity");
    html = await (
      await request(
        "/oauth/google/callback?" +
          new URLSearchParams({
            state: g.searchParams.get("state")!,
            code: "fake-code",
          }),
      )
    ).text();
    f = fields(html);
    return f;
  }
  async function authorize(clientId: string) {
    const first = await begin(clientId);
    const location = first.headers.get("location")!;
    if (location.startsWith(redirect))
      return new URL(location).searchParams.get("code")!;
    const f = await identityLogin(clientId, first);
    let res = await post("/auth/approve", f);
    if (
      res.headers.get("location")?.startsWith("https://accounts.google.com")
    ) {
      const g = new URL(res.headers.get("location")!);
      res = await request(
        "/oauth/google/callback?" +
          new URLSearchParams({
            state: g.searchParams.get("state")!,
            code: "fake-tasks",
          }),
      );
    }
    assert.equal(res.status, 302);
    const u = new URL(res.headers.get("location")!);
    assert.equal(u.searchParams.get("iss"), issuerFor(c));
    assert.equal(u.searchParams.get("state"), "client-state");
    assert.ok(u.searchParams.get("code"));
    return u.searchParams.get("code")!;
  }
  const token = (clientId: string, code: string, secret?: string) =>
    post("/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: resourceFor(c),
      ...(secret ? { client_secret: secret } : {}),
    });
  return {
    store,
    c,
    dir,
    request,
    register,
    post,
    begin,
    fields,
    identityLogin,
    authorize,
    token,
    effects: () => effects,
    now: () => time,
    clearCookie: () => {
      cookie = "";
    },
    wrongOwner: () => {
      sub = "intruder";
    },
    advance: (n: number) => {
      time += n;
    },
    suspend: () => {
      entered = new Promise<void>((r) => (notify = r));
      pause = new Promise<void>((r) => (release = r));
    },
    waitExchange: () => entered,
    resume: () => release(),
    unpauseNew: () => {
      pause = undefined;
      outcome = "success";
    },
    outcome: (value: string) => {
      outcome = value;
    },
    restart: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.release();
      store.acquire();
      server = buildApp().listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => {
      server.close();
      server.closeAllConnections();
      store.release();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("discovery, owner login, explicit approval, bearer use, rotation and revocation compose", async () => {
  const f = await fixture();
  try {
    const metadata = await (
      await f.request("/.well-known/oauth-authorization-server")
    ).json();
    assert.equal(metadata.issuer, issuerFor(f.c));
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
    const prm = await (
      await f.request("/.well-known/oauth-protected-resource/mcp")
    ).json();
    assert.equal(prm.resource, resourceFor(f.c));
    const denied = await f.request("/mcp", { method: "POST" });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate")!, /scope="tasks"/);
    const client = await f.register(),
      code = await f.authorize(client.client_id);
    const tokens = await (await f.token(client.client_id, code)).json();
    assert.ok(tokens.access_token);
    const call = await f.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + tokens.access_token,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_task", arguments: {} },
      }),
    });
    assert.equal(call.status, 200);
    assert.equal(f.effects(), 1);
    const refreshed = await f.post("/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource: resourceFor(f.c),
    });
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json();
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    const revoked = await f.post("/revoke", {
      client_id: client.client_id,
      token: tokens.refresh_token,
    });
    assert.equal(revoked.status, 200);
    assert.equal(
      f.store.accessToken(next.access_token, resourceFor(f.c)),
      undefined,
    );
    const persisted = fs.readFileSync(f.store.file, "utf8");
    assert.ok(!persisted.includes(tokens.access_token));
    assert.ok(!persisted.includes(tokens.refresh_token));
  } finally {
    f.close();
  }
});

test("stored Google credentials and recorded approval never substitute for an owner browser session", async () => {
  const f = await fixture();
  try {
    const c = await f.register();
    await f.authorize(c.client_id);
    const remembered = await f.begin(c.client_id);
    assert.ok(
      new URL(remembered.headers.get("location")!).searchParams.get("code"),
    );
    f.clearCookie();
    const fresh = await f.begin(c.client_id);
    assert.equal(new URL(fresh.headers.get("location")!).hostname, "accounts.google.com");
  } finally {
    f.close();
  }
});

test("wrong Google owner, replay and missing browser cookie cannot authorize or alter account", async () => {
  const f = await fixture();
  try {
    const client = await f.register();
    const res = await f.begin(client.client_id);
    const g = new URL(res.headers.get("location")!);
    const callback =
      "/oauth/google/callback?" +
      new URLSearchParams({
        state: g.searchParams.get("state")!,
        code: "fake",
      });
    f.wrongOwner();
    assert.equal((await f.request(callback)).status, 400);
    assert.equal((await f.request(callback)).status, 400);
    assert.equal(f.store.readGoogleTokens()?.refresh_token, "google-refresh");
    assert.equal(Object.keys(f.store.snapshot().grants).length, 0);
    f.clearCookie();
    assert.equal((await f.request(callback)).status, 400);
  } finally {
    f.close();
  }
});

test("direct Google sign-in retains explicit client approval and CSRF protection", async () => {
  const f = await fixture();
  try {
    const client = await f.register();
    const start = await f.begin(client.client_id);
    const google = new URL(start.headers.get("location")!);
    assert.equal(google.hostname, "accounts.google.com");
    assert.equal(google.searchParams.get("purpose"), "identity");
    assert.equal(google.searchParams.has("iss"), false);
    assert.equal(Object.keys(f.store.snapshot().grants).length, 0);
    const fields = await f.identityLogin(client.client_id, start);
    assert.equal(Object.keys(f.store.snapshot().grants).length, 0);
    assert.equal((await f.post("/auth/approve", { ...fields, csrf: "wrong" })).status, 400);
    const other = await f.register();
    const signedIn = await f.begin(other.client_id);
    assert.match(signedIn.headers.get("location")!, /^\/auth\/consent\?id=/);
    const page = await f.request(signedIn.headers.get("location")!);
    const html = await page.text();
    assert.ok(html.includes("Allow this client"));
    assert.ok(!html.includes("Continue to sign in"));
    assert.equal(Object.keys(f.store.snapshot().grants).length, 0);
    const denied = await f.post("/auth/deny", f.fields(html));
    assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "access_denied");
    assert.equal(Object.keys(f.store.snapshot().grants).length, 0);
    const approved = await f.post("/auth/approve", fields);
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    assert.equal((await f.token(client.client_id, code)).status, 200);
  } finally {
    f.close();
  }
});

test("real SDK PKCE/client/callback/resource checks and scope boundaries", async () => {
  const f = await fixture();
  try {
    const a = await f.register(),
      b = await f.register();
    for (const patch of [
      { code_verifier: "B".repeat(43) },
      { client_id: b.client_id },
      { redirect_uri: "http://127.0.0.1:9999/other" },
      { resource: "https://wrong.example/mcp" },
      { redirect_uri: undefined },
    ]) {
      const code = await f.authorize(a.client_id);
      const res = await f.post("/token", {
        grant_type: "authorization_code",
        client_id: a.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        resource: resourceFor(f.c),
        ...patch,
      });
      assert.equal(res.status, 400);
      assert.equal((await f.token(a.client_id, code)).status, 400);
    }
    const code = await f.authorize(a.client_id);
    const token = await f.token(a.client_id, code);
    assert.equal(token.status, 200);
    const tokens = await token.json();
    assert.equal((await f.token(a.client_id, code)).status, 400);
    for (const scope of ["other", ""])
      assert.equal(
        (
          await f.post("/token", {
            grant_type: "refresh_token",
            client_id: a.client_id,
            refresh_token: tokens.refresh_token,
            scope,
          })
        ).status,
        400,
      );
    const bad = await f.begin(a.client_id, { scope: "other" });
    assert.equal(
      new URL(bad.headers.get("location")!).searchParams.get("iss"),
      issuerFor(f.c),
    );
    await f.post("/revoke", {
      client_id: b.client_id,
      token: tokens.refresh_token,
    });
    assert.ok(f.store.accessToken(tokens.access_token, resourceFor(f.c)));
  } finally {
    f.close();
  }
});

test("confidential secrets are verifiers at rest and plaintext only at registration", async () => {
  const f = await fixture();
  try {
    const c = await f.register("client_secret_post"),
      code = await f.authorize(c.client_id);
    assert.ok(c.client_secret);
    assert.ok(!fs.readFileSync(f.store.file, "utf8").includes(c.client_secret));
    assert.equal((await f.token(c.client_id, code)).status, 400);
    assert.equal(
      (
        await f.token(
          c.client_id,
          code,
          f.store.getClient(c.client_id)!.client_secret,
        )
      ).status,
      400,
    );
    assert.equal(
      (await f.token(c.client_id, code, c.client_secret)).status,
      200,
    );
  } finally {
    f.close();
  }
});

test("registration rejects unsafe redirects, missing/unsupported authentication and metadata sizes", async () => {
  const f = await fixture();
  try {
    for (const patch of [
      { redirect_uris: ["http://remote.example/callback"] },
      { redirect_uris: ["https://example.com/callback#fragment"] },
      { redirect_uris: ["https://user@example.com/callback"] },
      { token_endpoint_auth_method: "client_secret_basic" },
      { token_endpoint_auth_method: undefined },
      { client_name: "x".repeat(121) },
    ]) {
      const res = await f.request("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
          ...patch,
        }),
      });
      assert.equal(res.status, 400);
    }
  } finally {
    f.close();
  }
});

test("Host and browser Origin policy separates cookie flows from public OAuth", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.request("/mcp", { headers: { host: "evil.example" } })).status,
      421,
    );
    assert.equal(
      (await f.request("/mcp", { headers: { origin: "https://evil.example" } }))
        .status,
      403,
    );
    assert.equal(
      (await f.post("/auth/approve", { id: "x", csrf: "x" })).status,
      400,
    );
    const metadata = await f.request(
      "/.well-known/oauth-protected-resource/mcp",
      { headers: { origin: "https://browser.example" } },
    );
    assert.equal(metadata.headers.get("access-control-allow-origin"), "*");
  } finally {
    f.close();
  }
});

test("browser navigations accept redirect Origins while mutations still reject them", async () => {
  const f = await fixture();
  try {
    const client = await f.register();
    const ownerFields = await f.identityLogin(client.client_id);
    const consent = "/auth/consent?id=" + ownerFields.id;
    for (const origin of ["null", "https://accounts.google.com"]) {
      const page = await f.request(consent, { headers: { origin } });
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("referrer-policy"), "same-origin");
      assert.equal(
        page.headers.get("content-security-policy"),
        "default-src 'none'; form-action 'self' https://accounts.google.com http://127.0.0.1:9999; frame-ancestors 'none'; base-uri 'none'",
      );
      const fields = f.fields(await page.text());
      const blocked = await f.request("/auth/approve", {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
      assert.equal(blocked.status, 403);
      const callback = await f.request("/oauth/google/callback?state=invalid&code=invalid", {
        headers: { origin },
      });
      assert.equal(callback.status, 400);
    }
    const page = await f.request(consent);
    const fields = f.fields(await page.text());
    const accepted = await f.request("/auth/approve", {
      method: "POST",
      headers: {
        origin: "http://localhost:3789",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    });
    assert.equal(accepted.status, 302);
    assert.ok(new URL(accepted.headers.get("location")!).searchParams.get("code"));
  } finally {
    f.close();
  }
});

test("fresh Tasks provisioning checks owner and permission before committing credentials", async () => {
  const f = await fixture(false);
  try {
    const c = await f.register(),
      code = await f.authorize(c.client_id);
    assert.equal(
      f.store.readGoogleTokens()?.refresh_token,
      "new-google-refresh",
    );
    assert.equal((await f.token(c.client_id, code)).status, 200);
  } finally {
    f.close();
  }
});

for (const event of ["disconnect", "revoke", "expiry", "logout"] as const)
  test(
    "suspended Google callback cannot resurrect after " + event,
    async () => {
      const f = await fixture(false);
      try {
        const c = await f.register(),
          fields = await f.identityLogin(c.client_id),
          provision = await f.post("/auth/approve", fields),
          g = new URL(provision.headers.get("location")!);
        f.suspend();
        const pending = f.request(
          "/oauth/google/callback?" +
            new URLSearchParams({
              state: g.searchParams.get("state")!,
              code: "fake",
            }),
        );
        await f.waitExchange();
        if (event === "disconnect") f.store.clearGoogleTokens();
        else if (event === "revoke") f.store.revokeClient(c.client_id);
        else if (event === "expiry") f.advance(10 * 60 * 1000);
        else
          assert.equal(
            (
              await f.post("/auth/logout", {
                session_csrf: fields.session_csrf,
              })
            ).status,
            200,
          );
        f.resume();
        const result = await pending;
        assert.equal(result.status, 400);
        assert.equal(f.store.readGoogleTokens(), null);
        assert.equal(Object.keys(f.store.snapshot().grants).length, 0);
      } finally {
        f.close();
      }
    },
  );

test("authorized token executes the real Tasks tool through Google API client", async () => {
  const f = await fixture(true, true);
  try {
    const c = await f.register(),
      code = await f.authorize(c.client_id),
      tokens = await (await f.token(c.client_id, code)).json();
    const client = getAuthorizedGoogleClient(f.store, f.c);
    let sent: unknown;
    client.request = (async (options: unknown) => {
      sent = options;
      return { data: { id: "created-task", title: "Requested task" } };
    }) as typeof client.request;
    const res = await f.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + tokens.access_token,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_task", arguments: { title: "Requested task" } },
      }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /created-task/);
    assert.match(JSON.stringify(sent), /Requested task/);
    assert.match(JSON.stringify(sent), /tasks.googleapis.com/);
  } finally {
    f.close();
  }
});

test("hosted mode requires TLS from an explicitly trusted proxy", async () => {
  for (const trusted of [false, true]) {
    const f = await fixture(true, false, {
      DEPLOYMENT_MODE: "hosted",
      BASE_URL: "https://localhost:3789",
      TRUST_PROXY: trusted ? "127.0.0.1" : "10.0.0.1",
    });
    try {
      assert.equal(
        (await f.request("/.well-known/oauth-authorization-server")).status,
        400,
      );
      const response = await f.request(
        "/.well-known/oauth-authorization-server",
        { headers: { "x-forwarded-proto": "https" } },
      );
      assert.equal(response.status, trusted ? 200 : 400);
      assert.equal(
        (
          await f.post("/token", {
            grant_type: "refresh_token",
            client_id: "unknown",
            refresh_token: "secret",
          })
        ).status,
        400,
      );
    } finally {
      f.close();
    }
  }
});

test("authorization codes allow only one concurrent redemption; mixed Google responses consume state; metadata is readable", async () => {
  const f = await fixture();
  try {
    const client = await f.register();
    const start = await f.begin(client.client_id);
    const google = new URL(start.headers.get("location")!);
    const callback =
      "/oauth/google/callback?" +
      new URLSearchParams({
        state: google.searchParams.get("state")!,
        code: "fake",
        error: "access_denied",
      });
    assert.equal((await f.request(callback)).status, 400);
    assert.equal(
      (await f.request(callback.replace("&error=access_denied", ""))).status,
      400,
    );
    const code = await f.authorize(client.client_id);
    const results = await Promise.all([
      f.token(client.client_id, code),
      f.token(client.client_id, code),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    for (const route of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await f.request(route, {
        headers: { origin: "https://browser.example" },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
    }
    assert.equal(
      (
        await f.request("/.well-known/oauth-authorization-server", {
          method: "OPTIONS",
          headers: { origin: "https://browser.example" },
        })
      ).status,
      204,
    );
  } finally {
    f.close();
  }
});

for (const purpose of ["identity", "tasks"] as const)
  for (const outcome of ["success", "invalid_grant", "transient"])
    for (const event of [
      "reconnect",
      "new-authorization",
      "logout",
      "expiry",
      "credential-revision",
    ])
      test(`delayed ${purpose} ${outcome} after ${event} preserves current state across reload`, async () => {
        const f = await fixture(purpose === "identity");
        try {
          const client = await f.register();
          let fields: ReturnType<typeof f.fields>;
          let google: URL;
          if (purpose === "identity") {
            const start = await f.begin(client.client_id);
            google = new URL(start.headers.get("location")!);
            // A concurrent identity flow exposes logout CSRF without approving
            // this pending transaction. Its cookie rotation retains session ID.
            fields = await f.identityLogin(client.client_id);
          } else {
            fields = await f.identityLogin(client.client_id);
            google = new URL(
              (await f.post("/auth/approve", fields)).headers.get("location")!,
            );
          }
          f.outcome(outcome);
          f.suspend();
          const pending = f.request(
            "/oauth/google/callback?" +
              new URLSearchParams({
                state: google.searchParams.get("state")!,
                code: google.searchParams.get("state")!,
              }),
          );
          await f.waitExchange();
          f.unpauseNew();
          let freshToken: string | undefined;
          if (event === "reconnect") {
            f.store.clearGoogleTokens();
            f.store.provision(
              "owner",
              { refresh_token: "fresh-reconnect" },
              f.store.revision(client.client_id),
              client.client_id,
            );
          } else if (event === "credential-revision") {
            f.store.provision(
              "owner",
              { refresh_token: "fresh-revision" },
              f.store.revision(client.client_id),
              client.client_id,
            );
          } else if (event === "new-authorization") {
            f.store.revokeClient(client.client_id);
            f.clearCookie();
            freshToken = (
              await (
                await f.token(
                  client.client_id,
                  await f.authorize(client.client_id),
                )
              ).json()
            ).access_token;
          } else if (event === "logout") {
            assert.equal(
              (
                await f.post("/auth/logout", {
                  session_csrf: fields.session_csrf,
                })
              ).status,
              200,
            );
          } else f.advance(10 * 60 * 1000);
          const committed = f.store.snapshot();
          f.resume();
          assert.equal((await pending).status, 400);
          assert.deepEqual(f.store.snapshot(), committed);
          f.store.release();
          f.store.acquire();
          assert.deepEqual(f.store.snapshot(), committed);
          if (freshToken)
            assert.ok(f.store.accessToken(freshToken, resourceFor(f.c)));
          f.clearCookie();
          assert.equal(
            (
              await f.token(
                client.client_id,
                await f.authorize(client.client_id),
              )
            ).status,
            200,
          );
        } finally {
          f.resume();
          f.close();
        }
      });

for (const outcome of ["success", "invalid_grant", "transient"])
  for (const event of ["refresh", "reconnect", "new-authorization"])
    test(`production Tasks ${outcome} after ${event} cannot overwrite or retire current credentials`, async () => {
      const f = await fixture(true, true);
      try {
        const clientInfo = await f.register();
        const tokens = await (
          await f.token(
            clientInfo.client_id,
            await f.authorize(clientInfo.client_id),
          )
        ).json();
        const google = getAuthorizedGoogleClient(f.store, f.c);
        let entered!: () => void, resume!: () => void;
        const started = new Promise<void>((r) => {
          entered = r;
        });
        const paused = new Promise<void>((r) => {
          resume = r;
        });
        google.request = (async () => {
          entered();
          await paused;
          if (outcome === "invalid_grant")
            throw { response: { status: 401 }, message: "invalid_grant" };
          if (outcome === "transient")
            throw {
              response: { status: 503 },
              message: "temporarily unavailable",
            };
          google.emit("tokens", { access_token: "obsolete-event" });
          return { data: { id: "completed", title: "Task" } };
        }) as unknown as typeof google.request;
        const pending = f.request("/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: "Bearer " + tokens.access_token,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "create_task", arguments: { title: "Task" } },
          }),
        });
        await started;
        if (event === "refresh")
          google.emit("tokens", { access_token: "fresh-refresh" });
        else if (event === "reconnect") {
          f.store.clearGoogleTokens();
          f.store.provision(
            "owner",
            { refresh_token: "fresh-reconnect" },
            f.store.revision(clientInfo.client_id),
            clientInfo.client_id,
          );
        } else {
          f.store.clearGoogleTokens();
          f.store.revokeClient(clientInfo.client_id);
          f.clearCookie();
          assert.equal(
            (
              await f.token(
                clientInfo.client_id,
                await f.authorize(clientInfo.client_id),
              )
            ).status,
            200,
          );
        }
        const current = f.store.snapshot();
        resume();
        assert.equal((await pending).status, 200);
        assert.deepEqual(f.store.snapshot(), current);
        f.store.release();
        f.store.acquire();
        assert.deepEqual(f.store.snapshot(), current);
        assert.ok(getAuthorizedGoogleClient(f.store, f.c));
      } finally {
        f.close();
      }
    });

test("two owner browser tabs race provisioning; restart drops codes but retains valid grants", async () => {
  const f = await fixture(false);
  try {
    const a = await f.register(),
      b = await f.register();
    const first = await f.identityLogin(a.client_id);
    const secondStart = await f.begin(b.client_id);
    let second = f.fields(
      await (await f.request(secondStart.headers.get("location")!)).text(),
    );
    const firstGoogle = new URL(
      (await f.post("/auth/approve", first)).headers.get("location")!,
    );
    const secondGoogle = new URL(
      (await f.post("/auth/approve", second)).headers.get("location")!,
    );
    const callback = (google: URL) =>
      "/oauth/google/callback?" +
      new URLSearchParams({
        state: google.searchParams.get("state")!,
        code: google.searchParams.get("state")!,
      });
    f.suspend();
    const pending = f.request(callback(firstGoogle));
    await f.waitExchange();
    f.unpauseNew();
    const winner = await f.request(callback(secondGoogle));
    assert.equal(winner.status, 302);
    const code = new URL(winner.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const tokens = await (await f.token(b.client_id, code)).json();
    f.resume();
    assert.equal((await pending).status, 400);
    assert.equal(Object.keys(f.store.snapshot().grants).length, 1);
    const outstanding = await f.authorize(b.client_id);
    await f.restart();
    assert.equal((await f.token(b.client_id, outstanding)).status, 400);
    assert.ok(f.store.accessToken(tokens.access_token, resourceFor(f.c)));
    assert.equal(
      (
        await f.post("/token", {
          grant_type: "refresh_token",
          client_id: b.client_id,
          refresh_token: tokens.refresh_token,
        })
      ).status,
      200,
    );
  } finally {
    f.resume();
    f.close();
  }
});

test("current Google transient failure preserves account; terminal failure disconnects and invalidates its bearer", async () => {
  const f = await fixture(true, true);
  try {
    const clientInfo = await f.register();
    const tokens = await (
      await f.token(
        clientInfo.client_id,
        await f.authorize(clientInfo.client_id),
      )
    ).json();
    const client = getAuthorizedGoogleClient(f.store, f.c);
    const invoke = () =>
      f.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer " + tokens.access_token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "create_task", arguments: { title: "Task" } },
        }),
      });
    const before = f.store.snapshot();
    client.request = (async () => {
      throw { response: { status: 503 }, message: "temporary" };
    }) as typeof client.request;
    assert.equal((await invoke()).status, 200);
    assert.deepEqual(f.store.snapshot(), before);
    client.request = (async () => {
      throw { response: { status: 401 }, message: "invalid_grant" };
    }) as typeof client.request;
    assert.equal((await invoke()).status, 200);
    assert.equal(f.store.readGoogleTokens(), null);
    assert.equal((await invoke()).status, 401);
    f.store.release();
    f.store.acquire();
    assert.equal(f.store.readGoogleTokens(), null);
  } finally {
    f.close();
  }
});

for (const purpose of ["identity", "tasks"])
  test(`delayed ${purpose} callback at absolute session expiry commits no authorization`, async () => {
    const f = await fixture(purpose === "identity");
    try {
      const client = await f.register();
      if (purpose === "tasks") await f.identityLogin(client.client_id);
      else await f.begin(client.client_id);
      for (let i = 0; i < 16; i++) {
        f.advance(29 * 60 * 1000);
        await f.begin(client.client_id);
      }
      f.advance(15 * 60 * 1000); // Browser session is active at 7h59m.
      const start = await f.begin(client.client_id);
      let fields = { id: "", csrf: "", session_csrf: "" };
      let response = start;
      if (purpose === "tasks") {
        fields = f.fields(await (await f.request(start.headers.get("location")!)).text());
        response = await f.post("/auth/approve", fields);
      }
      const google = new URL(response.headers.get("location")!);
      const committed = f.store.snapshot();
      f.suspend();
      const pending = f.request(
        "/oauth/google/callback?" +
          new URLSearchParams({
            state: google.searchParams.get("state")!,
            code: "fake",
          }),
      );
      await f.waitExchange();
      f.advance(60 * 1000);
      f.resume();
      assert.equal((await pending).status, 400);
      assert.deepEqual(f.store.snapshot(), committed);
      f.store.release();
      f.store.acquire();
      assert.deepEqual(f.store.snapshot(), committed);
      assert.equal((await f.post("/auth/approve", fields)).status, 400);
      f.clearCookie();
      assert.equal(
        (await f.token(client.client_id, await f.authorize(client.client_id)))
          .status,
        200,
      );
    } finally {
      f.resume();
      f.close();
    }
  });

test("hosted logout deletes its prefixed cookie with the creation security policy", async () => {
  const f = await fixture(
    true,
    false,
    {
      DEPLOYMENT_MODE: "hosted",
      BASE_URL: "https://localhost:3789",
      TRUST_PROXY: "127.0.0.1",
    },
    true,
  );
  try {
    const client = await f.register();
    const start = await f.begin(client.client_id);
    assert.match(start.headers.get("set-cookie")!, /^__Host-gtasks=/);
    assert.match(start.headers.get("set-cookie")!, /; Secure/);
    const fields = await f.identityLogin(client.client_id, start);
    const response = await f.post("/auth/logout", {
      session_csrf: fields.session_csrf,
    });
    assert.equal(response.status, 200);
    const deletion = response.headers.get("set-cookie")!;
    for (const pattern of [
      /^__Host-gtasks=;/,
      /; Path=\//,
      /; Secure/,
      /; HttpOnly/,
      /; SameSite=Lax/,
      /; Expires=/,
    ])
      assert.match(deletion, pattern);
    assert.equal((await f.post("/auth/approve", fields)).status, 400);
  } finally {
    f.close();
  }
});

test("confidential secrets expire at the exact boundary for code, refresh and revocation", async () => {
  const f = await fixture();
  try {
    const client = await f.register("client_secret_post");
    const expiry = Math.floor(f.now() / 1000) + 1;
    f.store.update((state) => {
      state.clients[client.client_id].client_secret_expires_at = expiry;
    });
    const tokenResponse = await f.token(
      client.client_id,
      await f.authorize(client.client_id),
      client.client_secret,
    );
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    f.advance(1000);
    assert.equal(Math.floor(f.now() / 1000), expiry);
    const code = await f.authorize(client.client_id);
    const before = f.store.snapshot();
    assert.equal(
      (await f.token(client.client_id, code, client.client_secret)).status,
      400,
    );
    for (const route of ["/token", "/revoke"]) {
      const response = await f.post(route, {
        client_id: client.client_id,
        client_secret: client.client_secret,
        ...(route === "/token"
          ? { grant_type: "refresh_token", refresh_token: tokens.refresh_token }
          : { token: tokens.refresh_token }),
      });
      assert.equal(response.status, 400);
    }
    assert.deepEqual(f.store.snapshot(), before);
    assert.ok(f.store.accessToken(tokens.access_token, resourceFor(f.c)));
    f.store.release();
    f.store.acquire();
    assert.equal(
      f.store.verifySecret(client.client_id, client.client_secret),
      false,
    );
    assert.deepEqual(f.store.snapshot(), before);
  } finally {
    f.close();
  }
});
