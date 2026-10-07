# Semantic task search

Provide bounded, relevant task retrieval to MCP clients without client-side inventory scans.
Google Tasks is authoritative. All writes are assumed to pass through this MCP; synchronize
writes immediately and reconcile the entire inventory daily. Reuse existing Qdrant.

## Plan

1. Add default-enabled search configuration and HTTP adapters for existing Qdrant and local Ollama
   embeddings. Defaults: Qdrant http://localhost:6333 (host runtime), Ollama
   http://localhost:11434, model embeddinggemma; deployment may override either URL.
   No automatic Docker lifecycle in this iteration because the user has existing Qdrant.
2. Embed deterministic title + notes directly. Short tasks use one point; long notes use
   paragraph-aware bounded chunks with title prefixes. Model-specific deterministic query/document prefixes are included in the fingerprint. No generated questions, summaries,
   list/parent text dependencies, or reranker. Combine semantic candidates with local lexical
   ranking over the synchronized inventory using reciprocal-rank fusion; clients never scan.
3. Keep an atomic private index manifest separate from authentication state: account subject
   and disconnect generation, last full sync, task metadata, embedding fingerprints and
   durable dirty state. Mark dirty BEFORE calling a Google mutation; successful responses
   update affected tasks, failures remain safely dirty. Recovery reconciles inventory.
4. Serialize index operations in one process-shared service (not per MCP request). Full sync
   follows every list/task page, including completed/hidden tasks, and only deletes unseen
   points after complete fetch. Failed sync does not advance freshness or serve as complete.
   Metadata-only updates reuse vectors. Chunk replacements remove obsolete points.
5. Add search_tasks(query, tasklistIds?, includeCompleted=false, dueMin?, dueMax?, limit=10).
   Rank and deduplicate task candidates, fetch a bounded oversampled set from Google,
   recheck current filters, repair changed hashes, remove deleted tasks. Return current tasks,
   matching passage, relevance score, last sync and completeness/repair limitations.
   Partial verification failure produces an error, never an empty successful result.
6. Start reconciliation on service startup and daily thereafter; retry dirty work every minute.
   Ordinary task tools remain usable when search dependencies fail. Search unavailable,
   incomplete index and no matches are distinguishable. Add authenticated rebuild_search_index
   for explicit recovery. Fence account/generation changes during async work and before return.
7. Add behavioral tests using injected HTTP/Google ports, including production MCP tool wiring,
   pagination, retries/restart, chunk cleanup, metadata-only changes, filters and isolation.
   Run typecheck/build and sandbox-compatible test runner; document unavailable host checks.
8. Astra reviews the plan, then implementation; fix findings and preserve evidence.

## Constraints and non-goals

Search enabled by default with explicit SEARCH_ENABLED=false override; no credentials or task data sent to an unspecified hosted model.
Model/endpoint/chunking changes change the collection fingerprint. Dedicated collection names
are scoped to this installation/account/generation, so shared Qdrant collections are not deleted.
Rebuildable embeddings are accepted; never reset unrelated collections. No generated answers.
No live host deployment or credential changes. Existing .mcp.json is unrelated user work.

## Verification

Automated adapter contract tests and assembled in-process MCP-tool smoke cover delivery.
Live Google/Qdrant/Ollama routing cannot be certified under network-restricted execution.
Mutation gate: skip — repository has no mutation framework; use focused behavioral failure
matrices rather than install an unrelated framework for this feature.

## Final review correction

Google authorization failures pass through to the existing guarded reconnect handler.
Background reconciliation delegates guarded credential invalidation to the Google/auth module;
transient failures preserve credentials. Default EmbeddingGemma uses prescribed retrieval
prefixes, configurable for other models. Prefix changes invalidate collection fingerprints.
Automated cosine-ranking tests discriminate semantic candidate ordering; live model relevance
is not certified without a host run.

## User amendment

Search defaults to enabled at the user’s explicit request. Local Ollama remains the
embedding provider. SEARCH_ENABLED=false remains an explicit compatibility override.
