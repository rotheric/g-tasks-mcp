# Acceptance criteria

**AC-SEARCH-1** — Search retrieves semantic and lexical candidates across all indexed lists,
returns at most the requested number of unique tasks with list IDs and current Google fields,
and applies pending/completed, list and due filters after verification.
Spans modules: search, tools

**AC-SEARCH-2** — Direct title/notes embeddings are deterministic and bounded; long notes are
chunked without losing source text, shrinking tasks removes old chunks, metadata-only changes
avoid embedding calls, and model/index-format changes cannot reuse incompatible vectors.

**AC-SEARCH-3** — Full sync consumes all Google pages including hidden/completed tasks;
partial inventory fetch never deletes unseen inventory; fetch/index/cleanup failure never commits freshness. Pruning after a complete fetch is idempotent and remains dirty until all cleanup succeeds. Successful
reconciliation removes deleted tasks/lists. Startup/daily scheduling and dirty retries use one
shared serialized service.
Spans modules: search, runtime

**AC-SEARCH-4** — Every Google mutation durably dirties the index before its request. Google
success remains successful during index outages; failed/restarted indexing recovers through
reconciliation. Create/update/complete/move/delete/list-delete/clear hooks all participate.
Spans modules: search, tools

**AC-SEARCH-5** — Searches refetch bounded candidates, repair changed records and remove
confirmed deletions; Google verification failures and dependency outages cannot masquerade
as successful empty results. Incomplete index and freshness are reported explicitly.

**AC-SEARCH-6** — Account/generation isolation prevents prior-account results after disconnect,
including changes during async operations; Qdrant operations only touch namespaced collections.
Private manifest writes are atomic and mode 0600. Secrets/task text never appear in failure logs.
Spans modules: search, runtime, tools, google

**AC-SEARCH-7** — Search is enabled by default and configurable with an explicit disable override, includes a rebuild tool, and ordinary task
operations remain usable without embedding/Qdrant availability. Documentation explains host
versus VM URLs, required embedding model and honest verification limitations.

## Review amendment

AC-SEARCH-3 distinguishes incomplete inventory fetch (no pruning allowed) from acknowledged
pruning after a complete fetch (safe to retry if subsequent cleanup fails). There is no
cross-system transaction promise. This clarifies the original ambiguous “index failure” clause;
freshness and durable recovery guarantees remain unchanged. AC-SEARCH-5 error responses include
structured index completeness, pending reconciliation and last successful full sync.
