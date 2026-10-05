# Independent Astra review: authentication refactoring plan

Date: 2026-10-05. Reviewed artifact: the draft `AUTH-REFACTOR-PLAN.md` before incorporation of this review. Line references below refer to that draft. Scope: planning and evidence gathering only; no production implementation or plan changes.

## Verdict

**Revise before implementation approval.** The architecture addresses the repository's principal authorization defect and is substantially stronger than the existing implementation. It is suitable for implementation once the six P1 planning issues below have concrete dispositions. The remaining P2 issues should be incorporated into the implementation contract and acceptance tests. None requires multi-user accounts, a new authorization framework, JWT MCP tokens, or an immediate database migration to SQLite.

This verdict concerns the plan. It does not certify the current server, a future implementation, Google configuration, or any live client connection. The existing automatic authorization shortcut remains vulnerable until the coherent replacement ships.

## Evidence and method

I inspected the plan, `auth-spike.txt`, all authentication/configuration/storage application modules, `test/smoke.test.ts`, `README.md`, `package.json`, and the installed SDK's authorization, token, registration, revocation, metadata, client-authentication and bearer middleware. No applicable `AGENTS.md` was found in the workspace ancestry checked. No secrets, `.env`, `.mcp.json`, or stored account credentials were read.

The installed SDK is 1.29.0. Its source confirms that it verifies PKCE before calling the provider and passes resource arguments to code exchange and refresh. The current provider ignores those resource arguments. The spike's conclusions about automatic approval, credential replacement without identity verification, refresh scope expansion, incomplete revocation, permissive storage recovery, and unrestricted interface binding are supported by current source.

Read-only probes imported SDK functions without importing application configuration. They confirmed that:

- `redirectUriMatches` accepts different ports for matching loopback hosts and does not equate `localhost` with `127.0.0.1`.
- It also accepts differing fragments and ports for an HTTPS localhost pair; the application must reject invalid registration inputs before relying on this matcher.
- `OAuthClientMetadataSchema` accepts a non-loopback HTTP callback, a callback containing a fragment, `client_secret_basic`, an invented authentication-method name, and an omitted authentication method.

Primary Google, MCP, OAuth RFC and Claude documentation was checked directly. The report distinguishes source requirements from design recommendations. I did not rerun application tests or reproduce the spike's temporary application probes: this is a plan review, and those runs would not establish the missing browser or live-client guarantees.

## P1 findings: resolve before implementation approval

### R1. Consent ordering still depends on an undocumented identity-only exception

**Plan:** lines 131–159; open decision at 332–333.

