# Structural review — owner-auth assembled implementation

Date: 2026-10-05
Role: continuing structural reviewer (`gpt-5.6-sol`)
Disposition: **findings; remediation required before the automated gate is clean**

## Scope and method

Reviewed the assembled tracked and untracked implementation against `spec.md`, `acceptance-criteria.md`, `architecture.md`, `ownership-ledger.json`, both story verification-question files, and `AUTH-REFACTOR-PLAN.md`. The review included `src/auth/`, `src/setup.ts`, provider/storage/Google/application composition, tests, configuration, and documentation. The pre-existing `.mcp.json` was neither read nor attributed to this epic. Planning/review/spike artefacts were treated as workflow inputs rather than source changes. Real Google and host/harness checks remain knowingly pending and are not treated as waivers.

Independent checks:

- `npm test`: 25/25 pass.
- Direct state reproduction: an accepted Google token merge leaves `account.revision` unchanged, and a stale terminal failure with the captured revision then clears the newly merged account.
- Direct HTTP reproduction: a persisted confidential client whose `client_secret` field is absent passes schema reload and refreshes without a client secret (`/token` returned 200).
- Direct provider reproduction: an authorization code bound to a redirect exchanges successfully when `redirect_uri` is omitted.
- Direct HTTP reproduction: the custom authorization-server metadata response has no `Access-Control-Allow-Origin` for a configured browser origin.

## Findings

### SR-1 — A stale Tasks failure can disconnect credentials accepted by a newer Google refresh

- **Severity:** 8/10
- **Confidence:** 0.99
- **Locations:** `src/storage.ts:339`, `src/google.ts:29`, `src/tools.ts:65`
- **Trigger:** Tasks call A captures `{generation, account.revision}`. Concurrent call B refreshes Google credentials and the OAuth client's `tokens` event calls `mergeGoogleTokens`. Call A then completes with a terminal-looking 401/`invalid_grant`.
- **Consequence:** `mergeGoogleTokens` changes credentials without advancing `account.revision`. Call A's stale expected revision still matches, so `clearGoogleTokens(expected)` removes the freshly merged credentials, increments generation, clears approvals, and invalidates every grant. This is the exact stale-failure/competing-credential race forbidden by AC-FLOW-2 and the frozen evidence commitment.
- **Reproduction:** Starting at account revision 1, merge `{access_token: "fresh-a", refresh_token: "fresh-r"}` with expected revision 1; revision remains 1. Calling `clearGoogleTokens` with the pre-merge expectation leaves `account === null`.
- **Correction:** Make every accepted credential replacement/merge advance a credential revision and associate each in-flight Tasks request with the credential revision it actually used. Recreate or advance the cached Google client coherently after a merge. A completion from an older revision must be unable to merge tokens or disconnect a later revision. Add a production-path test with a paused old Tasks failure after a successful refresh merge, plus the inverse transient-failure case.

### SR-2 — Hosted mode accepts OAuth and MCP traffic over direct plaintext HTTP

- **Severity:** 8/10
- **Confidence:** 0.98
- **Locations:** `src/config.ts:60`, `src/app.ts:43`, `src/index.ts:20`
- **Trigger:** Configure `DEPLOYMENT_MODE=hosted`, an HTTPS `BASE_URL`, and a listener reachable directly (for example a proxy backend bound beyond loopback or exposed because of a firewall error). Send plain HTTP with the canonical Host header.
- **Consequence:** The process itself is an HTTP server and no middleware requires `req.secure` in hosted mode. `/token`, `/revoke`, registration, metadata, and bearer-protected `/mcp` accept direct plaintext traffic. Secure cookies limit the browser flow but do not protect confidential-client secrets, refresh tokens, or MCP bearer tokens sent by non-browser clients. An advertised HTTPS issuer therefore does not enforce the plan's no-insecure-remote-HTTP boundary.
- **Correction:** In hosted mode, reject requests unless Express considers the request secure after the explicitly configured trusted-proxy policy. Test direct HTTP rejection and acceptance of `X-Forwarded-Proto: https` only when the immediate proxy is trusted. Prefer/validate a loopback backend bind in the documented proxy topology where practical.

### SR-3 — Semantically corrupt confidential-client records fail open as public clients

