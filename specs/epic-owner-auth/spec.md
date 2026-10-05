# Owner authenticated MCP access

This specification contains the complete reviewed implementation plan. The
independent Astra [plan review](evidence/plan-review.md) remains historical
planning evidence. Implementation acceptance and verification commitments are
in acceptance-criteria.md and the story verification files.

## User-requested flow amendment

After successful host authentication testing, the user requested removing the
initial sign-in acknowledgement page. New browser sessions redirect directly to
Google identity login; verified signed-in owners go directly to explicit client
approval. Approval precedes Google Tasks provisioning and MCP client access.
This amendment supersedes the plan's initial acknowledgement step. Existing
recorded approval remains reusable only with its original security bindings.

The user explicitly requested the implementation checkpoint commit. Remaining
manual observations stay recorded as pending, without an implied waiver or
complete release certification. See [host validation](host-validation.md).

## Google Tasks MCP authentication refactoring plan

Status: reviewed by Astra and ready to begin implementation.
Scope: planning only.
Date: 2026-10-05. Evidence: the pre-implementation authentication spike; its relevant conclusions are retained
in this specification and the plan review. The user authorized removing the
temporary spike file.

## Outcome and boundaries

Make the existing single-user HTTP MCP server usable by Claude Code, Claude
Desktop and other OAuth-capable harnesses without exposing the connected Google
account to arbitrary clients. A new client receives access only when the pinned
owner authenticates and explicitly approves it. Stored upstream credentials,
dynamic registration and application metadata never constitute user permission.

Keep Streamable HTTP, the existing Tasks tools and Google API integration. Keep
separate MCP tokens and Google tokens. Do not add multi-user tenancy, tool-level
read/write scopes, a public account signup system, or a second authentication
mode in this refactor. Native stdio is optional future work; document a local
bridge for Desktop. Hosted support means deployment configuration and validation,
not publishing or provisioning infrastructure as part of implementation.

Opaque MCP tokens remain appropriate; Google ID tokens establish browser user
identity and are not accepted as bearer tokens on /mcp. JWT issuance is unnecessary.

## Evidence and current defects

The installed SDK is 1.29.0 although package.json declares ^1.17.0. Its token
handler verifies PKCE and passes resource indicators to provider methods. An
unused provider code-verifier argument is therefore not itself a bypass.

Verified defects:

1. provider.authorize grants any registered client access when Google refresh
   credentials work, without owner identity or per-client approval.
2. Google callback writes credentials before identifying the account.
3. Requested resource indicators are ignored; tokens lack resource binding.
4. Refresh can expand scope; bearer middleware does not require Tasks scope.
5. Revocation removes only the named token, and ignores requesting-client ownership.
6. Callback expiration relies on pruning triggered by another authorization.
   There is no browser binding, nonce validation or authenticated approval UI.
7. Storage treats corrupt/unreadable JSON as empty and writes non-atomically.
   Creation modes do not repair permissions of existing files.
8. listen(port) binds without restricting interfaces, despite local-use docs.
9. Existing smoke tests cover happy-path discovery/auth, not these boundaries.

## Security invariants and threat model

Protect against a network visitor registering a client, misleading client names,
cross-site requests, replayed callbacks/codes, another Google account overwriting
Tasks credentials, stolen/revoked tokens, scope escalation, wrong-resource tokens,
host-header/DNS-rebinding attacks and lost updates during refresh callbacks.

An attacker with control of the owner's OS account or readable secret files is
outside the app's isolation boundary. Public endpoint availability still needs
bounded requests and rate limits; no claim of protecting against unrestricted DoS.

Invariants:

- Owner is pinned through trusted setup, never first unauthenticated HTTP login.
- Every active grant belongs to that owner, one client, exact permissions,
  approved redirects and this server's canonical MCP resource.
- Every token resolves to an active grant and the current account generation.
- All token/state expiry checks reject at now >= expiry, independently of cleanup.
- State, codes and approval submissions are single-use with atomic transitions.
- New or changed permissions/redirect identities require new approval; explicitly
  approved numeric-loopback callback ports may vary as described below.
