import { google } from "googleapis";
import type { tasks_v1 } from "googleapis";
import type { Configuration, SearchConfiguration } from "../config.js";
import type { Storage } from "../storage.js";
import { getAuthorizedGoogleClient, isGoogleAuthError } from "../google.js";
import type { Task, SearchInput } from "./text.js";

export class SearchError extends Error {
  constructor(message = "Task search unavailable. Retry later or rebuild the search index.",
    readonly details?: Record<string, unknown>) {
    super(message);
  }
}
export interface InventoryTask { listId: string; task: Task }
export interface TaskSource {
  inventory(): Promise<InventoryTask[]>;
  get(listId: string, taskId: string): Promise<Task | null>;
  canonicalList?(listId: string): Promise<string>;
}
export function googleSource(store: Storage, c: Configuration,
  api: () => tasks_v1.Tasks = () => google.tasks({ version: "v1", timeout: 30000, auth: getAuthorizedGoogleClient(store, c) }),
): TaskSource {
  return {
    async canonicalList(listId) {
      if (listId !== "@default") return listId;
      const id = (await api().tasklists.get({ tasklist: listId })).data.id;
      if (!id) throw new SearchError();
      return id;
    },
    async inventory() {
      try {
        const client = api();
        const lists: string[] = [];
        let pageToken: string | undefined;
        do {
          const r = await client.tasklists.list({ maxResults: 100, pageToken });
          for (const list of r.data.items ?? []) {
            if (!list.id) throw new SearchError();
            lists.push(list.id);
          }
          pageToken = r.data.nextPageToken ?? undefined;
        } while (pageToken);
        const tasks: InventoryTask[] = [];
        for (const listId of lists) {
          pageToken = undefined;
          do {
            const r: { data: tasks_v1.Schema$Tasks } = await client.tasks.list({ tasklist: listId, maxResults: 100, pageToken,
              showCompleted: true, showHidden: true, showDeleted: true, showAssigned: true });
            for (const task of r.data.items ?? []) {
              if (!task.id) throw new SearchError();
              if (!task.deleted) tasks.push({ listId, task });
            }
            pageToken = r.data.nextPageToken ?? undefined;
          } while (pageToken);
        }
        return tasks;
      } catch (error) {
        if (isGoogleAuthError(error) || error instanceof SearchError) throw error;
        const status = (error as { response?: { status?: unknown } })?.response?.status;
        throw new SearchError(`Google Tasks inventory request failed${typeof status === "number" ? ` (HTTP ${status})` : ""}. Retry after checking Google connectivity and quota.`,
          { dependency: "Google Tasks", operation: "inventory", ...(typeof status === "number" ? { status } : {}) });
      }
    },
    async get(listId, taskId) {
      try {
        return (await api().tasks.get({ tasklist: listId, task: taskId })).data;
      } catch (e) {
        if (isGoogleAuthError(e)) throw e;
        if ((e as { response?: { status?: number } }).response?.status === 404) return null;
        throw new SearchError("Google task verification failed. Retry later.");
      }
    },
  };
}
export interface Point { id: string; vector: number[]; payload: { key: string; listId: string; status: string; due?: string; text: string } }
export interface Hit { id: string; score: number; payload: Point["payload"] }
export interface VectorPort {
  ensure(collection: string, dimension: number): Promise<boolean>;
  exists(collection: string): Promise<boolean>;
  upsert(collection: string, points: Point[]): Promise<void>;
  payload(collection: string, ids: string[], payload: Point["payload"]): Promise<void>;
  remove(collection: string, ids: string[]): Promise<void>;
  query(collection: string, vector: number[], input: SearchInput, limit: number): Promise<Hit[]>;
}
export interface EmbeddingPort { embed(texts: string[], kind?: "document" | "query"): Promise<number[][]> }
export type Http = typeof fetch;

