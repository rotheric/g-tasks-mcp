import { randomUUID } from "node:crypto";
import type { Configuration, SearchConfiguration } from "../config.js";
import type { Storage } from "../storage.js";
import { isGoogleAuthError, invalidateGoogleAuthorization } from "../google.js";
import { ManifestFile, type Manifest } from "./manifest.js";
import { chunks, eligible, fingerprints, FORMAT, hash, lexicalScore, passage, pointId, taskKey,
  type RecordTask, type SearchInput, type Task } from "./text.js";
import { googleSource, ollama, qdrant, SearchError, type TaskSource, type EmbeddingPort,
  type VectorPort, type Point } from "./ports.js";

const DAY = 86400000;
type Identity = { sub: string; generation: number };
export interface SyncCounts { indexedTasks: number; embeddedTasks: number; reusedTasks: number }
export type Change = { listId: string; task?: Task; deletedId?: string; deletedList?: boolean };
export interface SearchDependencies {
  source?: TaskSource;
  embeddings?: EmbeddingPort;
  vectors?: VectorPort;
  now?: () => number;
}
export class SearchService {
  private tail: Promise<unknown> = Promise.resolve();
  private manifest?: Manifest;
  private readonly file: ManifestFile;
  private readonly source: TaskSource;
  private readonly embeddings: EmbeddingPort;
  private readonly vectors: VectorPort;
  private readonly now: () => number;
  private readonly settings: SearchConfiguration;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private tickPending = false;
  constructor(private readonly store: Storage, c: Configuration, ports: SearchDependencies = {}) {
    if (!c.search?.enabled) throw new SearchError("Task search is disabled.");
    this.settings = c.search;
    this.file = new ManifestFile(c.dataDir);
    this.source = ports.source ?? googleSource(store, c);
    this.embeddings = ports.embeddings ?? ollama(c.search);
    this.vectors = ports.vectors ?? qdrant(c.search);
    this.now = ports.now ?? Date.now;
  }
  private identity(): Identity {
    const s = this.store.snapshot();
    if (!s.account || s.account.sub !== s.owner) throw new SearchError("No Google account connected");
    return { sub: s.account.sub, generation: s.generation };
  }
  private check(expected: Identity): void {
    if (hash(this.identity()) !== hash(expected)) throw new SearchError("Google account changed during search operation. Retry with a new authorization.");
  }
  private serial<T>(identity: Identity, operation: () => Promise<T>): Promise<T> {
    const work = this.tail.then(async () => {
      if (this.stopped) throw new SearchError();
      this.check(identity);
      const result = await operation();
      this.check(identity);
      return result;
    });
    this.tail = work.catch(() => {});
    return work;
  }
  private state(identity: Identity): Manifest {
    if (!this.manifest) this.manifest = this.file.read();
    const fingerprint = hash([FORMAT, this.settings.embeddingUrl, this.settings.embeddingModel, this.settings.embeddingQueryPrefix, this.settings.embeddingDocumentPrefix, this.settings.qdrantUrl, this.settings.collectionPrefix]);
    if (!this.manifest || this.manifest.identity !== hash(identity) || this.manifest.fingerprint !== fingerprint) {
      this.manifest = { version: 1, installation: this.manifest?.installation ?? randomUUID(),
        identity: hash(identity), fingerprint, epoch: 0, collection: "", dimension: 0,
        dirty: true, complete: false, lastFullSync: null, records: {}, orphanIds: [] };
    }
    const m = this.manifest;
    m.collection = `${this.settings.collectionPrefix}_${hash([m.installation, m.identity, m.fingerprint, m.epoch]).slice(0, 32)}`;
    return m;
  }
  private save(identity: Identity): void {
    this.check(identity);
    const m = this.state(identity);
    try { this.file.write(m); }
    catch (error) { m.dirty = true; m.complete = false; m.lastFullSync = null; throw error; }
  }
  private async external<T>(identity: Identity, promise: Promise<T>): Promise<T> {
    const result = await promise;
    this.check(identity);
    return result;
  }
  private async collection(identity: Identity): Promise<void> {
    const m = this.state(identity);
    if (!m.dimension) {
      const [probe] = await this.external(identity, this.embeddings.embed(["Task search"]));
      m.dimension = probe.length;
      this.save(identity);
    }
    if (!await this.external(identity, this.vectors.exists(m.collection))) {
      m.records = {};
      m.orphanIds = [];
      m.complete = false;
      m.lastFullSync = null;
      m.dirty = true;
      this.save(identity);
    }
    const created = await this.external(identity, this.vectors.ensure(m.collection, m.dimension));
    if (created) {
      m.records = {};
      m.orphanIds = [];
      m.complete = false;
      m.lastFullSync = null;
      m.dirty = true;
      this.save(identity);
    }
  }
  private payload(key: string, record: RecordTask, text: string): Point["payload"] {
    return { key, listId: record.listId, status: record.task.status ?? "needsAction", due: record.task.due ?? undefined, text };
  }
  private async put(identity: Identity, listId: string, task: Task): Promise<boolean> {
    if (!task.id) throw new SearchError();
    const m = this.state(identity);
    const key = taskKey(listId, task.id);
    if (task.deleted) { await this.remove(identity, key); return false; }
    const old = m.records[key];
    const text = chunks(task);
    const ids = text.map((_, i) => pointId(key, i));
    const record: RecordTask = { listId, task, ...fingerprints(task, m.fingerprint), pointIds: ids };
    const replay = ids.some((id) => m.orphanIds.includes(id));
    if (!replay && old?.embeddingHash === record.embeddingHash && old.metadataHash === record.metadataHash) return false;
    m.orphanIds = [...new Set([...m.orphanIds, ...ids, ...(old?.pointIds ?? [])])];
    this.save(identity);
    if (replay || old?.embeddingHash !== record.embeddingHash) {
      for (let offset = 0; offset < text.length; offset += 16) {
        const batch = text.slice(offset, offset + 16);
        const vectors = await this.external(identity, this.embeddings.embed(batch));
        if (vectors.some((v) => v.length !== m.dimension)) throw new SearchError("Embedding dimensions changed. Select a new model identifier and rebuild.");
        await this.external(identity, this.vectors.upsert(m.collection, batch.map((value, i) => ({
          id: ids[offset + i], vector: vectors[i], payload: this.payload(key, record, value),
        }))));
      }
    } else {
      for (let i = 0; i < ids.length; i++)
        await this.external(identity, this.vectors.payload(m.collection, [ids[i]], this.payload(key, record, text[i])));
    }
    await this.external(identity, this.vectors.remove(m.collection, (old?.pointIds ?? []).filter((id) => !ids.includes(id))));
    m.records[key] = record;
    this.save(identity);
    return replay || old?.embeddingHash !== record.embeddingHash;
  }
  private async remove(identity: Identity, key: string): Promise<void> {
    const m = this.state(identity);
    const record = m.records[key];
    if (!record) return;
    await this.external(identity, this.vectors.remove(m.collection, record.pointIds));
    delete m.records[key];
    this.save(identity);
  }
  private async cleanup(identity: Identity): Promise<void> {
    const m = this.state(identity);
    const live = new Set(Object.values(m.records).flatMap((r) => r.pointIds));
    await this.external(identity, this.vectors.remove(m.collection, m.orphanIds.filter((id) => !live.has(id))));
    m.orphanIds = [];
    this.save(identity);
  }
  private async reconcile(identity: Identity): Promise<SyncCounts> {
    const m = this.state(identity);
    m.dirty = true;
    this.save(identity);
    // No pruning or embedding begins until the entire authoritative inventory is fetched.
    const inventory = await this.external(identity, this.source.inventory());
    await this.collection(identity);
    const seen = new Set<string>();
    const embedded = new Set<string>();
    for (const { listId, task } of inventory) {
      if (!task.id) throw new SearchError();
      seen.add(taskKey(listId, task.id));
      if (await this.put(identity, listId, task)) embedded.add(taskKey(listId, task.id));
    }
    for (const key of Object.keys(m.records))
      if (!seen.has(key)) await this.remove(identity, key);
    await this.cleanup(identity);
    m.lastFullSync = new Date(this.now()).toISOString();
    m.complete = true;
    m.dirty = false;
    this.save(identity);
    const indexedTasks = Object.keys(m.records).length;
    return { indexedTasks, embeddedTasks: embedded.size, reusedTasks: indexedTasks - embedded.size };
  }
  sync(rebuild = false): Promise<SyncCounts & { lastFullSync: string | null }> {
    const identity = this.identity();
    return this.serial(identity, async () => {
      const m = this.state(identity);
      if (rebuild) {
        m.epoch++;
        m.dimension = 0;
        m.records = {};
        m.orphanIds = [];
        m.complete = false;
        m.lastFullSync = null;
        m.dirty = true;
        this.save(identity);
      }
      const counts = await this.reconcile(identity);
      return { lastFullSync: m.lastFullSync, ...counts };
    }).catch((error) => this.failure(identity, error));
  }
  private failure(identity: Identity, error: unknown): never {
    this.check(identity);
    if (isGoogleAuthError(error)) throw error;
    const m = this.manifest;
    const incomplete = !m || !m.complete || m.dirty;
    throw new SearchError(incomplete
      ? `Task search index incomplete; reconciliation failed. ${error instanceof SearchError ? error.message : "Google Tasks inventory or local index update failed; check server configuration and retry."}`
      : error instanceof SearchError ? error.message : "Task search failed. Retry later.",
      { ...(error instanceof SearchError ? error.details : {}), index: { lastFullSync: m?.lastFullSync ?? null, complete: m?.complete ?? false,
        pendingReconciliation: m?.dirty ?? true } });
  }
  mutate<T>(operation: () => Promise<T>, change?: (result: T) => Change): Promise<T> {
    const identity = this.identity();
    return this.serial(identity, async () => {
      const m = this.state(identity);
      const wasDirty = m.dirty;
      m.dirty = true;
      this.save(identity);
      const result = await this.external(identity, operation());
      try {
        const update = change?.(result);
        if (update?.listId === "@default" && this.source.canonicalList)
          update.listId = await this.external(identity, this.source.canonicalList(update.listId));
        // Recovery or list-wide operations need a full authoritative scan.
        if (!update || update.listId === "@default" || !m.complete || wasDirty) await this.reconcile(identity);
        else {
          await this.collection(identity);
          if (!m.complete) await this.reconcile(identity);
          else {
            if (update.task) await this.put(identity, update.listId, update.task);
            if (update.deletedId) await this.remove(identity, taskKey(update.listId, update.deletedId));
            if (update.deletedList) {
              for (const [key, record] of Object.entries(m.records))
                if (record.listId === update.listId) await this.remove(identity, key);
            }
            await this.cleanup(identity);
            m.dirty = false;
            this.save(identity);
          }
        }
      } catch {
        // Google has committed. Preserve its result and durable reconciliation marker.
        m.dirty = true;
        try { this.save(identity); } catch { /* Pre-mutation marker is already durable. */ }
      }
      return result;
    });
  }
  search(input: SearchInput): Promise<unknown> {
    const identity = this.identity();
    return this.serial(identity, async () => {
      if (!input.query.trim() || input.query.length > 4000 ||
          !Number.isInteger(input.limit ?? 10) || (input.limit ?? 10) < 1 || (input.limit ?? 10) > 50 ||
          input.tasklistIds?.length === 0 ||
          [input.dueMin, input.dueMax].some((d) => d !== undefined && !Number.isFinite(Date.parse(d))) ||
          (input.dueMin && input.dueMax && Date.parse(input.dueMin) >= Date.parse(input.dueMax)))
        throw new SearchError("Invalid task search query or filters.");
      const m = this.state(identity);
      if (!m.complete || m.dirty || !m.lastFullSync || this.now() - Date.parse(m.lastFullSync) >= DAY)
        await this.reconcile(identity);
      if (!await this.external(identity, this.vectors.exists(m.collection))) await this.reconcile(identity);
      const [vector] = await this.external(identity, this.embeddings.embed([input.query], "query"));
      if (vector.length !== m.dimension) throw new SearchError();
      const limit = input.limit ?? 10;
      let count = Math.max(50, limit * 8);
      let hits = await this.external(identity, this.vectors.query(m.collection, vector, input, count));
      const uniqueCount = () => new Set(hits.filter((h) => m.records[h.payload?.key] && eligible(m.records[h.payload.key], input)).map((h) => h.payload.key)).size;
      while (hits.length === count && uniqueCount() < limit * 3 && count < 1000) {
        count = Math.min(count * 2, 1000);
        hits = await this.external(identity, this.vectors.query(m.collection, vector, input, count));
      }
      const dense = new Map<string, string>();
      for (const h of hits) {
        const record = m.records[h.payload?.key];
        if (record && eligible(record, input) && !dense.has(h.payload.key)) dense.set(h.payload.key, h.id);
      }
      const lexical = Object.entries(m.records).filter(([, r]) => eligible(r, input))
        .map(([key, r]) => ({ key, score: lexicalScore(r.task, input.query) }))
        .filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
      const scores = new Map<string, number>();
      for (const ranking of [[...dense.keys()], lexical.map((r) => r.key)])
        ranking.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + rank + 1)));
      const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const budget = Math.min(200, Math.max(30, limit * 4));
      const results: unknown[] = [];
      let verified = 0;
      let repaired = 0;
      const dirtyBefore = m.dirty;
      for (const [key, score] of ranked.slice(0, budget)) {
        const record = m.records[key];
        const task = await this.external(identity, this.source.get(record.listId, record.task.id!));
        verified++;
        let candidateRepaired = false;
        if (!task || task.deleted || fingerprints(task, m.fingerprint).metadataHash !== record.metadataHash) {
          m.dirty = true;
          this.save(identity);
          try {
            if (task && !task.deleted) await this.put(identity, record.listId, task);
            else await this.remove(identity, key);
            await this.cleanup(identity);
            m.dirty = dirtyBefore;
            this.save(identity);
            repaired++;
            candidateRepaired = true;
          } catch { m.dirty = true; throw new SearchError("Search candidate repair failed. Retry later."); }
        }
        if (task && eligible({ listId: record.listId, task }, input)) {
          const index = record.pointIds.indexOf(dense.get(key) ?? "");
          const text = chunks(task);
          results.push({ tasklistId: record.listId, task, matchingPassage:
            index >= 0 && !candidateRepaired && lexicalScore({ notes: text[index] }, input.query) >= lexicalScore({ notes: passage(task, input.query) }, input.query)
              ? text[index] : passage(task, input.query), score });
        }
        if (results.length === limit) break;
      }
      return { results, index: { lastFullSync: m.lastFullSync, complete: m.complete, pendingReconciliation: m.dirty },
        retrieval: { verified, repaired, candidateLimitReached: hits.length === count,
          verificationLimitReached: verified === budget && ranked.length > budget,
          scores: "reciprocal-rank fusion; relevance, not probability",
          rankingMayBeStale: repaired > 0 } };
    }).catch((error) => this.failure(identity, error));
  }
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => {
      if (this.tickPending || this.stopped) return;
      this.tickPending = true;
      let identity: Identity;
      try { identity = this.identity(); } catch { this.tickPending = false; return; }
      void this.serial(identity, async () => {
        const m = this.state(identity);
        const snapshot = this.store.snapshot();
        try {
          if (m.dirty || !m.lastFullSync || this.now() - Date.parse(m.lastFullSync) >= DAY)
            await this.reconcile(identity);
        } catch (error) {
          if (isGoogleAuthError(error) && snapshot.account) {
            invalidateGoogleAuthorization(this.store,
              { generation: snapshot.generation, revision: snapshot.account.revision });
          }
          throw error;
        }
      }).catch(() => {}).finally(() => { this.tickPending = false; });
    };
    this.timer = setInterval(tick, 60000);
    this.timer.unref();
    tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.tail;
  }
}
const services = new WeakMap<Storage, SearchService>();
export function searchFor(store: Storage, c: Configuration): SearchService | undefined {
  if (!c.search?.enabled) return undefined;
  let service = services.get(store);
  if (!service) { service = new SearchService(store, c); services.set(store, service); }
  return service;
}