- Identity-only login never modifies or merges Tasks credentials.
- Tasks provisioning verifies owner identity before committing credentials.
- Losing a browser session never grants permission; restart drops transient flows.
- No code, token, client secret or authorization header enters logs or UI errors.

## Proposed modules and responsibilities

Keep src/provider.ts as a thin OAuth SDK adapter; extract:

| Module | Responsibility |
| --- | --- |
| src/auth/domain.ts | Typed transactions, grants, tokens and state transitions |
| src/auth/service.ts | Authorization policy, issuance, refresh and revocation |
| src/auth/browser.ts | Session middleware, login/consent/callback routes |
| src/auth/views.ts | Small server-rendered, escaped login/consent/result pages |
| src/auth/google-identity.ts | OIDC URLs, code exchange and ID-token checks |
| src/auth/store.ts | Versioned atomic auth persistence and hashed-token lookup |
| src/setup.ts | Trusted owner enrollment and client management CLI |

src/google.ts retains Tasks client lifecycle; src/storage.ts either delegates
to new typed stores or becomes the persistence layer used by them. src/app.ts
composes routes, middleware and injected dependencies. src/config.ts validates
deployment, owner and URL configuration; src/index.ts handles binding/startup.
Prefer narrow dependency injection for clock, randomness, Google and storage,
so tests can simulate transitions without real credentials. Avoid a general DI
framework. Add dependencies only for an identified gap; reuse Google's library
for ID-token signature verification, explicitly checking nonce afterward.

## Owner enrollment and configuration

Use `g-tasks-mcp setup` as a trusted local command. It starts a temporary,
loopback-only browser flow, identifies the Google account, displays email/sub
to the terminal, and requires terminal confirmation before pinning its sub.
Setup cannot be invoked through HTTP. It does not issue MCP tokens. Its callback
is setup-specific, independent of runtime BASE_URL, defaulting to the existing
http://localhost:3789/oauth/google/callback. Register that exact URL with Google
and stop the normal service to reuse its port. Open a local setup landing page
first to establish browser binding, then Google. Noninteractive setup fails when
terminal confirmation is required. For hosted enrollment, bind an SSH local
forward on the browser machine's localhost:3789 to the setup server's loopback
port; Google's registered localhost callback travels through it. A hosted-only
callback registration is insufficient; the runtime issuer remains unchanged.
Fail clearly on port collision. Hosted operators run setup through a documented
loopback forwarding arrangement or explicitly configure an independently verified
OWNER_GOOGLE_SUB; never silently change the owner from a browser callback.
Setup, migration and all administrative CLI commands require the service to be
stopped and acquire the same DATA_DIR lock. No local IPC control server is added.

Configuration:

- GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET: reuse existing Web credentials.
- OWNER_GOOGLE_SUB: optional immutable override; conflict with stored owner fails.
- HOST: default 127.0.0.1; deliberate override for hosted operation.
- BASE_URL: explicit validated canonical issuer origin, with /mcp derived from it.
- DEPLOYMENT_MODE: local default or hosted; hosted requires HTTPS public BASE_URL.
- TRUST_PROXY: disabled by default; hosted uses explicit trusted proxy addresses.
- DATA_DIR: private, versioned persistence, existing default retained.

Validate port, origin (no credentials/query/fragment or ambiguous base path), host
and mode at startup. Local mode allows only loopback URL/bind combinations.
Do not derive redirects or metadata from incoming Host/X-Forwarded-* values.
Deploying at a new URL requires adding its exact Google callback and invalidates
old resource-bound grants. Document this as an intentional reconnect requirement.

## Browser and authorization state machine

