# Acceptance criteria

**AC-AUTH-1** — Unknown clients cannot obtain codes or tokens from stored Google credentials; owner identity and recorded explicit client consent are mandatory. Authenticated approval yields a code, exchange yields a usable token, and the token executes a representative Tasks operation. Remembered approval is reusable only for an unchanged tuple with a valid owner browser session; no-session and changed-tuple cases require login/fresh approval.
Spans modules: auth

**AC-AUTH-2** — Browser callbacks enforce session-bound single-use state, nonce, expiry, owner and transition checks; logout/revocation interleavings never restore access.
Spans modules: auth

**AC-AUTH-3** — OAuth enforces PKCE, redirect/client/resource binding, tasks scope, refresh rotation and grant revocation with no cross-client mutation.
Spans modules: auth

**AC-AUTH-4** — Versioned private atomic storage fails closed, locks out concurrent processes, migrates disconnected and rejects legacy MCP sessions.
Spans modules: auth

**AC-AUTH-5** — Trusted stop-first owner setup and CLI administration work without network ownership enrollment; hosted and local configuration validate securely.
Spans modules: auth

**AC-FLOW-1** — Assembled HTTP discovery, registration, consent, mocked external Google exchange, token use, refresh, revoke and restart satisfy access boundaries while existing Tasks tools remain available.
Spans modules: auth, application

**AC-FLOW-2** — Asynchronous Google events and success/failure responses cannot reactivate disconnected/revoked credentials or grants; transient failures preserve state.
Spans modules: auth, application

## Manual validation

| ID | Required observation | Cheapest automated alternative and limit | Status |
| --- | --- | --- | --- |
| MV-1 | Real Google owner enrollment, identity/Tasks consent and account rejection on updated host | Mocked HTTP flow cannot prove real credentials, consent or browser cookies | Partial: host update, owner setup and SDK login passed; remaining live observations pending |
| MV-2 | Real harness callback, refresh and revoke/reconnect against host | SDK client proves protocol assembly but not proprietary harness behavior | Partial: SDK callback/code exchange/tool discovery passed; harness/refresh/revoke paths pending |

## Frozen evidence commitments

For AC-AUTH-2 and AC-FLOW-2, generate applicable combinations of suspended identity/provisioning exchange or Google refresh (success, invalid_grant, transient failure), intervening disconnect/reconnect, client revoke/new authorization, logout, exact expiry, or competing credential revision. Resume and check the assembled production flow and reloaded store: obsolete work issues no usable access or stale credentials; stale failures cannot revoke new accounts; transient failures preserve committed security state; fresh intentional authorization remains possible. Already-started Tasks calls may complete. Include two-tab callback races.

Required evidence checklist: real verifier signed JWT fixture errors and nonce; atomic replacement fault injection before/after provisioning/disconnect/rotation/migration; restart discards transient codes but preserves valid grants; public/confidential client auth and secret verifiers; omitted/empty scopes; issuer equality including handler error redirects; spent-token revocation and bounded history; Host/Origin/CORS and registration bounds. Map these to VQs and actual tests, not reasoning alone.

Manual MV-2 has independently pending subpaths: Claude Code local HTTP; Desktop local bridge; Desktop hosted HTTPS connector; other harness/SDK client. Record version/date, approval/denial, refresh/restart, revoke/reconnect and callbacks/token storage. A local host test cannot close hosted-cloud evidence. MV-1 includes actual scopes, nonce, wrong account, cancellation, Tasks refresh issuance/preservation and terminal refresh failure.
