import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "../src/storage.js";
import { loadConfig, assertConfig } from "../src/config.js";
import { SearchService } from "../src/search/service.js";
import { chunks, eligible, taskKey, fingerprints, type Task, type SearchInput } from "../src/search/text.js";
import { googleSource, ollama, qdrant, SearchError, type VectorPort, type Point, type Hit, type Http } from "../src/search/ports.js";
import { registerTools } from "../src/tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { tasks_v1 } from "googleapis";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
class Vectors implements VectorPort {
  collections = new Map<string, Map<string, Point>>();
  fail: "upsert" | "remove" | "query" | "payload" | undefined;
  async exists(c: string) { return this.collections.has(c); }
  async ensure(c: string, _dimension: number) {
    if (this.collections.has(c)) return false;
    this.collections.set(c, new Map()); return true;
  }
  async upsert(c: string, points: Point[]) {
    for (const p of points) this.collections.get(c)!.set(p.id, structuredClone(p));
    if (this.fail === "upsert") throw new Error("injected failure after write");
  }
  async payload(c: string, ids: string[], payload: Point["payload"]) {
    if (this.fail === "payload") throw new Error("injected payload failure");
    for (const id of ids) this.collections.get(c)!.get(id)!.payload = structuredClone(payload);
  }
  async remove(c: string, ids: string[]) {
    if (this.fail === "remove") throw new Error("injected delete failure");
    for (const id of ids) this.collections.get(c)!.delete(id);
  }
  async query(c: string, vector: number[], input: SearchInput, limit: number): Promise<Hit[]> {
    if (this.fail === "query") throw new SearchError();
    return [...this.collections.get(c)!.values()]
      .filter((p) => eligible({ listId: p.payload.listId, task: { status: p.payload.status, due: p.payload.due } }, input))
      .map((p) => ({ id: p.id, payload: p.payload, score:
        p.vector.reduce((sum, value, i) => sum + value * vector[i], 0) /
        (Math.hypot(...p.vector) * Math.hypot(...vector)) }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtasks-search-"));
  const store = new Storage(dir); store.acquire(); store.pinOwner("owner");
  const connect = () => store.provision("owner", { refresh_token: "fake" }, store.revision("initial"), "initial");
  connect();
  const c = loadConfig({ GOOGLE_CLIENT_ID: "fake", GOOGLE_CLIENT_SECRET: "fake", DATA_DIR: dir });
  const vectors = new Vectors();
  const tasks = new Map<string, { listId: string; task: Task }>();
  const add = (id: string, task: Partial<Task> = {}, listId = "list") => {
    const value = { listId, task: { id, title: `Task ${id}`, status: "needsAction", ...task } };
    tasks.set(taskKey(listId, id), value); return value.task;
  };
  let embeds = 0, fetches = 0, time = Date.now(), inventoryCalls = 0;
  let inventoryHook: (() => Promise<void>) | undefined, getHook: (() => Promise<void>) | undefined;
  const source = {
    async canonicalList(listId: string) { return listId === "@default" ? "list" : listId; },
    async inventory() { inventoryCalls++; await inventoryHook?.(); return structuredClone([...tasks.values()]); },
    async get(listId: string, id: string) { fetches++; await getHook?.(); return structuredClone(tasks.get(taskKey(listId, id))?.task ?? null); },
  };
  const embeddings = { async embed(texts: string[]) { embeds += texts.length; return texts.map(() => [1, 0]); } };
  const service = () => new SearchService(store, c, { source, embeddings, vectors, now: () => time });
  let search = service();
  return { dir, store, c, vectors, tasks, add, connect, source, embeddings,
    get search() { return search; }, restart() { search = service(); },
    get embeds() { return embeds; }, get fetches() { return fetches; }, get inventoryCalls() { return inventoryCalls; },
    set inventoryHook(h: (() => Promise<void>) | undefined) { inventoryHook = h; },
    set getHook(h: (() => Promise<void>) | undefined) { getHook = h; },
    advance(ms: number) { time += ms; },
    manifest() { return JSON.parse(fs.readFileSync(path.join(dir, "search-index.json"), "utf8")); },
    async close() { await search.stop(); store.release(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test("direct chunks preserve oversized Unicode notes with bounded title prefixes", () => {
  const title = "T".repeat(1024), notes = "🙂".repeat(4500) + "\n\nneedle near end";
  const values = chunks({ title, notes });
  const prefix = `Title: ${title}\nNotes: `;
  assert.equal(values.map((v) => v.slice(prefix.length)).join(""), notes);
  assert.ok(values.every((v) => Array.from(v).length <= 2850));
  assert.ok(values.length > 1);
});

test("sync, task-level fusion, keyword at end and current filters", async () => {
  const f = fixture();
  try {
    f.add("many", { notes: "filler ".repeat(20000) });
    f.add("target", { notes: "detail ".repeat(400) + " CERT-123", due: "2026-10-09T00:00:00Z" });
    f.add("done", { title: "CERT-123", status: "completed" });
    f.add("other", { title: "CERT-123" }, "other");
    const result: any = await f.search.search({ query: "CERT-123", tasklistIds: ["list"], dueMin: "2026-10-08T00:00:00Z", limit: 2 });
    assert.deepEqual(result.results.map((r: any) => r.task.id), ["target"]);
    assert.match(result.results[0].matchingPassage, /CERT-123/);
    assert.equal(result.index.complete, true);
    assert.ok(f.fetches <= 30);
    const all: any = await f.search.search({ query: "CERT-123", includeCompleted: true, limit: 3 });
    assert.equal(new Set(all.results.map((r: any) => r.task.id)).size, 3);
    assert.ok(all.results.some((r: any) => r.task.id === "done"));
  } finally { await f.close(); }
});

test("metadata changes reuse embeddings; shrinking notes deletes obsolete chunks", async () => {
  const f = fixture();
  try {
    f.add("a", { notes: "notes ".repeat(1200) }); await f.search.sync();
    const before = f.embeds;
    const task = f.add("a", { notes: "notes ".repeat(1200), status: "completed" });
    await f.search.mutate(async () => task, (t) => ({ listId: "list", task: t }));
    assert.equal(f.embeds, before);
    const short = f.add("a", { notes: "short" });
    await f.search.mutate(async () => short, (t) => ({ listId: "list", task: t }));
    const m = f.manifest();
    assert.equal(f.vectors.collections.get(m.collection)!.size, 1);
    assert.equal(m.dirty, false);
    assert.equal(fs.statSync(path.join(f.dir, "search-index.json")).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test("failed full fetch never prunes inventory or advances freshness", async () => {
  const f = fixture();
  try {
    f.inventoryHook = async () => { throw new Error("initial page unavailable"); };
    await assert.rejects(f.search.search({ query: "a" }), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal((error.details!.index as any).complete, false);
      assert.equal((error.details!.index as any).lastFullSync, null);
      return true;
    });
    f.inventoryHook = undefined;
    f.add("a"); await f.search.sync(); const before = f.manifest();
    f.tasks.clear(); f.advance(86400000);
    f.inventoryHook = async () => { throw new Error("page 2 unavailable"); };
    await assert.rejects(f.search.sync());
    const after = f.manifest();
    assert.equal(after.lastFullSync, before.lastFullSync);
    assert.equal(Object.keys(after.records).length, 1);
    assert.equal(after.dirty, true);
    await assert.rejects(f.search.search({ query: "a" }), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.match(error.message, /index incomplete/);
      assert.equal((error.details!.index as any).pendingReconciliation, true);
      assert.equal((error.details!.index as any).lastFullSync, before.lastFullSync);
      return true;
    });
    f.inventoryHook = undefined; await f.search.sync();
    assert.equal(f.vectors.collections.get(before.collection)!.size, 0);
  } finally { await f.close(); }
});

test("Google success during vector outage survives restart and retries partial writes", async () => {
  const f = fixture();
  try {
    f.add("a", { notes: "old" }); await f.search.sync();
    f.vectors.fail = "upsert";
    const fresh = f.add("a", { notes: "new ".repeat(2500) });
    const result = await f.search.mutate(async () => fresh, (t) => ({ listId: "list", task: t }));
    assert.equal(result.notes, fresh.notes);
    assert.equal(f.manifest().dirty, true);
    // Revert to the old fingerprint after an uncommitted Qdrant overwrite.
    f.add("a", { notes: "old" }); f.vectors.fail = undefined; f.restart(); await f.search.sync();
    const m = f.manifest();
    assert.equal(m.dirty, false);
    assert.equal(f.vectors.collections.get(m.collection)!.size, 1);
    assert.match([...f.vectors.collections.get(m.collection)!.values()][0].payload.text, /old/);
  } finally { await f.close(); }
});

test("failed obsolete-point cleanup stays dirty and recovers", async () => {
  const f = fixture();
  try {
    f.add("a", { notes: "x".repeat(5000) }); await f.search.sync();
    f.vectors.fail = "remove"; f.add("a", { notes: "short" });
    await f.search.mutate(async () => f.tasks.get(taskKey("list", "a"))!.task,
      (task) => ({ listId: "list", task }));
    assert.equal(f.manifest().dirty, true);
    f.vectors.fail = undefined; f.restart(); await f.search.sync();
    assert.equal(f.vectors.collections.get(f.manifest().collection)!.size, 1);
  } finally { await f.close(); }
});

test("lost collection and changed model force embeddings; rebuild stays namespaced", async () => {
  const f = fixture();
  try {
    f.add("a"); await f.search.sync(); const before = f.embeds, collection = f.manifest().collection;
    f.vectors.collections.delete(collection);
    await f.search.search({ query: "a" }); assert.ok(f.embeds > before);
    f.vectors.collections.set("unrelated", new Map());
    await f.search.sync(true); assert.notEqual(f.manifest().collection, collection);
    assert.ok(f.vectors.collections.has("unrelated"));
    const changed = new SearchService(f.store, { ...f.c, search: { ...f.c.search!, embeddingModel: "different-model" } },
      { source: f.source, embeddings: f.embeddings, vectors: f.vectors });
    await changed.sync(); assert.notEqual(f.manifest().collection, collection);
    await changed.stop();
  } finally { await f.close(); }
});

test("mutations and sync serialize Google requests, preserving write ordering", async () => {
  const f = fixture();
  try {
    f.add("a"); await f.search.sync();
    const gate = deferred(), entered = deferred(); const order: string[] = [];
    const a = f.search.mutate(async () => {
      assert.equal(f.manifest().dirty, true); order.push("a started"); entered.resolve(); await gate.promise;
      return f.add("a", { title: "first" });
    }, (task) => ({ listId: "list", task }));
    await entered.promise;
    const sync = f.search.sync();
    const b = f.search.mutate(async () => { order.push("b started"); return f.add("a", { title: "second" }); },
      (task) => ({ listId: "list", task }));
    await Promise.resolve(); assert.deepEqual(order, ["a started"]);
    gate.resolve(); await Promise.all([a, sync, b]);
    assert.equal(f.manifest().records[taskKey("list", "a")].task.title, "second");
  } finally { await f.close(); }
});

test("queued operations capture account at invocation and cannot run after reconnect", async () => {
  const f = fixture();
  try {
    f.add("a"); await f.search.sync();
    const gate = deferred(), entered = deferred();
    f.getHook = async () => { entered.resolve(); await gate.promise; };
    const query = f.search.search({ query: "a" }); await entered.promise;
    let called = false;
    const mutation = f.search.mutate(async () => { called = true; return {}; });
    const rejects = [assert.rejects(query, /account changed/i), assert.rejects(mutation, /account changed/i)];
    const before = fs.readFileSync(path.join(f.dir, "search-index.json"), "utf8");
    f.store.clearGoogleTokens(); f.connect(); gate.resolve(); await Promise.all(rejects);
    assert.equal(called, false);
    assert.equal(fs.readFileSync(path.join(f.dir, "search-index.json"), "utf8"), before);
    f.getHook = undefined; await f.search.sync();
    assert.notEqual(f.manifest().identity, JSON.parse(before).identity);
  } finally { await f.close(); }
});

test("candidate refetch repairs text and deletion; failed verification is an error", async () => {
  const f = fixture();
  try {
    f.add("a", { title: "needle old" }); f.add("b", { title: "needle" }); await f.search.sync();
    f.add("a", { title: "needle current" }); f.tasks.delete(taskKey("list", "b"));
    const result: any = await f.search.search({ query: "needle", limit: 10 });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].task.title, "needle current");
    assert.match(result.results[0].matchingPassage, /current/);
    assert.doesNotMatch(result.results[0].matchingPassage, /old/);
    assert.equal(result.retrieval.repaired, 2);
    f.getHook = async () => { throw new SearchError("Google task verification failed. Retry later."); };
    await assert.rejects(f.search.search({ query: "needle" }), /verification failed/);
    f.getHook = undefined; f.vectors.fail = "query";
    await assert.rejects(f.search.search({ query: "needle" }), /unavailable/);
  } finally { await f.close(); }
});

test("Google pagination port includes hidden/completed, all lists, and distinguishes 404", async () => {
  const f = fixture();
  try {
    const calls: any[] = [];
    const api = {
      tasklists: { async list(p: any) { calls.push(p); return { data: p.pageToken ? { items: [{ id: "b" }] } : { items: [{ id: "a" }], nextPageToken: "next" } }; } },
      tasks: {
        async list(p: any) { calls.push(p); return { data: p.pageToken ? { items: [{ id: "done", status: "completed", hidden: true }] } : { items: [{ id: "live" }, { id: "deleted", deleted: true }], nextPageToken: "next" } }; },
        async get(p: any) { throw { response: { status: p.task === "gone" ? 404 : p.task === "unauthorized" ? 401 : 503 } }; },
      },
    } as unknown as tasks_v1.Tasks;
    const source = googleSource(f.store, f.c, () => api);
    const inventory = await source.inventory();
    assert.equal(inventory.length, 4);
    assert.deepEqual([...new Set(inventory.map((t) => t.listId))], ["a", "b"]);
    assert.ok(calls.filter((p) => p.tasklist).every((p) => p.showCompleted && p.showHidden && p.showDeleted && p.showAssigned));
    assert.equal(await source.get("a", "gone"), null);
    await assert.rejects(source.get("a", "bad"), /verification failed/);
    await assert.rejects(source.get("a", "unauthorized"), (error: any) => error.response?.status === 401);
  } finally { await f.close(); }
});

test("HTTP adapter contracts validate embeddings, collection dimensions, waits and filters", async () => {
  const c = loadConfig({ SEARCH_ENABLED: "true", QDRANT_API_KEY: "fake-key" }).search!;
  const requests: { url: string; init: RequestInit; body: any }[] = [];
  let exists = false, malformed = false;
  const http: Http = async (url, init = {}) => {
    const u = String(url), body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: u, init, body });
    if (u.endsWith("/api/embed")) return Response.json({ embeddings: malformed ? [[NaN]] : body.input.map(() => [1, 0]) });
    if (init.method === "PUT" && !u.includes("/points") && !u.includes("/index")) { exists = true; return Response.json({ result: true }); }
    if (!init.method || init.method === "GET") return exists ? Response.json({ result: { config: { params: { vectors: { size: 2, distance: "Cosine" } } } } }) : new Response("", { status: 404 });
    if (u.includes("/query")) return Response.json({ result: { points: [] } });
    return Response.json({ result: { status: "completed" } });
  };
  const embeddings = ollama(c, http), vectors = qdrant(c, http);
  assert.deepEqual(await embeddings.embed(["title"]), [[1, 0]]);
  assert.equal(requests[0].body.truncate, false);
  assert.deepEqual(requests[0].body.input, ["title: none | text: title"]);
  await embeddings.embed(["find something"], "query");
  assert.deepEqual(requests.at(-1)!.body.input, ["task: search result | query: find something"]);
  malformed = true; await assert.rejects(embeddings.embed(["title"]));
  assert.equal(await vectors.ensure("private", 2), true);
  assert.equal(await vectors.ensure("private", 2), false);
  await assert.rejects(vectors.ensure("private", 3), /mismatch/);
  await vectors.query("private", [1, 0], { query: "q", tasklistIds: ["list"], dueMin: "2026-10-01T00:00:00Z" }, 20);
  const query = requests.at(-1)!;
  assert.equal((query.init.headers as any)["api-key"], "fake-key");
  assert.equal(query.body.filter.must.length, 3);
  await vectors.remove("private", ["id"]); assert.match(requests.at(-1)!.url, /wait=true/);
});

test("production MCP handlers hook every mutation, preserve successes and expose search", async () => {
  const f = fixture();
  try {
    f.add("a"); await f.search.sync();
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const server = { registerTool(name: string, _schema: unknown, handler: any) { handlers.set(name, handler); } } as unknown as McpServer;
    let writes = 0;
    const taskWrite = async () => { writes++; assert.equal(f.manifest().dirty, true); return { data: f.add("a", { title: `write ${writes}` }) }; };
    const api = { tasks: { insert: taskWrite, patch: taskWrite, move: taskWrite, delete: taskWrite, clear: taskWrite },
      tasklists: { insert: taskWrite, delete: taskWrite } } as unknown as tasks_v1.Tasks;
    registerTools(server, f.store, f.c, { search: f.search, tasks: () => api });
    f.vectors.fail = "upsert";
    for (const name of ["create_task", "update_task", "complete_task", "move_task", "delete_task", "clear_completed_tasks", "create_task_list", "delete_task_list"]) {
      const result = await handlers.get(name)!({ tasklistId: "@default", taskId: "a", title: "title" });
      assert.notEqual(result.isError, true, name);
    }
    assert.equal(writes, 8); f.vectors.fail = undefined;
    const result = await handlers.get("search_tasks")!({ query: "write", limit: 10 });
    assert.equal(JSON.parse(result.content[0].text).results.length, 1);
    const embeddingsBeforeSync = f.embeds;
    const synchronized = await handlers.get("sync_search_index")!({}); assert.notEqual(synchronized.isError, true);
    assert.equal(f.embeds, embeddingsBeforeSync, "manual sync reuses unchanged embeddings");
    const rebuilt = await handlers.get("rebuild_search_index")!({}); assert.notEqual(rebuilt.isError, true);
    assert.ok(f.embeds > embeddingsBeforeSync, "forced rebuild regenerates embeddings");
    const disabled = new Map<string, any>();
    registerTools({ registerTool(n: string, _s: any, h: any) { disabled.set(n, h); } } as unknown as McpServer,
      f.store, { ...f.c, search: { ...f.c.search!, enabled: false } }, { tasks: () => api });
    assert.equal((await disabled.get("search_tasks")({ query: "q" })).isError, true);
  } finally { await f.close(); }
});

test("failed durable dirty write prevents Google mutation", async () => {
  const f = fixture();
  try {
    f.add("a"); await f.search.sync();
    fs.chmodSync(path.join(f.dir, "search-index.json"), 0o644);
    let called = false;
    await assert.rejects(f.search.mutate(async () => { called = true; return {}; }));
    assert.equal(called, false);
    fs.chmodSync(path.join(f.dir, "search-index.json"), 0o600);
  } finally { await f.close(); }
});

test("search config rejects malformed enabled endpoints and collection prefixes", () => {
  for (const extra of [{ QDRANT_URL: "file:///tmp/db" }, { EMBEDDING_URL: "http://user:pass@localhost" }, { QDRANT_COLLECTION_PREFIX: "../bad" }])
    assert.throws(() => assertConfig(loadConfig({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", SEARCH_ENABLED: "true", ...extra })));
});


test("assembled MCP protocol validates input and serves current search results", async () => {
  const f = fixture();
  const server = new McpServer({ name: "tasks", version: "test" });
  const client = new Client({ name: "test-client", version: "test" });
  try {
    f.add("a", { title: "Renew gateway certificate" });
    registerTools(server, f.store, f.c, { search: f.search });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "search_tasks"));
    const result: any = await client.callTool({ name: "search_tasks", arguments: { query: "certificates" } });
    assert.notEqual(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).results[0].task.title, "Renew gateway certificate");
    const invalid: any = await client.callTool({ name: "search_tasks", arguments: { query: "", limit: 999 } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await server.close(); await f.close(); }
});

test("startup, daily schedule and dirty retry share one service and shutdown drains it", async (t) => {
  const f = fixture();
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    f.add("a"); f.search.start(); f.search.start();
    await f.search.search({ query: "a" }); assert.equal(f.inventoryCalls, 1);
    f.advance(86400000); t.mock.timers.tick(60000);
    await f.search.search({ query: "a" }); assert.equal(f.inventoryCalls, 2);
    f.vectors.fail = "upsert";
    const task = f.add("a", { title: "changed" });
    await f.search.mutate(async () => task, (value) => ({ listId: "list", task: value }));
    assert.equal(f.manifest().dirty, true);
    f.vectors.fail = undefined; t.mock.timers.tick(60000);
    await f.search.search({ query: "a" }); assert.equal(f.manifest().dirty, false);
    const gate = deferred(), entered = deferred();
    f.getHook = async () => { entered.resolve(); await gate.promise; };
    const running = f.search.search({ query: "a" }); await entered.promise;
    let stopped = false;
    const stop = f.search.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    gate.resolve(); await running; await stop;
    const before = f.inventoryCalls; t.mock.timers.tick(86400000);
    assert.equal(f.inventoryCalls, before);
    await assert.rejects(f.search.search({ query: "a" }));
  } finally { t.mock.timers.reset(); await f.close(); }
});


test("canonical metadata fingerprints ignore object key order and preserve array order", () => {
  const first = { id: "a", title: "Task", links: [{ link: "url", description: "text" }] };
  const second = { links: [{ description: "text", link: "url" }], title: "Task", id: "a" };
  assert.deepEqual(fingerprints(first, "model"), fingerprints(second, "model"));
  assert.notEqual(fingerprints({ ...first, links: [{ link: "a" }, { link: "b" }] }, "model").metadataHash,
    fingerprints({ ...first, links: [{ link: "b" }, { link: "a" }] }, "model").metadataHash);
});


test("late pruning failure preserves dirty recovery and last successful freshness", async () => {
  const f = fixture();
  try {
    f.add("a"); f.add("b"); await f.search.sync(); const before = f.manifest();
    f.tasks.clear(); f.advance(86400000);
    const remove = f.vectors.remove.bind(f.vectors); let deletions = 0;
    f.vectors.remove = async (c, ids) => {
      if (ids.length && ++deletions === 2) throw new Error("second deletion unavailable");
      await remove(c, ids);
    };
    await assert.rejects(f.search.sync());
    const failed = f.manifest();
    assert.equal(failed.dirty, true);
    assert.equal(failed.lastFullSync, before.lastFullSync);
    assert.equal(f.vectors.collections.get(failed.collection)!.size, 1);
    f.vectors.remove = remove; f.restart(); await f.search.sync();
    assert.equal(f.vectors.collections.get(f.manifest().collection)!.size, 0);
    assert.equal(f.manifest().dirty, false);
  } finally { await f.close(); }
});

test("repairing one candidate does not change another candidate's semantic passage", async () => {
  const f = fixture();
  try {
    f.add("a", { title: "first" });
    f.add("b", { title: "second", notes: "boring ".repeat(300) + "SEMANTIC-PASSAGE" });
    await f.search.sync(); f.add("a", { title: "changed first" });
    const m = f.manifest(), points = f.vectors.collections.get(m.collection)!;
    const a = m.records[taskKey("list", "a")].pointIds[0];
    const b = m.records[taskKey("list", "b")].pointIds[1];
    f.vectors.query = async () => [a, b].map((id) => ({ id, score: 1, payload: points.get(id)!.payload }));
    const result: any = await f.search.search({ query: "abstractconcept", limit: 2 });
    assert.equal(result.retrieval.repaired, 1);
    assert.match(result.results[1].matchingPassage, /SEMANTIC-PASSAGE/);
  } finally { await f.close(); }
});


test("dense ranking retrieves synonyms without lexical overlap", async () => {
  const f = fixture();
  try {
    f.add("unrelated", { title: "Book a summer holiday" });
    f.add("relevant", { title: "Rotate gateway certificate" });
    f.embeddings.embed = async (texts: string[]) => texts.map((text) =>
      /certificate|TLS credential/.test(text) ? [1, 0] : [0, 1]);
    f.restart();
    const result: any = await f.search.search({ query: "TLS credential", limit: 1 });
    assert.equal(result.results[0].task.id, "relevant");
  } finally { await f.close(); }
});

test("search and rebuild preserve reconnect handling while transient errors retain credentials", async () => {
  const f = fixture();
  try {
    f.add("a"); await f.search.sync();
    const handlers = new Map<string, any>();
    registerTools({ registerTool(n: string, _s: any, h: any) { handlers.set(n, h); } } as unknown as McpServer,
      f.store, f.c, { search: f.search });
    f.getHook = async () => { throw { response: { status: 503 } }; };
    const temporary = await handlers.get("search_tasks")({ query: "a" });
    assert.equal(temporary.isError, true); assert.ok(f.store.snapshot().account);
    f.getHook = async () => { throw { response: { status: 401 } }; };
    const revoked = await handlers.get("search_tasks")({ query: "a" });
    assert.match(revoked.content[0].text, /Reconnect/); assert.equal(f.store.snapshot().account, null);
    const disconnected = await handlers.get("search_tasks")({ query: "a" });
    assert.match(disconnected.content[0].text, /Reconnect/);
    f.connect(); f.inventoryHook = async () => { throw new Error("invalid_grant"); };
    const rebuild = await handlers.get("rebuild_search_index")({});
    assert.match(rebuild.content[0].text, /Reconnect/); assert.equal(f.store.snapshot().account, null);
  } finally { await f.close(); }
});

test("background authorization failure invalidates only current credentials and stops retrying", async (t) => {
  const f = fixture(); t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    f.inventoryHook = async () => { throw new Error("invalid_grant"); };
    f.search.start(); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.store.snapshot().account, null);
    assert.equal(f.inventoryCalls, 1);
    t.mock.timers.tick(86400000); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.inventoryCalls, 1);
    f.connect();
    const gate = deferred(), entered = deferred();
    f.inventoryHook = async () => { entered.resolve(); await gate.promise; throw new Error("invalid_grant"); };
    t.mock.timers.tick(60000); await entered.promise;
    const generation = f.store.snapshot().generation;
    f.connect(); gate.resolve(); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(f.store.snapshot().account);
    assert.equal(f.store.snapshot().generation, generation);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test("dependency diagnostics survive failed reconciliation without exposing response bodies", async () => {
  const f = fixture();
  try {
    const http: Http = async () => Response.json({ error: 'model missing-model not found; PRIVATE TASK CONTENT' }, { status: 404 });
    f.embeddings.embed = ollama(f.c.search!, http).embed;
    await assert.rejects(f.search.sync(), (error: SearchError) => {
      assert.match(error.message, /index incomplete/);
      assert.match(error.message, /Ollama embedding returned HTTP 404/);
      assert.match(error.message, /ollama pull/);
      assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /PRIVATE TASK CONTENT/);
      assert.equal(error.details?.dependency, "Ollama");
      assert.equal(error.details?.status, 404);
      assert.equal((error.details?.index as any).complete, false);
      return true;
    });
  } finally { await f.close(); }
});

test("dependency adapters distinguish unavailable services, timeouts and HTTP failures", async () => {
  const c = loadConfig({}).search!;
  const disconnected: Http = async () => { throw new TypeError("fetch failed: private URL"); };
  await assert.rejects(ollama(c, disconnected).embed(["task"]), /Ollama embedding request failed; check/);
  const timeout: Http = async () => { throw new DOMException("private", "TimeoutError"); };
  await assert.rejects(ollama(c, timeout).embed(["task"]), /timed out after 30 seconds/);
  const forbidden: Http = async () => new Response("private-key", { status: 403 });
  await assert.rejects(qdrant(c, forbidden).exists("private"), (error: SearchError) => {
    assert.match(error.message, /Qdrant collection lookup returned HTTP 403/);
    assert.equal(error.details?.status, 403);
    assert.doesNotMatch(error.message, /private-key/);
    return true;
  });
});

test("sync counts tasks rather than chunks, distinguishes reuse and metadata updates, and counts rebuilds", async () => {
  const f = fixture();
  try {
    f.add("long", { notes: "detail ".repeat(1500) });
    f.add("short");
    assert.deepEqual(await f.search.sync(), { lastFullSync: f.manifest().lastFullSync, indexedTasks: 2, embeddedTasks: 2, reusedTasks: 0 });
    assert.ok(f.embeds > 2, "multiple chunks and model probe do not inflate task count");
    assert.equal((await f.search.sync()).embeddedTasks, 0);
    f.add("short", { status: "completed" });
    const metadata = await f.search.sync();
    assert.equal(metadata.embeddedTasks, 0); assert.equal(metadata.reusedTasks, 2);
    f.add("short", { title: "changed text" });
    const changed = await f.search.sync();
    assert.equal(changed.embeddedTasks, 1); assert.equal(changed.reusedTasks, 1);
    f.tasks.delete(taskKey("list", "short"));
    const rebuilt = await f.search.sync(true);
    assert.equal(rebuilt.indexedTasks, 1); assert.equal(rebuilt.embeddedTasks, 1); assert.equal(rebuilt.reusedTasks, 0);
  } finally { await f.close(); }
});