Use random server-side browser sessions; cookie holds an opaque session ID only.
Hosted cookie: __Host- prefix, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain.
Local plain-HTTP loopback mode uses an explicitly separate cookie policy/name;
test real browsers rather than relying on Secure-cookie localhost exceptions.
Use bounded idle/absolute session lifetimes (initial target 30 minutes / 8 hours).
Rotate session identifiers after login; clear on logout. Each tab has a separate
transaction, state, nonce and CSRF token; a single session supports multiple flows.
Preserve a stable internal session identity when rotating its external random
cookie identifier; transfer valid transaction bindings atomically. Old external
identifiers immediately cease to authenticate. Serialize racing login callbacks.

1. SDK validates client, registered redirect URI, response type and S256 PKCE.
   Policy validates requested resource and scope; snapshot client metadata.
   Override the SDK's broad loopback-port exception with an explicit app policy:
   only HTTP numeric 127.0.0.1 (and [::1] if supported and tested) callbacks may
   vary their port. Scheme, address, path and query must match the registered
   redirect identity; localhost and other hosts require exact registered URI.
   Show the actual callback on consent, bind codes to that exact URI, and store
   approval against numeric-loopback identity without its port. Test this policy
   with each harness; never silently inherit a broader SDK exception.
2. Create a 10-minute transaction and send the browser to this app's consent page.
   Display escaped client name, client ID, exact callback and Tasks permissions.
   Make clear that a self-declared client name is not an identity endorsement.
   Require CSRF-protected provisional acknowledgement before any Google redirect.
   It cannot create a grant or code and is not authenticated final approval.
3. After acknowledgement, identify owner with a separate identity-only Google flow if the browser lacks
   a valid owner session. It requests openid email, online access and no forced
   Tasks consent. Bind state/nonce to transaction, browser and flow purpose.
   Verify signature/audience/issuer/time and nonce; reject non-owner and consume
   the state. Do not store returned access tokens as Tasks credentials.
4. Owner explicitly approves through CSRF-protected POST. Check session owner,
   transaction expiry, metadata snapshot and permitted transition. Deny ends the
   transaction and returns OAuth access_denied with the original client state.
5. Only after approval, request upstream Tasks authorization if credentials need
   provisioning. Use a new browser-bound state/nonce, openid email + Tasks scope,
   offline access and prompt=consent when needed to obtain a refresh token.
6. Callback consumes state before exchange, verifies identity, actual granted
   Tasks scope and refresh-token availability, then atomically commits the
   account credentials and approved grant. Never merge across identities.
7. Once credentials are usable, issue a short-lived single-use MCP code bound
   to grant, client, redirect, PKCE and resource. Redirect only to validated URI.
8. SDK verifies PKCE; provider atomically consumes code and returns opaque MCP
   access/refresh tokens. Verify grant remains active throughout the exchange.

Separate identity and provisioning purposes even when sharing the callback URI.
MCP guidance requires consent before third-party API authorization. The identity
flow must not request Tasks permission. Identity-state records exist only after
provisional acknowledgement; provisioning-state records exist only after final
authenticated approval. This conservative ordering avoids asserting an undocumented
identity-only exception to upstream-consent guidance. Browser callback requires matching session as well
as state; merely possessing a query state is insufficient.

For previously approved clients, fresh OAuth authorization requires a valid owner
browser session and unchanged grant tuple. It can then reuse approval. A client
without a browser session must authenticate owner again; stored Tasks refresh
credentials never substitute. Ordinary MCP refresh requires no browser interaction.
Google cancellation, denied identity, lost cookie or expired transaction produces
a safe retry path and no partial grant. Restart invalidates pending flows/codes.

## Resource, scope and token policy

Canonical resource is exactly the configured BASE_URL + /mcp, without query or
fragment. Reject conflicting resource at authorization, code exchange and refresh.
For older clients omitting resource, bind to this sole resource internally; this
is an explicit single-resource compatibility policy to validate against targeted
clients/spec version. Never accept arbitrary resource values or relax validation.

Only MCP scope `tasks` exists initially. Omitted authorization scope defaults to
tasks; unsupported or malformed scopes fail. Refresh omission retains scopes;
requested scopes must be a subset of grant scopes. Explicit empty/unknown scope
must have a documented error behavior. Set requiredScopes: [MCP_SCOPE] for /mcp.
Return actual granted scope and advertise it in metadata/challenges as supported.