- **Severity:** 8/10
- **Confidence:** 1.0
- **Locations:** `src/storage.ts:10`, `src/app.ts:120`; SDK adaptation dependency `server/auth/middleware/clientAuth.js:19`
- **Trigger:** A persisted client has `token_endpoint_auth_method: "client_secret_post"` but its `client_secret` verifier is missing. This can arise from a partial/manual semantic corruption that remains valid JSON.
- **Consequence:** `clientSchema` accepts the record and startup succeeds. The app's verifier adapter runs only when `client.client_secret` is present, and SDK client authentication likewise treats absence as a public client. A holder of that client's code or refresh token can use `/token` without the confidential secret. The reproduced refresh returned HTTP 200 after release/reload.
- **Correction:** Add schema-level cross-field validation: `client_secret_post` requires a verifier of the exact stored-hash form and a valid intentional expiry; `none` forbids both secret and secret expiry. Validate these invariants before returning a client to the SDK. Add a corrupt-state reload test that must fail before routes start.

### SR-4 — Authorization codes are reusable after failed redemption attempts

- **Severity:** 7/10
- **Confidence:** 1.0
- **Locations:** `src/provider.ts:61`, `src/provider.ts:70`, `test/smoke.test.ts:389`
- **Trigger:** Redeem a valid code using a wrong PKCE verifier, client, redirect, or resource, then retry the same code with correct parameters.
- **Consequence:** `challengeForAuthorizationCode` only reads the code. The code is deleted later inside `exchangeAuthorizationCode`, after SDK PKCE and other validation. The existing test intentionally performs four invalid attempts and then succeeds with that same code. This contradicts the reviewed invariant that codes are single-use with atomic transitions and gives an intercepted code repeated verifier attempts during its five-minute lifetime.
- **Correction:** Add an atomic bounded claim/burn transition invoked on the first authenticated redemption attempt, including an SDK PKCE failure, while preserving the challenge long enough for that one validation. Use distinct codes for independent invalid-dimension tests. Confirm concurrent redemptions permit at most one attempt to proceed.

### SR-5 — Code exchange does not require the exact bound redirect URI

- **Severity:** 6/10
- **Confidence:** 1.0
- **Locations:** `src/provider.ts:79`
- **Trigger:** Exchange a valid code and verifier while omitting `redirect_uri` from the token request.
- **Consequence:** The check rejects only a supplied mismatch. Omission succeeds even though every code stores an exact redirect and the reviewed contract requires redirect binding at code exchange. The direct provider reproduction returned an access token with `redirect === undefined`.
- **Correction:** Require `redirect_uri` and exact equality to `code.redirect` for these codes. Cover omission separately from mismatch through the real SDK HTTP handler.

### SR-6 — Legacy client registrations are discarded rather than migrated as untrusted registrations

- **Severity:** 5/10
- **Confidence:** 0.99
- **Locations:** `src/storage.ts:212`, `test/storage.test.ts:124`
- **Trigger:** Run `migrate` with a legacy `clients.json` present.
- **Consequence:** The file is copied to quarantine, an empty v2 state is committed, and the legacy original is removed. No validated registrations are copied into `state.clients`. This conflicts with the reviewed migration contract to preserve registrations while discarding all approval/session assumptions, and forces every client to register again. The test creates no legacy clients file with usable registrations, so it cannot detect the loss. Migration also lacks the required before/after durable-replacement fault injection.
- **Correction:** Parse the supported legacy registration format under strict validation, re-store accepted registrations with current verifier rules and no approvals/grants/tokens, and quarantine/reject entries that cannot be migrated safely. Add migration boundary fault injection and rerun/idempotence checks containing clients, credentials, and legacy sessions.

### SR-7 — The custom authorization-server metadata route breaks browser CORS supplied by the SDK

- **Severity:** 5/10
- **Confidence:** 1.0
- **Locations:** `src/app.ts:164`
- **Trigger:** A browser-based MCP client on a configured `BROWSER_ORIGINS` origin fetches `/.well-known/oauth-authorization-server`.
- **Consequence:** The app's custom route shadows the SDK metadata handler but does not apply CORS. A direct HTTP check returned no `Access-Control-Allow-Origin`; the existing CORS test checks only protected-resource metadata, which is still served by the SDK. Browser clients cannot read the authorization-server metadata even though browser MCP origins are an advertised supported configuration.
- **Correction:** Serve the customized metadata through equivalent non-credentialed GET/OPTIONS CORS handling, or adapt the SDK metadata construction without shadowing its handler. Test AS and protected-resource metadata, preflight behavior, and exact advertised issuer/capabilities.

### SR-8 — A callback containing both `error` and `code` does not consume its state

