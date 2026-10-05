# Fresh adversarial implementation review

Date: 2026-10-05. Verdict: changes required.

Reviewed the frozen authentication implementation against AUTH-REFACTOR-PLAN.md, the original epic spec/acceptance criteria, architecture, ownership ledger, and both stories' verification questions. Inspected production auth/storage/setup/HTTP/Google composition, tests, dependency/configuration changes, README.md and HOST-TESTING.md. The preexisting .mcp.json, AUTH-REFACTOR-PLAN.md, AUTH-REFACTOR-REVIEW.md and auth-spike.txt were not attributed to implementation changes. No source or shared workflow state was edited. Model identity is not independently exposed to this reviewer.

## F1 — Permanently revoked grants exhaust authorization capacity until their original expiry

- Location: `src/storage.ts:474` (`prune`), `src/storage.ts:508` (`issueGrant` capacity checks), and revocation/disconnect methods which only mark grants inactive.
- Severity: **5/10**. Confidence: **1.0**.
- Trigger: issue and revoke 100 grant families within their 90-day lifetime. Revocation may be refresh-token revocation, owner client revocation, or disconnect. Fewer families can reach the separate 10,000 refresh-history limit.
- Consequence: all fresh code exchanges fail because inactive families still count against global capacity. Removing the client and disconnecting/reconnecting the Google account do not free capacity. The owner cannot use the documented reauthorization recovery path until old families expire, or perform an undocumented state reset. This contradicts the plan's requirement that reaching a history bound requires reauthorization and AC-AUTH-3's recoverable grant lifecycle.
- Reproduction: a synthetic private `Storage` fixture pinned an owner, registered a public client, provisioned synthetic credentials and approved its tuple. It ran `issueGrant` followed by `revokeToken(refresh_token, clientId)` 100 times. All 100 grants became inactive. The next `issueGrant` threw `Authorization capacity reached`. After `removeClient`, `clearGoogleTokens`, registration, provisioning and approval, issuance still threw the same error. No clock advance or corrupt state injection was needed.
- Correction: reclaim permanently inactive grants and their access/refresh entries before applying capacity checks, or provide an equivalent bounded owner recovery transition. Keep spent refresh hashes for **active** families so reuse and spent-token revocation remain enforced. Confirm fresh authorization succeeds after retired families/history have filled capacity while all old tokens remain invalid across restart.
- Existing evidence gap: `test/storage.test.ts` checks per-family replay-history exhaustion and revocation, but not fresh authorization recovery after retired records exhaust global capacity. All current tests pass despite this failure.

## F2 — Configuration accepts CIDR prefixes that the actual proxy parser rejects

- Location: `src/config.ts:70` through the TRUST_PROXY validation; `src/app.ts:44` when Express compiles the accepted value.
- Severity: **2/10**. Confidence: **1.0**.
- Trigger: hosted configuration with `BASE_URL=https://mcp.example`, `TRUST_PROXY=0.0.0.0/0`, and synthetic Google client values passes `assertConfig`.
- Consequence: `createApp` immediately throws `TypeError: invalid range on address: 0.0.0.0/0` from installed `proxy-addr`. Configuration validation reports an unsupported prefix as valid, and startup fails later with a dependency error. This fails closed; it is **not** a plaintext-authentication bypass.
- Correction: align configuration validation with the actual installed proxy parser (and reject universal trust intentionally if that is the deployment policy). Add the smallest configuration case needed to distinguish accepted application syntax from values that Express cannot use.

## Hosted TLS boundary observation

The accepted configuration `HOST=0.0.0.0`, `BASE_URL=https://mcp.example`, `DEPLOYMENT_MODE=hosted`, `TRUST_PROXY=0.0.0.0/1,128.0.0.0/1` starts successfully and trusts every IPv4 peer. A direct plaintext HTTP request with canonical Host receives 400 without `X-Forwarded-Proto`, and 200 for authorization metadata with `X-Forwarded-Proto: https`. This demonstrates that `req.secure` depends on correctly configured proxy trust; it does not establish TLS on the backend connection. The reproduction is an operator declaration that every IPv4 peer is trusted, **not** a bypass under correctly configured explicit proxy addresses. It is recorded as a deployment limitation, not an additional implementation blocker. Proxy/header and backend-access restrictions still require real hosted validation.

## Independent execution and limits

Executed the existing tests independently:

```text
NODE_OPTIONS='--import=/tmp/gtasks-fresh-review.LHlBvO/no-dotenv.mjs' \
  node --import tsx --test test/identity.test.ts test/storage.test.ts \
  test/smoke.test.ts test/setup.test.ts
77 tests passed; 0 failed; 0 skipped.
```

The preload replaced `dotenv.config` with a no-op before importing production modules, including inherited CLI child processes. No .env, .mcp.json, real ~/.g-tasks-mcp state or user tokens were read. Private synthetic reproduction programs and test output are in `/tmp/gtasks-fresh-review.LHlBvO/`; `probe.mjs` establishes F1/F2 and `probe-second.mjs` establishes the explicit universal-proxy-trust observation.

Real Google identity/consent/scopes/refresh behavior, host installation and routing, Claude Code, Desktop bridge, Desktop hosted connector and the individual live other-harness/SDK path remain pending. Passing mocked HTTP, signed synthetic identity and installed SDK tests does not close those release gates. This is an implementation review, not the separate per-question verification examination.