Access tokens: 256-bit random opaque values, one-hour TTL, hashes at rest. Refresh
tokens: equally random, hashed at rest, rotate on successful refresh, fixed family
expiry (initial target 90 days); reuse revokes that grant. Retain spent-token
hashes until family expiry so reuse can be detected. Serialize refresh and define
retry behavior: initial policy fails closed on reuse. A lost successful response
can require reauthorization on retry. Commit rotation before returning tokens.
Cap access expiry/expires_in at remaining family lifetime. Set explicit bounds
on grants and rotation history; reaching a bound requires reauthorization, never
discarding necessary replay evidence early. Validate clients' concurrent
refresh behavior before release. Do not introduce an undocumented grace window.

Lookup checks owner, client, canonical resource, grant status, token/family expiry
and account generation. Account disconnection invalidates grants; reconnecting
must not reactivate old tokens. Temporary Google network failure is not proof
of revocation and must not erase the account; distinguish invalid_grant from
timeouts/5xx. Confirmed refresh invalid_grant retires the generation durably,
marks reconnect-required, and invalidates affected grants and pending flows.
A stale invalid_grant from an obsolete credential revision cannot disconnect a
newer account. Google-side revocation becomes known only on upstream use/refresh;
already-started Google API requests may complete despite subsequent revocation.
A failed Tasks call must never turn into automatic token issuance.

Bind each pending transaction and asynchronous Google operation to account
generation, client authorization revision and relevant credential revision.
Recheck all revisions and expiry inside the serialized final commit after any
exchange completes. Disconnect/client revocation cancels affected pending work;
late responses cannot restore credentials or grants. Revocation is not a permanent
client ban: intentional reauthorization starts a fresh transaction. Logout also
invalidates the browser's pending provisioning and approvals.

Revocation endpoint validates client ownership and returns RFC-compatible success
for unknown/other-client tokens without exposing their existence. Refresh-token
revocation revokes its grant and all access/refresh tokens. Access-token revocation
can invalidate that token alone. Owner CLI `clients list` / `clients revoke <id>`
revokes all grants for a client; `disconnect` increments generation and clears
Tasks credentials. Browser logout ends browser session, not MCP grants.

## Persistence, migration and process model

Use schema-versioned validated records. Persist owner, connected-account sub and
generation, approved grants, tokens/families, clients and Google credentials in
one private state file so account-plus-grant changes commit atomically. This
supersedes the spike's separate-file suggestion; logical credential separation
does not require separate files. No plaintext MCP bearer tokens in persisted indexes.
Support one server process per DATA_DIR, with exclusive startup ownership/lock;
setup and server cannot write simultaneously. Document supported filesystems.
Within the process serialize auth writes and account-refresh writes; use private
temporary files, fsync as appropriate and atomic rename. Do not spread a grant
transition across independently committed files; consolidate auth state or use a
transactional store if the JSON approach cannot meet this invariant.
Support local filesystems only. Fsync the temporary file and parent directory
where supported and document platform durability limits. Use robust process
identity for lock ownership; never steal a live lock based on elapsed time.
Stale-lock recovery verifies the owner process is absent or requires operator
resolution. Fault-inject at durable replacement boundaries.

Missing files mean first use; malformed/unsupported schema, unreadable files,
permission failures or lock conflicts fail closed with actionable errors. Repair
existing directory/file modes where safe, reject unsafe symlinks and write private
backups. Keep Google refresh-token preservation within the same verified account.
Reset/generation-check cached Google client callbacks so a stale refresh event
cannot repopulate disconnected credentials.

Migration is explicit and idempotent:

1. Stop old process and back up state privately.
2. Mark legacy Google credentials quarantined: they lack verified account identity.
3. Discard all old MCP sessions and approval assumptions; preserve registrations
   only as untrusted registered applications, requiring new owner approval.
4. Run trusted owner enrollment. A new identity login cannot establish ownership
   of legacy Tasks credentials.