- **Severity:** 5/10
- **Confidence:** 0.96
- **Locations:** `src/auth/browser.ts:374`, `src/auth/browser.ts:386`, `src/auth/browser.ts:389`
- **Trigger:** Call the Google callback with the correct browser session and state while supplying both `error` and `code`.
- **Consequence:** The mixed response is rejected before `t.state` is cleared or the stage advances, so the same state remains usable by a later callback. This misses the frozen checklist's mixed-response case and the plan's consume-before-exchange/single-use-state rule.
- **Correction:** Once transaction, browser session, expiry, and state match, atomically consume the state before classifying the Google response. Then reject mixed parameters and prove replay fails.

### SR-9 — Frozen interleaving and CLI guarantees are substantially broader than the executable evidence

- **Severity:** 6/10
- **Confidence:** 1.0
- **Locations:** `acceptance-criteria.md` frozen evidence section; `test/smoke.test.ts:532`; `test/storage.test.ts:72`; no setup/CLI test
- **Trigger:** Evaluate VQ-S1-090/VQ-S2-090 against the current suite.
- **Consequence:** The generated callback loop covers only a successful Tasks-provisioning exchange paused across disconnect/revoke/expiry/logout. It does not cover paused identity exchange, Google refresh success/invalid_grant/transient outcomes, disconnect/reconnect, revoke/new authorization, competing credential revisions, two-tab callback races, stale failures after a fresh success, or reloaded-store outcomes. Migration is omitted from replacement fault injection. Setup and administrative CLI behavior has no executable test. The 25 passing tests therefore cannot establish the quantified guarantees in AC-AUTH-2/AC-FLOW-2 or AC-AUTH-5, and the revision defect in SR-1 passes the named revision test.
- **Correction:** Add one compact stateful matrix/property harness over production transitions rather than one permanent test per VQ. Vary operation outcome, intervening transition, order, exact expiry, and reload; assert both absence of stale access and preservation of fresh intentional authorization. Add focused CLI process tests for stop-first locking, noninteractive refusal, setup callback binding, and administrative effects. Do not infer live Google/harness behavior from these mocked tests.

### SR-10 — Corrupt-state documentation promises recovery from a backup the store does not create

- **Severity:** 4/10
- **Confidence:** 0.95
- **Locations:** `src/storage.ts:181`, `README.md` administration/recovery text, `AUTH-REFACTOR-PLAN.md` persistence requirements
- **Trigger:** The sole `state-v2.json` becomes corrupt after a prior valid commit.
- **Consequence:** Startup correctly fails closed, but normal state replacement never writes a private last-known-good backup. The only backup logic is the legacy quarantine. README directs the operator to recover from a private backup that this implementation does not produce, leaving no application-managed recovery path.
- **Correction:** Either implement an atomic private last-known-good backup policy with defined crash semantics and tests, or revise the reviewed storage contract and documentation through an explicit disposition. A backup must never become an automatic fail-open fallback.

## Structural observations and ledger proposal

The auth policy is reasonably concentrated in `auth/policy.ts`, `BrowserAuthorization`, and `Storage`; there is no generic workflow engine. The hashed-secret SDK shim in `app.ts` is necessarily version-sensitive but small. The custom metadata route and duplicated global/SDK rate limiting are additional adapter surface; keep the former only if SDK metadata cannot be configured, and document which limiter owns each bound.

Proposed ownership-ledger change for the lead to apply after remediation: expand durable account state from generation alone to explicitly own **credential revision** as an invariant: every accepted credential mutation advances it, and every asynchronous producer/consumer commits or retires state only against the exact revision it used. Add the confidential-client method/verifier/expiry relationship as an auth-owned persisted invariant rather than leaving it implicit in SDK behavior.

## Gate assessment

This pass is not clean. SR-1 through SR-5 and SR-3's persisted-schema path are release-blocking automated defects. SR-6 through SR-10 require correction or an explicit evidence-backed disposition before VQ-S1-090/VQ-S2-090 and the corresponding acceptance criteria can be answered YES. Pending MV-1/MV-2 remain separate release gates after these offline defects are remediated.

## Focused remediation recheck — round 1

Date: 2026-10-05
Disposition: **original findings remediated; one new release blocker and one hosted-configuration residual remain**

The source was frozen for this bounded recheck. I reread the original spec, acceptance criteria, VQs and this report, inspected the remediations, and independently ran:

- `npm test`: 76/76 pass, including the generated async matrix, production Tasks lifecycle cases, CLI/setup process tests, migration fault boundaries, schema corruption and backup behavior.
- `npm run typecheck`: pass for source and tests.
- `npm run build`: pass.
- Direct diagnostic reproduction: Node 22 `JSON.parse("secret-refresh-token")` and Zod enum validation both include the supplied sentinel in `Error.message`.

### Original-finding dispositions

| Finding | Disposition | Recheck evidence |
| --- | --- | --- |
| SR-1 | Remediated | Accepted token merges advance account revision; stale merges and stale terminal clears are rejected. Storage and production Tasks tests cover refresh/reconnect/new-authorization races and reload. |
| SR-2 | Remediated | Hosted middleware rejects non-secure requests before routes; `req.secure` becomes true only through the configured trusted proxy. Direct and trusted-forwarded cases are tested. |
| SR-3 | Remediated | Persisted client schema ties method to hash/expiry and rejects secrets on public clients; missing/plaintext/expiry/public-secret corruptions fail during reload. |
| SR-4 | Remediated | Provider opts out of SDK-local PKCE, removes the code synchronously before locally checking verifier/client/redirect/resource/current state, and concurrent HTTP redemption yields one success and one failure. |
| SR-5 | Remediated | Exact redirect is mandatory; omission and mismatch each burn their own code and fail through the SDK HTTP handler. |
| SR-6 | Remediated | Migration validates supported legacy registrations, hashes confidential secrets, preserves no approvals/grants/tokens, quarantines originals, and passes before/after replacement fault tests. |
| SR-7 | Remediated | Custom authorization-server metadata now supplies noncredentialed GET/OPTIONS CORS; AS and protected-resource metadata are both exercised. |
| SR-8 | Remediated | Matching state/session is consumed before mixed `error`+`code` classification; the replay fails. Setup-browser state is likewise single-use. |
| SR-9 | Remediated | Evidence now covers delayed identity and provisioning outcomes across reconnect, new authorization, logout, exact expiry and credential revision with reload; production Tasks races, two tabs, restart, setup browser and stopped-service CLI paths are included. The matrix is broad because the frozen AC quantifies over these combinations, rather than one test per VQ. |
| SR-10 | Remediated | Each replacement keeps a private atomic previous-state backup; corrupt primary state never loads it automatically. Recovery instructions require inspection, restoration while stopped and immediate disconnect before restart. |

The provider's local code-verifier adaptation is acceptably narrow for SDK 1.29.0: the SDK still authenticates clients and validates request shape, while the provider owns the consume-first invariant that the SDK's split challenge/exchange interface could not enforce. The credential-revision and persisted-client invariants are now present in the ownership ledger.

### SR-11 — Persisted parse/schema failures can print corrupt secret material at startup

- **Severity:** 5/10
- **Confidence:** 1.0
- **Locations:** `src/storage.ts:186`, `src/storage.ts:306`, `src/index.ts:41`
- **Trigger:** `state-v2.json` or legacy `clients.json` contains malformed JSON or a schema-invalid enum/value that includes token or secret material, then startup or migration fails.
- **Consequence:** `Storage.load` and legacy parsing propagate raw `JSON.parse`/Zod errors, and the top-level CLI prints `err.message`. Node's malformed-JSON diagnostic and Zod's invalid-enum diagnostic include received text verbatim. A sentinel placed in corrupt persisted content therefore reaches service/CLI stderr, violating the redaction invariant even though the store correctly fails closed.
- **Correction:** Catch persisted JSON/schema parsing at the storage boundary and throw a generic actionable storage/migration error whose message contains no persisted content. Do not log the raw cause. Add a spawned CLI/startup test asserting a distinctive sentinel is absent from stderr while the command fails nonzero.

### SR-12 — Hosted mode without a trusted proxy passes startup validation but cannot serve any request

- **Severity:** 3/10
- **Confidence:** 0.98
- **Locations:** `src/config.ts:60`, `src/app.ts:44`, `test/setup.test.ts:85`
- **Trigger:** Set hosted mode and HTTPS `BASE_URL` while omitting `TRUST_PROXY`.
- **Consequence:** `assertConfig` accepts the configuration, but the process is a plain HTTP server and every request is rejected by the hosted `req.secure` check. The test currently treats this hosted configuration as valid. This fails closed, but defers a deterministic deployment error until runtime requests and contradicts the plan's statement that hosted operation uses explicit trusted proxy addresses.
- **Correction:** Require a nonempty, valid explicit trusted-proxy list in hosted mode, or introduce and validate a real direct-TLS listener mode. Update the configuration test and README table so an accepted hosted configuration is operational.

