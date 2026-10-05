import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createSetupBrowser } from "../src/auth/setup-browser.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Storage } from "../src/storage.js";
import { loadConfig, assertConfig } from "../src/config.js";

test("stopped-service CLI pins only trusted owner, rejects noninteractive enrollment, and administers grants", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtasks-cli-"));
  const store = new Storage(dir);
  const command = (args: string[], owner = "") =>
    spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_DIR: dir,
        GOOGLE_CLIENT_ID: "test",
        GOOGLE_CLIENT_SECRET: "fake",
        OWNER_GOOGLE_SUB: owner,
        DEPLOYMENT_MODE: "local",
        HOST: "127.0.0.1",
        BASE_URL: "http://localhost:3789",
        PORT: "3789",
        SETUP_URL: "http://localhost:3789/oauth/google/callback",
      },
      encoding: "utf8",
    });
  try {
    assert.notEqual(command(["setup"]).status, 0);
    store.acquire();
    assert.equal(store.snapshot().owner, null);
    store.release();
    assert.equal(command(["setup"], "owner").status, 0);
    assert.notEqual(command(["setup"], "different").status, 0);
    store.acquire();
    store.saveClient({
      client_id: "client",
      client_name: "Test client",
      redirect_uris: ["http://127.0.0.1/cb"],
      token_endpoint_auth_method: "none",
    });
    store.provision(
      "owner",
      { refresh_token: "google" },
      store.revision("client"),
      "client",
    );
    store.approve("client", "http://127.0.0.1/cb", "https://mcp.example/mcp");
    const token = store.issueGrant(
      "client",
      "http://127.0.0.1/cb",
      "https://mcp.example/mcp",
      store.revision("client"),
    );
    assert.notEqual(command(["clients", "revoke", "client"]).status, 0);
    assert.ok(store.accessToken(token.access_token, "https://mcp.example/mcp"));
    store.release();
    assert.match(command(["clients", "list"]).stdout, /client.*Test client/);
    assert.equal(command(["clients", "revoke", "client"]).status, 0);
    store.acquire();
    assert.equal(
      store.accessToken(token.access_token, "https://mcp.example/mcp"),
      undefined,
    );
    assert.ok(store.readGoogleTokens());
    store.release();
    assert.equal(command(["disconnect"]).status, 0);
    store.acquire();
    assert.equal(store.readGoogleTokens(), null);
    assert.equal(store.snapshot().owner, "owner");
    store.release();
    assert.equal(command(["clients", "remove", "client"]).status, 0);
    store.acquire();
    assert.equal(store.getClient("client"), undefined);
  } finally {
    store.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("configuration enforces deployment and independent loopback setup callback boundaries", () => {
  const base = { GOOGLE_CLIENT_ID: "test", GOOGLE_CLIENT_SECRET: "fake" };
  assert.doesNotThrow(() =>
    assertConfig(
      loadConfig({
        ...base,
        DEPLOYMENT_MODE: "hosted",
        TRUST_PROXY: "127.0.0.1",
        BASE_URL: "https://mcp.example",
        SETUP_URL: "http://localhost:9876/oauth/google/callback",
      }),
    ),
  );
  for (const env of [
    { HOST: "0.0.0.0" },
    { DEPLOYMENT_MODE: "hosted", BASE_URL: "https://mcp.example" },
    { TRUST_PROXY: "0.0.0.0/33" },
    { TRUST_PROXY: "0.0.0.0/0" },
    { TRUST_PROXY: "::/0" },
    { TRUST_PROXY: "localhost" },
    { BASE_URL: "http://remote.example" },
    { DEPLOYMENT_MODE: "hosted", BASE_URL: "http://mcp.example" },
    { SETUP_URL: "http://remote.example/oauth/google/callback" },
    { SETUP_URL: "http://localhost:3789/wrong" },
  ])
    assert.throws(() => assertConfig(loadConfig({ ...base, ...env })));
});

test("trusted setup browser binds entry, Host, cookie, state, nonce, expiry and single use without pinning owner", async () => {
  for (const variant of [
    "success",
    "entry",
    "host",
    "cookie",
    "state",
    "expiry",
    "mixed",
    "nonce",
  ]) {
    let time = Date.now(),
      nonce = "",
      state = "",
      exchanges = 0;
    const c = loadConfig({
      GOOGLE_CLIENT_ID: "test",
      GOOGLE_CLIENT_SECRET: "fake",
      SETUP_URL: "http://localhost:9876/oauth/google/callback",
      BASE_URL: "https://mcp.example",
      DEPLOYMENT_MODE: "hosted",
    });
    const flow = createSetupBrowser(
      c,
      {
        url(p, s, n, callback) {
          assert.equal(p, "identity");
          assert.equal(callback, c.setupUrl);
          state = s;
          nonce = n;
          return "https://accounts.google.com/auth";
        },
        async exchange(_code, callback) {
          exchanges++;
          assert.equal(callback, c.setupUrl);
          return { id_token: "signed" };
        },
        async identity(_tokens, n) {
          assert.equal(n, nonce);
          if (variant === "nonce") throw new Error("Invalid nonce");
          return { sub: "verified-owner" };
        },
      },
      () => time,
    );
    const result = flow.result.then(
      (value) => ({ value }),
      () => ({ value: undefined }),
    );
    const server = flow.app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const request = (url: string, cookie = "", host = "localhost:9876") =>
      new Promise<{ status: number; cookie: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: url,
            headers: { host, ...(cookie ? { cookie } : {}) },
          },
          (res) => {
            res.resume();
            res.once("end", () =>
              resolve({
                status: res.statusCode!,
                cookie: res.headers["set-cookie"]?.[0].split(";")[0] ?? "",
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      if (variant === "entry" || variant === "host") {
        assert.equal(
          (
            await request(
              "/setup?key=" + (variant === "entry" ? "wrong" : flow.entry),
              "",
              variant === "host" ? "evil.example" : "localhost:9876",
            )
          ).status,
          variant === "host" ? 421 : 400,
        );
        assert.equal(exchanges, 0);
        continue;
      }
      const entry = await request("/setup?key=" + flow.entry);
      assert.equal(entry.status, 302);
      assert.equal((await request("/setup?key=" + flow.entry)).status, 400);
      if (variant === "expiry") time += 10 * 60 * 1000;
      const callback =
        "/oauth/google/callback?" +
        new URLSearchParams({
          state: variant === "state" ? "wrong" : state,
          code: "google-code",
          ...(variant === "mixed" ? { error: "access_denied" } : {}),
        });
      const response = await request(
        callback,
        variant === "cookie" ? "" : entry.cookie,
      );
      assert.equal(response.status, variant === "success" ? 200 : 400);
      const identity = await result;
      assert.equal(
        identity.value?.sub,
        variant === "success" ? "verified-owner" : undefined,
      );
      assert.equal((await request(callback, entry.cookie)).status, 400);
      assert.equal(exchanges, ["success", "nonce"].includes(variant) ? 1 : 0);
    } finally {
      flow.fail(new Error("test complete"));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});

test("startup and migration parse failures redact persisted secret sentinels", () => {
  for (const variant of ["json", "schema", "legacy"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtasks-redaction-"));
    const store = new Storage(dir);
    const sentinel = "SECRET_SENTINEL_DO_NOT_LOG_7f7253";
    try {
      if (variant === "legacy")
        fs.writeFileSync(path.join(dir, "clients.json"), sentinel);
      else {
        store.acquire();
        store.pinOwner("owner");
        const state = store.snapshot();
        store.release();
        if (variant === "schema") {
          state.clients.bad = {
            client_id: "bad",
            redirect_uris: ["https://client.example/cb"],
            token_endpoint_auth_method: sentinel as "none",
          };
          fs.writeFileSync(store.file, JSON.stringify(state));
        } else fs.writeFileSync(store.file, sentinel);
      }
      const proc = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/index.ts",
          ...(variant === "legacy" ? ["migrate"] : []),
        ],
        {
          env: {
            ...process.env,
            DATA_DIR: dir,
            GOOGLE_CLIENT_ID: "fake",
            GOOGLE_CLIENT_SECRET: "fake",
            OWNER_GOOGLE_SUB: "",
            DEPLOYMENT_MODE: "local",
            HOST: "127.0.0.1",
            BASE_URL: "http://localhost:3789",
          },
          encoding: "utf8",
        },
      );
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /storage is unreadable or corrupt/);
      assert.equal((proc.stderr + proc.stdout).includes(sentinel), false);
      assert.equal(fs.existsSync(path.join(dir, ".writer-lock")), false);
    } finally {
      store.release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