5. Commit v2 with a disconnected account, no legacy tokens, and migration marker
   atomically. Start the server, approve the first client and provision Tasks
   through the normal verified flow. Migration needs no runtime MCP approval
   while stopped. Reruns preserve committed disconnected v2 state.

Keep legacy credentials available only for deliberate offline recovery; normal
operation must not fall back. An interrupted migration remains closed/re-runnable.
Rollback to old authentication code would restore the vulnerability: rollback
means disabling remote access and restoring backup in an isolated local setup,
not silently restoring the previous publicly reachable service.

## HTTP and deployment protection

Apply host allowlisting and endpoint-specific browser Origin/CORS policy. Cookie
session and consent endpoints do not enable cross-origin credentialed access.
Public OAuth metadata, DCR, token and revocation endpoints may use noncredentialed
CORS for browser clients, consistent with SDK behavior. /mcp requires bearer auth
and an explicit browser-origin policy, with documented origins for browser harnesses.
Non-browser clients can omit Origin; this does not bypass bearer checks. Test IPv4
loopback and localhost; IPv6 is supported only after addressing the installed SDK's
issuer exemption gap and testing it. Disable auth-response caching.
Top-level Google callbacks may omit Origin and rely on session/state/nonce.
If browser harnesses are supported, test OPTIONS/allowed headers and exposure of
WWW-Authenticate on permitted /mcp origins. Sensitive pages set Referrer-Policy:
no-referrer and use no third-party assets.
Add CSP frame-ancestors 'none', restrictive content policy and escaped HTML.
Approval mutates state only via POST; validate CSRF/session, not merely Origin.
Set parser/body limits and bounds/rate limits on registration, authorization,
transactions, sessions and token attempts. Review SDK built-in middleware before
duplicating it. Bound/expire registrations or provide owner cleanup; registration
must not become an unlimited persistent write endpoint.

Hosted TLS can terminate at a trusted reverse proxy. Document trusted forwarding,
firewall binding, stable issuer URL and real Google callback registration. Keep
deployment secrets out of commands/logs. No public deployment is performed by this
plan. If adding Client ID Metadata Documents, use a separate reviewed change with
SSRF protections, redirect controls, validated metadata and cache policy; retain
DCR/pre-registration for harnesses that need them. Do not accept metadata client
names as trust or auto-approval. Baseline release can use documented DCR choices
without advertising unsupported metadata capabilities.

Constrain DCR to actual implemented token authentication methods: public `none`
and confidential `client_secret_post`; handle omission according to the tested
policy below and report the selected method in registration responses. Reject unsupported methods
such as client_secret_basic unless explicitly implemented and tested. Keep token
and revocation metadata accurate for both public and confidential clients. Store
confidential-client secret verifiers, not recoverable plaintext, after registration.
The installed SDK compares client secrets as plaintext; hashed-secret storage
therefore needs an explicit client-authentication adapter that verifies submitted
secrets against stored hashes. Do not return a hash as if it were the SDK secret.
Omitted method defaults to Basic under RFC 7591: reject omission unless a tested
client accepts explicit supported-method normalization in the response. Set an
intentional confidential-secret lifetime (initially 90 days) rather than the SDK's
30-day default; refresh does not extend it. Enforce a bounded nonempty callback
list, HTTPS remote URLs, no userinfo/fragment, only deliberately supported HTTP
loopback URLs, and no custom schemes. Validate metadata before storage and again
at authorization. Registered remote HTTP callbacks are never accepted.
Include the exact advertised issuer as `iss` in success/error authorization
responses and advertise authorization_response_iss_parameter_supported only when
all relevant responses support it. Test raw issuer-string equality with metadata;
URL serialization can introduce a trailing slash and must not create a mismatch.
SDK-generated redirectable validation errors also require iss if advertised;
provider-only changes are insufficient. Adapt only necessary handlers and cover
their behavior with real HTTP tests rather than rewriting the entire OAuth stack.