The draft creates a transaction, sends an unauthenticated browser through Google OIDC, and only then obtains MCP approval. Separating identity login from Tasks provisioning is sound, and the proposed authenticated approval prevents the specific automatic-code-issuance defect. However, the cited MCP guidance describes approval before third-party authorization and places upstream state/session creation after consent; it does not state an identity-only exception. Calling the current order compliant is therefore stronger than the evidence supports. [MCP security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#confused-deputy-problem)

**Correction:** choose and document a complete sequence. A conservative sequence is: show the requesting client/callback/Tasks permissions; obtain a CSRF-protected, transaction-bound acknowledgement before redirecting to Google; verify the pinned owner through identity-only OIDC; obtain final authenticated approval; provision Tasks if needed; issue the MCP code. The initial acknowledgement is provisional and cannot create a grant or MCP code. Alternatively, justify a clearly separate owner-login flow against the chosen protocol guidance, without claiming an exception the source does not provide. Keep the two Google purposes distinct in either design.

**Acceptance:** a direct callback, manually initiated login, identity callback, or initial acknowledgement alone never authorizes a client. No Tasks provisioning state exists before authenticated approval. Record exactly which transition may create each upstream state record. This is a planning/compliance ambiguity, not evidence that the proposed identity-only callback is itself an exploitable bypass.

### R2. Separate credential files conflict with the atomic account-and-grant promise

**Plan:** lines 147–149 and 204–212.

The callback must atomically commit verified Google credentials and an approved grant, but the persistence section requires Google credentials in a separate file. Serializing writes and atomically renaming each file does not make two file replacements one transaction. A crash between writes can expose a grant whose account state was never committed, or activate account credentials without the matching lifecycle state. The same issue affects disconnect and migration. Current `src/storage.ts:138` shows why credential lifecycle must be part of the new consistency model.

**Correction:** choose the actual commit boundary now. The simplest option for this single-user process is one private, schema-versioned JSON state file containing account identity/generation, Google credentials, grants and token indexes. Transient browser state can remain in memory. Separate files are not inherently a security benefit when the same process and OS identity own both. If physical separation is retained, specify an immutable credential-blob plus atomic active-pointer protocol, or use a transactional store; do not describe independent renames as atomic together.

Specify local-filesystem support, lock ownership and stale-lock recovery, file and parent-directory durability where supported, and recovery after failure at each commit boundary. A crash must never cause legacy fallback or reactivate an older generation. Prefer the single-file solution over inventing a general journal solely to preserve file separation.

**Acceptance:** fault-inject before/after durable state replacement for provisioning, disconnect, rotation and migration; restart into either the old valid state or the new valid state, never a combination.

### R3. Generation checks need to cover pending authorization and terminal upstream failure

**Plan:** lines 61–67, 141–153, 189–200 and 218–219.

The draft correctly guards stale Google refresh events and says tokens cannot survive disconnect/reconnect. It does not define what happens to an already-approved provisioning request that is awaiting Google when a disconnect or client revocation occurs. Checking generation only on issued tokens is insufficient: a late callback could commit its account credentials and a fresh grant using the current generation after the operator disconnected. A similar race can recreate a client grant after `clients revoke` if the pending approval is not invalidated.

It also says to distinguish `invalid_grant` from network failures without specifying the terminal state transition. Clearing credentials without retiring the old generation leaves room for old MCP tokens to become usable after a later account reconnection.

**Correction:** bind every pending transaction, upstream callback and token operation to an account generation and relevant client/grant revision. Recheck them inside the serialized commit after asynchronous work completes. Disconnect invalidates pending flows as well as active grants. Client revocation invalidates pending approvals for that client. A later intentional authorization starts a new transaction and approval. Do not implement a permanent client ban unless explicitly desired.

Define confirmed upstream refresh `invalid_grant` as a durable disconnected/reconnect-required transition that retires the generation and invalidates grants and affected pending work. Timeouts and 5xx preserve credentials and grants and return a retryable operational failure. A stale failure from an obsolete Google client must not disconnect a newly provisioned account. A revoked Google token may be detected only on a subsequent upstream use/refresh; do not promise instantaneous knowledge of Google-side revocation.

**Acceptance:** pause Google exchange/refresh, disconnect or revoke, then resume it; no account/grant resurrection. Repeat with successful and failed stale responses, and after restarting. Define that already-started Google API operations may complete; revocation cannot undo a request already accepted by Google.

### R4. SDK validation is too permissive to be the entire client-registration policy

**Plan:** lines 131–135, 150–153, 239–257 and 261–263.

The phrase “SDK validates … registered redirect URI” hides application decisions. Installed `server/auth/handlers/authorize.js` deliberately relaxes loopback ports. `shared/auth.js` only excludes several dangerous URI schemes; it does not require HTTPS for remote callbacks or reject URI fragments. DCR accepts arbitrary authentication-method strings. Meanwhile `middleware/clientAuth.js` reads credentials only from the request body, and `router.js` advertises `client_secret_post` and `none`. An application can therefore register a client with a callback or method that the intended policy must not support.

Unencrypted non-loopback authorization callbacks conflict with the OAuth security BCP. Native loopback port variation is a defined exception to exact redirect matching. [RFC 9700 §2.6](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.6), [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3)

**Correction:** add explicit registration validation and matching policy: bounded nonempty callback list; HTTPS remote callbacks; deliberately supported HTTP loopback callbacks; no userinfo or fragment; no custom schemes unless a target client needs a reviewed policy. Specify the native loopback port exception, retain exact scheme/host/path/query matching, and snapshot the actual authorization callback into the transaction/code. For the simplest approval policy, an actual callback change prompts approval again even when registration permits a new native port. Google Web-client callback matching is separate and must not inherit this exception.

Allow only implemented client authentication methods. Handle omitted methods explicitly: RFC 7591 defaults omission to Basic, whereas this SDK does not implement Basic. Reject unsupported requests or return an explicit supported method in the registration response, with tested client behavior; do not preserve unusable metadata. Advertise public-client `none` consistently for revocation if supported. Set an intentional client-secret lifetime; the SDK defaults confidential registration secrets to 30 days, which otherwise surprises the proposed 90-day refresh families. [RFC 7591 §2](https://www.rfc-editor.org/rfc/rfc7591.html#section-2)

**Acceptance:** test unsafe callback registration, unsupported/default methods, public and confidential token/revocation requests, loopback host differences and ports, and exact code-exchange callback binding through real SDK HTTP handlers.

### R5. Setup and migration need a runnable bootstrap sequence

**Plan:** lines 95–103, 107–119, 221–229 and 328–329.

For local operation, reusing the registered `http://localhost:3789/oauth/google/callback` while the normal service is stopped is feasible. Hosted `BASE_URL`, however, currently controls the Google callback through `src/google.ts:8`. A loopback-only setup server will not automatically receive a callback to the public hosted origin. SSH forwarding transports a connection; it does not change Google's exact redirect-URI requirement. Google explicitly requires the configured redirect URI to match. [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)

Migration also asks for fresh Tasks provisioning before committing v2 and restarting, while the browser design permits provisioning only after an MCP client is approved. The draft does not identify a process that can run that approval flow during migration.

**Correction:** define a setup-specific callback independently of the runtime issuer. For hosted setup, document a browser on the operator's machine reaching the registered localhost callback through an explicitly bound SSH local forward to the temporary server. Require that localhost callback to be registered; reusing an existing registration is possible only if it actually exists. Do not mutate or advertise the runtime issuer to accommodate enrollment. The local initial landing route must establish browser binding before Google is opened. Noninteractive setup must fail clearly when terminal confirmation is required.

Split migration from Tasks provisioning: stop the old service; take a private backup; quarantine legacy credentials; enroll the owner; atomically commit v2 with a disconnected account, no old tokens and a completed migration marker; start the new server; approve the first MCP client and provision Tasks through the normal verified flow. A fresh disconnected v2 store is a legitimate migration result. An independently verified owner-sub override remains an explicit trusted alternative.

**Acceptance:** document and exercise both local and forwarded setup, port collision, missing redirect registration, interrupted migration, and rerun after v2 was committed but before first Tasks authorization. No fallback to legacy refresh credentials.

### R6. Administrative CLI writes conflict with exclusive server ownership

**Plan:** lines 198–208 and module `src/setup.ts`.

The plan gives the server exclusive ownership of `DATA_DIR` while offering `clients revoke` and `disconnect`, but it only describes mutual exclusion for setup. An independently launched CLI cannot safely rewrite the live server's state or in-memory indexes. Allowing it through the lock would reintroduce lost updates; honoring the lock without a documented workflow leaves the advertised administration unusable while the service runs.

**Correction:** choose stop-first administration for the minimal release: stop the managed service, acquire the same lock, run list/revoke/disconnect, then restart. Document stopping launchd/systemd in a way that prevents automatic respawn. Mutating commands fail clearly on a live lock. A local authenticated IPC control channel would be another valid design, but is unnecessary scope unless live administration is required. Apply the same policy to migration and owner enrollment.

**Acceptance:** a CLI command cannot write during server ownership, cannot steal a live lock, and its completed revocation is enforced after restart. Use the OAuth revocation endpoint for supported online token revocation. Distinguish server-side revocation from merely deleting a connector in a client UI, since a client may not call `/revoke`.

## P2 findings: incorporate into implementation and verification

### R7. Replace blanket CORS language with route-specific browser policy

**Plan:** lines 239–248.

“No wildcard CORS” is too broad for public, non-cookie OAuth endpoints used by browser clients. Installed SDK metadata, registration, token and revocation handlers deliberately use noncredentialed permissive CORS. Replacing this globally with same-origin checks can break legitimate browser harnesses without strengthening owner approval. Conversely, a same-origin cookie/session route must not inherit those endpoint policies.

Specify a route matrix: session/consent/administration use strict origin and CSRF policy; public discovery and non-cookie OAuth endpoints use deliberate noncredentialed CORS; `/mcp` validates any supplied Origin against supported browser origins and remains bearer-protected. Decide whether browser-based harnesses are in the release matrix. Include OPTIONS handling, allowed headers and exposure of `WWW-Authenticate` for them. Top-level Google GET callbacks may lack Origin and rely on session/state/nonce. Add `Referrer-Policy: no-referrer` on sensitive browser pages and avoid third-party page assets. Test that no CORS policy grants ambient-cookie access.

### R8. Add issuer response support and pin the exact compatibility contract

**Plan:** lines 170–180, 253–257 and 332–335.

The chosen MCP revision recommends authorization-response `iss`; if implemented, metadata must advertise it. The draft omits it. Add canonical-issuer `iss` to success and redirectable error responses, and `authorization_response_iss_parameter_supported: true`. The installed router emits a URL-normalized issuer with a trailing slash and its authorization handler builds some error redirects itself. The provider alone cannot cover every response. Use the identical advertised issuer string throughout and test handler-originated errors too. [MCP authorization](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/index.mdx), [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html)

Resource omission can remain an explicit single-resource compatibility policy without accepting a conflicting resource. Record the targeted revision and tested SDK version. SDK 1.29.0's HTTP issuer exception recognizes `localhost` and `127.0.0.1`, but not `[::1]`; do not claim arbitrary IPv6 loopback issuer support without handling that restriction. Interface support and advertised issuer support are different.

Current Claude documentation already describes “Register automatically” and “Use your own OAuth client” choices, so DCR availability is more than an unanswered documentation question. The remaining question is behavior of the actual account/version under test. “Use Claude's published identity” needs capabilities this draft deliberately defers. Document the DCR selection explicitly. Claude Code's documentation also records a localhost/127.0.0.1 callback change between versions; versioned validation is necessary. [Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp)

### R9. Finish the refresh-family contract rather than postponing its consequences

**Plan:** lines 176–200 and 330–331.

Rotation is appropriate for public clients; it is not unnecessary hardening. OAuth's security BCP requires public-client refresh replay protection through rotation or sender constraint. Strict reuse detection can force reauthorization after a lost response, an intentional availability tradeoff. [RFC 9700 §4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14)

Define approval record versus grant versus refresh family: does another successful authorization for the same tuple create a new grant/family, and exactly which access tokens does reuse invalidate? Choose explicit behavior instead of “family/grant.” Specify that a spent refresh token submitted to `/revoke` still finds and invalidates its live family/grant. Unknown or other-client tokens remain non-mutating success after requester authentication, matching the planned privacy behavior. Cascading refresh revocation is supported by the revocation RFC. [RFC 7009 §2](https://www.rfc-editor.org/rfc/rfc7009.html#section-2)

Commit rotation before returning tokens. Bound token/family history and garbage collection as well as registration/session counts; otherwise 90 days of rotation adds an unbounded persistent record stream. If family expiry invalidates access tokens too, cap issued `expires_in` at remaining family lifetime. With only the `tasks` scope, reject explicit empty or unknown scope deterministically and preserve `tasks` on omission; avoid implementing a general scope lattice for this release. Confirm missing-scope representation in the SDK: authorization omission becomes `[]`, while explicit empty becomes `[""]`.

### R10. Specify session rotation across tabs and acceptance boundaries

**Plan:** lines 123–129 and 286–307.

Rotating a session identifier after login while binding each pending transaction to the old identifier can invalidate other tabs. Preserve a stable internal session identity and atomically replace its external cookie identifier, or deliberately invalidate other tabs with a documented retry path. If multi-tab continuation is promised, transfer only still-valid transactions and never accept the old session cookie for authentication.

Add tests for two identity callbacks racing, logout during provisioning, approval followed by expiry during Google exchange, a callback containing both `error` and `code`, and a wrong-owner login while another owner session exists. Reject at the final transition, not solely when a callback first arrives. Exercise ID-token validation through the installed Google verifier with controlled signing keys and explicit nonce checking as planned. Upstream PKCE is useful defense in depth if supported by the selected Google flow/library; it does not replace state, nonce or owner validation.

## What should stay, and what should remain out of scope

Keep trusted owner pinning by Google `sub`, identity-only login, authenticated per-client approval, separate MCP/Google token purposes, opaque hashed MCP tokens, durable revocation/generation state, a minimal server-rendered UI, restrictive local binding, and explicit migration invalidation. These directly address evidenced defects. Google describes `sub` as the stable account identifier, and the plan correctly avoids using mutable email as the security key. [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)

The proposed module responsibilities are reasonable, but seven new files are a suggestion, not an acceptance criterion. Avoid a generic workflow engine, broad dependency-injection framework, generalized tenant model, tool-specific scopes, DPoP, native stdio, remote administration UI, and CIMD URL fetching in this refactor. A single private state file with one writer is proportionate if its crash behavior is explicit and tested. SQLite becomes appropriate if an actual consistency requirement cannot be kept simple.

The existing four smoke tests should be updated where they encode insecure behavior: the test expecting an immediate Google Tasks redirect must instead expect the new local consent/login boundary, and the test that seeds a legacy refresh token must not continue to authorize it. Tool-registration coverage should remain, using a valid v2 fixture. A green old smoke suite does not establish the new access boundary.

## Implementation readiness and live-validation limits

After R1–R6 are resolved and R7–R10 are folded into acceptance criteria, implementation can proceed through the proposed phases. Persistence and owner lifecycle decisions should precede browser code. Characterize SDK behavior before wrapping it; avoid a wholesale OAuth handler rewrite unless the chosen policy requires one.

Offline release evidence must include the central attacker scenario, verified wrong-account rejection without writes, code and refresh replay, cross-client revocation, restart/migration failure injection, malformed registration metadata, and the in-flight revocation races described above. Typecheck/build/behavioral tests must run with dependencies appropriate to the execution platform. This review adds only the read-only SDK probe evidence, not new application test claims.

The following remain live release blockers for the corresponding advertised path:

- Real Google Web credentials: exact local and hosted/setup callbacks, identity scopes and nonce, partial/denied Tasks consent, refresh-token issuance and preservation, wrong account, cancellation, and terminal refresh failure. `prompt=consent` is a request strategy; verify the returned credential response rather than assuming a refresh token. [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- Claude Code: actual version, localhost callback selection, DCR/client-auth method, approval/denial, tools, strict refresh rotation, restart, and server-side revoke/reconnect.
- Desktop local bridge: exact bridge version, OAuth token storage location, browser launch/callback, refresh/restart/revocation, and its required HTTP-loopback configuration.
- Desktop remote connector: actual client-setting selection, cloud access to hosted HTTPS, browser cookie flow, refresh and revocation. The local bridge and cloud connector are separate connection paths, as the plan correctly recognizes. [Claude networking requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- A second harness or SDK client: resource/scope omission, PKCE and callback variation. A browser harness is required only if browser-client compatibility is claimed.

No production code, deployment, live consent, live token rotation, or client connection was performed during this review. Mark any unavailable path as unvalidated or unsupported in the release documentation; do not use successful mocked tests as a substitute.

## Final disposition — 2026-10-05

**Verdict: ready to begin implementation against the revised plan.** This supersedes the initial draft's “revise before implementation approval” verdict. I reread the revised plan and checked all ten dispositions; all six P1 planning issues now have concrete resolutions:

| Finding | Final disposition |
| --- | --- |
| R1 | Resolved: provisional, browser-bound acknowledgement precedes Google identity; authenticated owner approval precedes Tasks provisioning; neither provisional acknowledgement nor identity alone creates a grant. |
| R2 | Resolved: account credentials and authorization state share one private atomic state file, with explicit durability, locking and crash-test requirements. |
| R3 | Resolved: final commits recheck account/client/credential revisions and expiry; revocation cancels pending work; current-generation `invalid_grant` retires the account without letting stale failures disconnect a newer account. |
| R4 | Resolved: application policy constrains callbacks, authentication methods and secret lifetime; metadata must match supported behavior. The deliberately limited HTTP numeric-loopback port exception is acceptable: approval binds the callback identity and each code binds the actual URI. This replaces my suggested simpler reapproval-on-every-port-change option. |
| R5 | Resolved: enrollment has a separately registered localhost callback and a concrete forwarded-browser path; migration commits disconnected v2 state before normal runtime provisioning. |
| R6 | Resolved: administration is stop-first, uses the same process lock, and prevents managed-service respawn while state is changed. |

R7–R10 are also incorporated: endpoint-specific CORS, consistent issuer responses including SDK errors, explicit Desktop DCR selection, defined grants/families and spent-token revocation, bounded rotation history, and session rotation/race coverage. No remaining planning blocker was identified in this focused check.

One implementation detail warrants explicit attention: storing confidential-client secret verifiers requires an authentication adapter that verifies the presented secret. The installed SDK's plaintext comparison cannot be used unchanged with a verifier stored in its `client_secret` field. The plan's commitment to adapt the necessary handlers and test confidential/public authentication covers this work; it does not require a new architecture.

This is approval of the implementation plan, not a claim that authentication has been fixed or that any client path works. Existing code remains unchanged. Real Google enrollment/provisioning, forwarded setup, strict-refresh interoperability, local bridge behavior and hosted Desktop connections remain release gates for their advertised paths. This final check performed no new application tests, live authorization, or broad documentation research.