### Recheck gate assessment

SR-11 remains a release-blocking automated defect because the frozen quality questions require redacted failures. SR-12 is a lower-severity hosted deployment validation defect and should be corrected before claiming hosted configuration support. All ten original findings are closed by inspected implementation plus executable evidence. MV-1 and every applicable MV-2 harness path remain pending exactly as declared; this recheck does not close them.

## Focused remediation recheck — round 2

Date: 2026-10-05
Disposition: **clean — no actionable structural findings remain in the automated implementation**

This final bounded pass inspected only SR-11 and SR-12 on the frozen source/tests/docs snapshot.

- **SR-11 remediated.** `Storage.readPersisted` now owns file read, JSON parsing and schema validation for primary state, legacy client records and lock-owner records. It returns a fixed actionable error without retaining persisted content in the logged message. Startup and migration sentinel tests cover malformed JSON, schema-invalid received values and legacy parsing; all fail nonzero, omit the sentinel from stdout/stderr and remove the writer lock.
- **SR-12 remediated.** Hosted configuration now requires a nonempty `TRUST_PROXY` list and accepts only explicit IP addresses or syntactically bounded IPv4/IPv6 CIDRs. Missing proxy configuration, invalid prefix lengths and symbolic hostnames fail startup validation. Runtime evidence distinguishes an untrusted explicit proxy address from trusted loopback and accepts `X-Forwarded-Proto: https` only through the latter. README hosted instructions require canonical Host, forwarded HTTPS protocol and explicit proxy IPs/subnets.

Independent verification on this snapshot:

- `npm test`: **77/77 pass**.
- `npm run typecheck`: pass for source and tests.
- `npm run build`: pass.

The structural pass is clean. The previously recorded SR-1 through SR-12 findings are closed. MV-1 and the applicable MV-2 Google/harness paths remain explicit live release gates and were outside this offline recheck; clean structural status does not waive them.

## Focused remediation recheck — round 3

Date: 2026-10-05
Disposition: **clean — fresh-review F1/F2 remediations preserve the structural invariants**

This bounded pass inspected only F1 and F2 from `fresh-adversarial-review.md` and their round-3 remediation on the frozen source/tests/docs snapshot.

- **F1 remediated without weakening replay protection.** `Storage.prune` deletes a family only after it is permanently inactive or expired, then removes every access/refresh record orphaned by that deletion. Both issuance and rotation prune before applying global capacity checks. Active families retain all spent refresh hashes, so an unrelated retired-family cleanup cannot remove evidence needed to detect replay. Reuse and history-bound transitions first retire the affected family; a later intentional authorization reclaims it and creates an independent random family rather than reactivating any record. The 105-cycle matrix covers refresh-token revocation, client revocation and disconnect/reconnect, reloads the store, proves every historical access and refresh token remains invalid, and proves fresh issuance works. Focused replay and per-family history tests distinguish active evidence retention from retired cleanup.
- **F2 remediated consistently with the installed proxy parser.** Proxy CIDR validation now requires a positive decimal prefix within the address-family bound, rejecting IPv4 and IPv6 `/0` as well as malformed/oversized prefixes. Ordinary explicit IPs and supported nonzero CIDRs remain accepted. This prevents a configuration that passes `assertConfig` and then fails while Express compiles `trust proxy`.

Independent verification on this snapshot:

- `npm test`: **80/80 pass**.
- `npm run typecheck`: pass for source and tests.
- `npm run build`: pass.

No regression or additional actionable structural finding was found in this bounded recheck. The structural pass remains clean. MV-1 and applicable MV-2 live Google/host/harness gates remain pending and unwaived.

## Focused remediation recheck — round 4

Date: 2026-10-05
Disposition: **clean — fresh-final-review FFR-1/FFR-2 are closed without browser-lifecycle regression**

This bounded pass inspected only the two browser findings in `fresh-final-review.md` and their correction paths on the frozen source/tests snapshot.