Define approvals separately from grants: approval remembers owner/client/resource/
permission/redirect identity. Each fresh approved authorization prepares a new
grant; code exchange activates it with exactly one refresh family. Prepared grants
cannot authorize bearer or refresh requests. Reuse or refresh revocation kills that grant and
all its tokens; other independent grants remain valid. A spent refresh hash still
locates its live grant for revocation. Owner client revocation invalidates all
grants and increments the client revision. With only tasks scope, omitted refresh
scope retains tasks; explicit empty/unknown returns invalid_scope. SDK omitted
authorization scope is [] while explicit empty is [""]; handle them distinctly.
Document that all administrative CLI commands require stopped managed services,
including disabling launchd/systemd automatic respawn while the command runs.
The online OAuth revocation endpoint remains usable; deleting a connector in a
harness is not proof that the harness called /revoke.

## Implementation sequence and deliverables

1. Characterization: turn spike defects into failing behavioral tests, inventory
   SDK handlers and exact protocol/client support, pin a tested SDK minimum.
   Exit: expected failures isolate real app defects, PKCE/redirect validation pass.
2. Domain/store: typed records, grant IDs, hashed indexes, generation, atomic writes,
   locks, schema validation and migration. Exit: recovery/concurrency/revocation
   tests pass without any browser implementation.
3. Setup/identity: trusted enrollment, identity verification abstraction, separate
   Google purposes and wrong-account protection. Exit: no untrusted HTTP path can
   set owner or change Tasks credentials.
4. Browser flow: sessions, consent UI, CSRF, state machine and upstream provisioning.
   Exit: new client cannot receive code before verified owner approval.
5. OAuth integration: adapter issuance, resource/scope enforcement, rotation,
   revocation, discovery and challenge semantics. Exit: regression tests pass and
   old sessions fail; bearer/refresh behavior matches documented policy.
6. Deployment/docs: loopback binding, host/origin protection, local/hosted policy,
   README/config/service files and upgrade instructions. Exit: each supported
   connection path has accurate setup and migration instructions.
7. Live interoperability: real Google and client matrix below. Exit: supported
   paths work end-to-end and limitations are recorded, with no mocked claims.

Keep implementation commits reviewable by these phases; shipping is one coherent
release. Do not expose a partial implementation with the old authorization shortcut.

## Acceptance and verification matrix

Automated integration tests use temporary stores and injected Google transport;
signed fixture JWT verification should exercise the real verification library
with controlled keys rather than trusting a mock identity for every case.

| Area | Required evidence |
| --- | --- |
| Access boundary | Seeded working Google token + unknown client yields no MCP code/token without owner login and approval |
| Identity | Wrong signature/issuer/audience/expiry/nonce/sub rejected; wrong account leaves credentials unchanged |
| Browser | No/mismatched cookie, CSRF, state, expired/replayed flow, concurrent tabs and denial cannot issue a code |
| OAuth | Wrong verifier/client/redirect/resource, replay/expired code and revoked grant rejected |
| Scope | Defaults documented; unknown scope/escalation rejected; missing Tasks scope cannot access tools |
| Refresh | Rotation, reuse, expiry, parallel calls, restart and lost-response policy verified |
| Revocation | Client disconnect invalidates all grant tokens immediately; other-client revocation does not mutate state |
| Account | Disconnect/reconnect does not revive grants; stale Google refresh events cannot restore cleared tokens |
| Persistence | Missing/corrupt state, mode repair, crash/interruption, conflicting process and migration retry tested |
| HTTP | Host/origin/CSRF, clickjacking, escaping, body/record limits, issuer stability and redacted errors tested |
| Tasks regression | Existing tool registration and representative Google refresh/use behavior retained |

Additional mandatory tests: pause exchange/refresh then disconnect, revoke or
logout and resume success/failure; reject at final expired transition; reject
callbacks containing both error and code; race identity callbacks across tabs.
Fault-inject before/after state replacement for provisioning, disconnect, rotation
and migration; restart sees a complete old or new state. Exercise unsafe callback
registration, auth-method defaults, public/confidential token/revocation, spent
refresh revocation, bounded replay history and SDK-generated iss error responses.
Update smoke tests expecting direct Google redirect or valid legacy sessions;
retain tool-registration coverage using valid v2 fixtures.

