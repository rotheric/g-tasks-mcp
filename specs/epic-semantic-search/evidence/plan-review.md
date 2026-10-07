# Astra plan review

Model: gpt-6-astra. Disposition: proceed; no user blockers.

1. Serialize the complete mutation (durable marker → Google → indexing), not only index work.
   Implemented one shared queue; failed pre-write persistence prevents Google call.
2. Capture subject/generation at invocation, check before queued work and after external awaits.
   Implemented fences and shutdown drains queue before releasing storage.
3. Retain recovery state through acknowledged writes and obsolete-point cleanup. Persist attempted
   point IDs before writes; recovery re-embeds pending IDs even if source fingerprint reverted.
   Missing collections clear cached records and force reindex.
4. Filter candidate generation, aggregate chunks into unique task ranks, bound refill and verification,
   and report exhaustion. Preserve complete source text and recompute current matching passage.