function dependencyError(dependency: string, operation: string, error: unknown): SearchError {
  if (error instanceof SearchError) return error;
  const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
  return new SearchError(`${dependency} ${operation} ${timeout ? "timed out after 30 seconds" : "request failed; check the configured endpoint and that the service is running"}.`,
    { dependency, operation, reason: timeout ? "timeout" : "connection_or_response" });
}
async function json(http: Http, url: string, init: RequestInit, dependency: string, operation: string): Promise<any> {
  try {
    const response = await http(url, { ...init, signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      let hint = "";
      if (dependency === "Ollama") {
        // Classify known errors without exposing arbitrary response bodies or task text.
        const body = await response.json().catch(() => ({}));
        if (typeof body.error === "string") {
          if (/model.*(not found|does not exist)/i.test(body.error)) hint = " Pull the configured model with ollama pull.";
          else if (/context length|input length|too long/i.test(body.error)) hint = " The embedding input exceeds the model context length.";
        }
      }
      throw new SearchError(`${dependency} ${operation} returned HTTP ${response.status}.${hint}`,
        { dependency, operation, status: response.status });
    }
    return await response.json();
  } catch (error) { throw dependencyError(dependency, operation, error); }
}
export function ollama(c: SearchConfiguration, http: Http = fetch): EmbeddingPort {
  return {
    async embed(texts, kind = "document") {
      const r = await json(http, `${c.embeddingUrl}/api/embed`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: c.embeddingModel, input: texts.map((text) => (kind === "query" ? c.embeddingQueryPrefix : c.embeddingDocumentPrefix) + text), truncate: false }),
      }, "Ollama", "embedding");
      const vectors = r.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== texts.length ||
          vectors.some((v: unknown) => !Array.isArray(v) || !v.length || v.some((n) => typeof n !== "number" || !Number.isFinite(n))) ||
          vectors.some((v: number[]) => v.length !== vectors[0].length)) throw new SearchError("Ollama returned invalid embedding vectors.", { dependency: "Ollama", operation: "embedding", reason: "invalid_vectors" });
      return vectors;
    },
  };
}
export function qdrant(c: SearchConfiguration, http: Http = fetch): VectorPort {
  const headers = { "Content-Type": "application/json", ...(c.qdrantApiKey ? { "api-key": c.qdrantApiKey } : {}) };
  const url = (collection: string, suffix = "") => `${c.qdrantUrl}/collections/${encodeURIComponent(collection)}${suffix}`;
  const request = async (collection: string, suffix: string, method: string, body?: unknown) =>
    json(http, url(collection, suffix), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, "Qdrant", `${method} ${suffix || "collection"}`);
  async function exists(collection: string): Promise<boolean> {
    try {
      const r = await http(url(collection), { headers, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return false;
      if (!r.ok) throw new SearchError(`Qdrant collection lookup returned HTTP ${r.status}.`,
        { dependency: "Qdrant", operation: "collection lookup", status: r.status });
      return true;
    } catch (error) { throw dependencyError("Qdrant", "collection lookup", error); }
  }
  return {
    exists,
    async ensure(collection, dimension) {
      if (await exists(collection)) {
        const r = await request(collection, "", "GET");
        const vectors = r.result?.config?.params?.vectors;
        if (vectors?.size !== dimension || vectors?.distance !== "Cosine") throw new SearchError("Search collection configuration mismatch. Change the collection prefix and rebuild.");
        return false;
      }
      await request(collection, "", "PUT", { vectors: { size: dimension, distance: "Cosine" } });
      for (const [field_name, field_schema] of [["listId", "keyword"], ["status", "keyword"], ["due", "datetime"]]) {
        await request(collection, "/index?wait=true", "PUT", { field_name, field_schema });
      }
      return true;
    },
    async upsert(collection, points) {
      if (points.length) await request(collection, "/points?wait=true", "PUT", { points });
    },
    async payload(collection, ids, payload) {
      if (ids.length) await request(collection, "/points/payload?wait=true", "PUT", { points: ids, payload });
    },
    async remove(collection, ids) {
      if (ids.length) await request(collection, "/points/delete?wait=true", "POST", { points: ids });
    },
    async query(collection, vector, input, limit) {
      const must: unknown[] = [];
      if (input.tasklistIds) must.push({ key: "listId", match: { any: input.tasklistIds } });
      if (!input.includeCompleted) must.push({ key: "status", match: { value: "needsAction" } });
      if (input.dueMin || input.dueMax) must.push({ key: "due", range: { ...(input.dueMin ? { gte: input.dueMin } : {}), ...(input.dueMax ? { lt: input.dueMax } : {}) } });
      const r = await request(collection, "/points/query", "POST", { query: vector, limit, with_payload: true,
        ...(must.length ? { filter: { must } } : {}) });
      if (!Array.isArray(r.result?.points)) throw new SearchError();
      return r.result.points;
    },
  };
}
