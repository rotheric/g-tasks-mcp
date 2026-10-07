# Fresh Astra implementation review

Model gpt-6-astra. First pass: one P2, no P0/P1.

Google 401/invalid_grant was wrapped as a search error and bypassed reconnect handling.
Fixed by shared auth classification/invalidation, preservation of raw Google auth failures,
and guarded scheduler credential invalidation. Auth-first catch order covers already-disconnected
search too. Tests distinguish 503, verification/inventory revocation, background no-retry and
stale credential-revision failures. All 23 focused tests, typecheck and build pass.

Nonblocking quality observation addressed: default EmbeddingGemma document/query prefixes
are applied deterministically and fingerprinted. Cosine-ranking synonym test proves vector
ranking participates without lexical overlap. Live model relevance is still not certified.

The AC3 reconciliation amendment was accepted as consistent with original user intent.
Final fresh Astra recheck follows the clean continuing structural review.

Final fresh Astra disposition: clean. Independently ran 23/23 search tests, typecheck and
Git diff checks. One P3 story-contract ownership inconsistency was corrected: S2 declares
MCP schema/routing ownership; S3 declares integration verification with no owned production
API/files/data. Astra reread the corrected contracts and confirmed no outstanding findings.
No source changes followed the clean source review.
