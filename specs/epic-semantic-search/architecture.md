# Architecture

Ports/adapters with a serialized process-shared search service.

- search: src/search/* owns private manifest, fingerprints, chunks, ranking, Qdrant/Ollama ports,
  Google inventory and verification, account fences and serialization.
- tools: src/tools.ts owns MCP schemas and all task mutation delegation.
- google: src/google.ts owns shared authorization-failure classification and guarded invalidation.
- runtime: src/index.ts owns scheduled service start/stop; src/app.ts shares the registry service.

Frozen seam: SearchService.mutate(operation, change?) captures identity before queueing,
marks dirty durably before operation, then indexes successful responses without hiding Google success.
SearchService.search(input) verifies candidates; sync(rebuild?) commits only complete scans.
All operations share the same queue, including the Google mutation itself, avoiding scan/write races.
Dependencies: search may read Storage snapshot and use Google authorization; may not directly mutate auth state.
Tools consume search public methods only. Google/auth (src/google.ts) owns shared Google
error classification and guarded credential invalidation; search scheduler may invoke that
public contract, but does not write auth storage directly. Auth storage never imports search. No client-controlled endpoints.
No task text or credentials in error logs. Failed verification throws a generic typed search error.
Accepted risk: rebuilding embeddings; no guarantee for edits outside MCP until daily sync.
Live host services are outside sandbox verification; adapter tests verify protocol contracts.