- **FFR-1 remediated.** The shared transaction-validity check now prunes expired sessions before every transition decision. The post-Google-await check therefore removes sessions at `now >=` either idle or absolute expiry, which also removes their transactions and issued codes before identity-session mutation, durable Tasks provisioning, approval persistence or code issuance. `complete()` performs the same validity check again. Production HTTP clock tests keep a session active through 7h59m, pause both identity and Tasks callbacks, resume at the exact eight-hour boundary, and establish a 400 response, unchanged/reload-stable durable state, rejection of the expired capability and successful fresh intentional authorization.
- **FFR-2 remediated.** Cookie creation and deletion share one policy source. Hosted deletion for `__Host-gtasks` includes `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no Domain and no creation `maxAge`, while Express supplies the expiry deletion marker. The hosted assembled HTTP test observes creation/deletion headers through an explicitly trusted HTTPS proxy and also proves the deleted server session cannot continue its flow.

Independent verification on this snapshot:

- `npm test`: **83/83 pass**.
- `npm run typecheck`: pass for source and tests.
- `npm run build`: pass.

No regression or actionable structural blocker was found in these correction paths. The structural pass remains clean. MV-1 and applicable MV-2 live Google/browser/host/harness gates remain pending and unwaived.

## Focused remediation recheck — round 5

Date: 2026-10-05
Disposition: **clean — exact confidential-client secret expiry is enforced at the shared client-authentication boundary**

This bounded pass inspected only the confidential-client secret-expiry correction and its regression path on the frozen source/tests snapshot.

- **The exact-boundary finding is remediated.** `Storage.verifySecret` requires `client_secret_expires_at > floor(now / 1000)`, so a secret is rejected at `now >= expiry`. The shared `/token` and `/revoke` adapter invokes that verifier before translating an authenticated plaintext secret to the stored hash for SDK 1.29.0. The SDK's weaker exact-boundary comparison therefore cannot readmit an expired secret, while public clients remain on their no-secret path.
- The production HTTP test proves a confidential authorization-code exchange succeeds immediately before expiry, then at the exact expiry second code exchange, refresh and revocation are all rejected with HTTP 400 without mutating grant/token state. Existing access remains governed by its own lifecycle boundary. Reload preserves the expired-secret result and unchanged state.

Independent verification on this snapshot:

- `npm test`: **84/84 pass**.
- `npm run typecheck`: pass for source and tests.
- `npm run build`: pass.

No regression or actionable structural blocker was found in this correction path. The structural pass remains clean. MV-1 and applicable MV-2 live Google/browser/host/harness gates remain pending and unwaived.

## Final bounded pre-commit structural review

Date: 2026-10-05
Disposition: **clean for the requested checkpoint — no actionable regression found**

This pass reviewed the final auth/HTTP and operational deltas: direct Google owner login, retained signed-owner approval, mutation-only Origin enforcement, transaction-specific consent CSP, fixed diagnostic categories, SDK `iss` error adaptation, the dependency repair hook, Make/launchd commands, and the consolidated canonical specification and host-validation guide.

- A fresh browser session enters nonce/state-bound identity login directly, but verified identity alone creates no approval, grant, code or Tasks credential. The callback returns to explicit client approval; an already authenticated owner may approve or deny a new client without another identity round trip. CSRF, current revision, browser session and exact callback/resource checks remain on the committing transitions.
- `Referrer-Policy: same-origin` restores native same-origin form provenance. Origin enforcement covers browser mutations while navigational Google callbacks remain authenticated by their single-use state, cookie, nonce and transaction. The consent CSP derives its sole client origin from the already validated callback and permits the known Google origin needed by browser redirect handling. Logged authorization reasons come from a fixed internal allowlist.
- The `/authorize` response adapter adds `iss` only to SDK-generated error redirects that match the validated client callback origin and path. It does not decorate upstream Google redirects; successful callbacks continue to receive `iss` in `BrowserAuthorization`.
- The lifecycle dependency hook probes the platform-sensitive build tool in a fresh process and runs lockfile-based `npm ci` recovery when needed. npm lifecycle entry points and Make targets use that hook; the launchd installer derives escaped absolute executable, checkout and log paths and stops an existing job before replacement. Canonical docs now include the direct-login amendment, real upgrade commands, dependency-install isolation, and explicit pending live gates.

Independent verification on the reviewed snapshot:

- `npm test`: **86/86 pass**.
- `npm run typecheck`: pass for source and tests.
- `npm run build`: pass.
- Source/test/script/documentation diff check: pass after normalizing this report's historical Markdown line endings.
- The platform repair hook detected an incompatible dependency tree and completed `npm ci`; subsequent test, typecheck and build all succeeded.
- Recorded real host evidence reaches authenticated SDK discovery and 11 tools twice, including the revised direct-login flow. Recorded synthetic Chromium evidence covers fresh identity, approval and denial.

This clean disposition supports the explicitly requested checkpoint commit. It does not mark the epic complete or waive the remaining Google, Claude Code lifecycle, Desktop, hosted and other-harness observations recorded in `host-validation.md`.
