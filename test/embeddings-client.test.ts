import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ClientCache } from "../src/client/cache.js";
import { callbackHandler, embeddingCountsMessage } from "../src/client/embeddings.js";

test("CLI cache persists private credentials and excludes concurrent clients independently of server lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embedding-client-"));
  const cacheDir = path.join(dir, "mcp-cli");
  const cache = new ClientCache(cacheDir, "http://localhost:3000/mcp");
  try {
    fs.mkdirSync(path.join(dir, ".lock"));
    cache.acquire();
    cache.state.tokens = { access_token: "test-token", token_type: "Bearer" };
    cache.save();
    assert.throws(() => new ClientCache(cacheDir, "http://localhost:3000/mcp").acquire(), /locked/);
    const file = fs.readdirSync(cacheDir).find(f => f.endsWith(".json"))!;
    assert.equal(fs.statSync(path.join(cacheDir, file)).mode & 0o777, 0o600);
    cache.release();
    const next = new ClientCache(cacheDir, "http://localhost:3000/mcp");
    next.acquire(); assert.equal(next.state.tokens?.access_token, "test-token"); next.release();
    fs.chmodSync(path.join(cacheDir, file), 0o644);
    assert.throws(() => next.acquire(), /unsafe/);
  } finally { cache.release(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("browser callback requires matching host, issuer and state, and accepts a code only once", () => {
  const received: string[] = [];
  const handler = callbackHandler({ state: "expected", issuer: "http://localhost:3000", url: new URL("http://127.0.0.1:1234/oauth/callback") },
    code => received.push(code), error => { throw error; });
  const invoke = (state: string, issuer: string, host = "127.0.0.1:1234") => {
    let status = 200;
    const res = { setHeader() {}, writeHead(value: number) { status = value; return this; }, end() {} } as unknown as ServerResponse;
    handler({ method: "GET", headers: { host }, url: `/oauth/callback?state=${state}&iss=${encodeURIComponent(issuer)}&code=code` } as IncomingMessage, res);
    return status;
  };
  assert.equal(invoke("wrong", "http://localhost:3000"), 400);
  assert.equal(invoke("expected", "http://wrong"), 400);
  assert.equal(invoke("expected", "http://localhost:3000", "evil"), 400);
  assert.equal(invoke("expected", "http://localhost:3000"), 200);
  assert.equal(invoke("expected", "http://localhost:3000"), 400);
  assert.deepEqual(received, ["code"]);
});


test("CLI reports sync task counts and handles older servers without inventing counts", () => {
  assert.equal(embeddingCountsMessage({ indexedTasks: 12, embeddedTasks: 3, reusedTasks: 9 }),
    "3 tasks embedded, 9 tasks reused, 12 tasks indexed in total.");
  assert.match(embeddingCountsMessage({ lastFullSync: null }), /counts unavailable/);
});