Run typecheck, build and behavioral tests on correctly installed platform-native
dependencies. Spike's macOS esbuild/Linux mismatch is environmental; temporary
tsc compilation proved all four existing smoke tests pass, not full authentication.
Use time injection for boundary expiry tests and real HTTP tests for SDK behavior.

Live release matrix (record versions/date and steps, no tokens in evidence):

- Google: existing Web client, openid email identity, Tasks consent, actual scopes,
  owner/non-owner, cancellation, refresh and Google invalid_grant.
- Claude Code direct localhost HTTP: discovery, DCR or pre-registration, browser
  callback, approve/deny, tools, refresh, restart and revoke/reconnect.
- Claude Desktop local bridge: same flow through documented bridge; verify where
  OAuth tokens reside and callback/browser behavior. Do not claim native HTTP.
- Claude Desktop custom remote connector: hosted HTTPS, Anthropic cloud reachability,
  choose “Register automatically” (DCR), or “Use your own OAuth client” for
  pre-registration; do not choose published identity before CIMD support exists.
  Verify approve/deny and refresh on the actual account/client version.
- One other harness or official SDK test client: standards-based discovery/PKCE,
  loopback callback variation and resource/scope omission compatibility.

Manual verification of real Google/user sessions requires operator interaction.
No private credentials are needed to implement offline behavior. Unexecuted live
checks remain explicit release blockers for the corresponding supported path.

## Open decisions to resolve during implementation

- Prove setup's explicitly registered localhost callback and port/forwarding steps
  on the operator's machine for local and hosted deployments.
- Do target clients safely handle strict refresh rotation and lost responses?
  Keep a secure documented family policy; record any necessary change with tests.
- Target MCP authorization revision 2026-07-28 and tested SDK 1.29.0. Recheck
  resource-omission compatibility and the conservative consent ordering; do not
  describe compatibility extensions as strict universal compliance.
- Does Desktop support the chosen DCR setting for actual target versions? If not,
  add pre-registration or scoped CIMD work before claiming that path supported.
- JSON with one-process locking is the preferred minimal store. Escalate to SQLite
  only if atomicity/durability requirements cannot be satisfied simply.

## Sources and review record

Primary sources checked during spike:

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [MCP authorization](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/index.mdx)
- [MCP security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude connector networking](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

Independent Astra review: [review findings](evidence/plan-review.md), covering the
original draft. Its verdict was revise before implementation approval. Dispositions:

| Finding | Resolution |
| --- | --- |
| R1 consent ordering | Provisional acknowledgement before identity redirect, final owner approval before Tasks provisioning |
| R2 atomic persistence | One private versioned state file, durability/lock policy and failure-injection tests |
| R3 in-flight revocation | Revision/generation checks at final commit, cancelled flows and durable invalid_grant transition |
| R4 registration | Explicit callback/auth-method rules, narrow loopback port policy, secret lifetime and metadata validation |
| R5 setup and migration | Setup-specific localhost callback/forwarding; disconnected v2 migration then runtime provisioning |
| R6 CLI locking | Stop-first commands under same lock with managed-service respawn prevented |
| R7 CORS | Route-specific cookie/public OAuth policy, browser preflight/header and referrer checks |
| R8 issuer | Exact iss on all responses including SDK errors; explicit DCR selection for Desktop |
| R9 refresh families | Approval/grant/family distinction, durable rotation, spent-token revocation, bounded history and lost-response policy |
| R10 sessions | Stable internal session with rotated external identifier and callback/logout/expiry race tests |

Final Astra disposition check: ready to begin implementation, with all six P1
issues resolved and R7–R10 incorporated; see the final section of the review.
Real Google and harness validation remain implementation release gates rather
than results of this planning task. This approves the plan's readiness, not any
production implementation or deployment.
