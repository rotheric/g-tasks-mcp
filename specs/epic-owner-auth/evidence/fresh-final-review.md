# Fresh final adversarial review

Date: 2026-10-05. Verdict: **changes required**.

Reviewed the frozen corrected implementation against the original AUTH-REFACTOR-PLAN.md, epic specification, acceptance criteria, architecture, ownership ledger and both stories' verification questions. Inspected authentication, persistence, setup, application/Google composition, configuration, test evidence and deployment documentation, including untracked implementation. Prior review reports were read after the original requirements. Preexisting `.mcp.json`, planning/review documents and `auth-spike.txt` were not attributed to this implementation. No source or shared workflow state was edited. This is an implementation review, not the separate VQ examination.

## FFR-1 — Delayed provisioning commits after absolute browser-session expiry

- **Location:** `src/auth/browser.ts:131` (`valid`), `src/auth/browser.ts:398` (post-exchange check), and `src/auth/browser.ts:414` (durable provisioning).
- **Severity:** 5/10. **Confidence:** 1.0.
- **Trigger:** Keep a browser session active until age 7 hours 59 minutes, authenticate the owner and approve Tasks provisioning, then suspend the Google exchange across the session's exact eight-hour absolute expiry. The ten-minute transaction remains unexpired.
- **Consequence:** The callback returns HTTP 302 with an authorization code and durably commits Google credentials and remembered client approval after browser authentication has expired. Reloading the store preserves that account and approval. A later code redemption prunes the expired session, so this reproduction does **not** establish a usable bearer token from that code. It does establish the prohibited partial durable authorization: obsolete browser work changes account/approval state, and a later login encounters that remembered approval. This violates the plan's independent expiry checks and AC-AUTH-2/AC-FLOW-2's final-commit validity requirement.
- **Cause:** Session lifetime is enforced only by `prune()`, called when obtaining a session or reading a code. After asynchronous Google exchange/identity verification, `valid()` checks only presence in the session map, transaction expiry and storage revisions. With no intervening request to trigger pruning, an expired session is still present.
- **Independent reproduction:** A temporary test reused the existing public HTTP fixture, with synthetic Google exchange and its injected clock. It opened a session, advanced in 20-minute increments while making authorization requests, advanced to 7h59m, completed identity login/final approval, suspended provisioning, advanced another minute and resumed. Result: `{"status":302,"beforeAccount":false,"afterAccount":true,"approvals":1,"reloadedAccount":true}`. The assertion that an expired browser must reject the callback failed. No private state manipulation was needed.
- **Correction:** Enforce idle and absolute session lifetime in the shared transaction-validity check immediately before post-await state mutation, independently of cleanup. An expired session must prevent identity completion, provisioning, approval persistence and code issuance. Extend the existing delayed-callback matrix with this absolute-session-boundary ordering; transaction expiry alone does not subsume it.
- **Evidence gap:** Existing `expiry` matrix cases advance ten minutes from a newly created session, exercising transaction expiry. All 80 existing tests pass despite this session-expiry defect.

## FFR-2 — Hosted logout emits an invalid deletion cookie for its `__Host-` name

- **Location:** `src/auth/browser.ts:363`; compare cookie creation at `src/auth/browser.ts:83`.
- **Severity:** 2/10. **Confidence:** 0.99.
- **Trigger:** Complete owner login in hosted mode and submit valid CSRF-protected logout.
- **Consequence:** The deletion response omits `Secure`. A browser enforcing the `__Host-` prefix rejects this cookie operation, retaining the previous cookie until expiry or replacement. The server does delete the session and pending flows, so this is a cookie-lifecycle requirement defect, **not** continued authenticated access. The reviewed plan explicitly requires clearing the browser cookie on logout.
- **Independent reproduction:** Through the assembled hosted app with an explicitly trusted loopback proxy and forwarded HTTPS, logout returned `Set-Cookie: __Host-gtasks=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`. An assertion requiring `Secure` failed. The header was observed directly; no live browser behavior is claimed by this probe.
- **Correction:** Clear the cookie with the same relevant policy as creation, particularly hosted `Secure`, `Path=/` and no Domain. Reuse the cookie options while omitting creation's maxAge. A focused hosted logout header assertion can catch this mismatch; actual browser validation remains part of the live gate.

## Independent execution and limits

Executed:

```text
NODE_OPTIONS='--import=/tmp/gtasks-final-review-7dtdymhc/no-dotenv.mjs' \
  node --import tsx --test test/identity.test.ts test/storage.test.ts \
  test/smoke.test.ts test/setup.test.ts
80 passed; 0 failed; 0 skipped.
```

The separate temporary `probe.ts` and `cookie-probe.ts` in that directory each failed their targeted expected-behavior assertion as described above. The preload replaces `dotenv.config` with a no-op before application imports and propagates to spawned CLI tests. No `.env`, `.mcp.json`, real stored credentials or real Google endpoints were read or used. Source/test typecheck and build were already independently executed by the structural reviewer; they were not rerun for this bounded behavioral review.

The previous fresh-review F1/F2 corrections are consistent with the inspected code and passing tests: retired grant families are reclaimed while active replay evidence remains, and unsupported zero-length proxy CIDRs are rejected. The new findings concern separate browser lifecycle paths.

MV-1 and all applicable MV-2 live paths remain pending: real Google enrollment/identity/Tasks consent and refresh, updated-host routing, Claude Code, Desktop local bridge, Desktop hosted connector and the live other-harness/SDK path. Mocked HTTP, signed synthetic identity fixtures and installed SDK tests cannot close those gates. Resolve FFR-1 and correct or explicitly disposition FFR-2 before recording this implementation review as clean.

## Bounded remediation recheck — final disposition

Date: 2026-10-05. Verdict: **CLEAN — FFR-1 and FFR-2 are remediated; no actionable residual remains in this bounded recheck.** This final disposition supersedes the initial changes-required verdict above.

Inspected the corrected browser validity/cookie paths and their new production HTTP regression tests against the original lifetime and logout requirements. Re-executed both original independent reproductions without changing their expected behavior:

```text
NODE_OPTIONS='--import=/tmp/gtasks-final-review-7dtdymhc/no-dotenv.mjs' \
  node --import tsx --test /tmp/gtasks-final-review-7dtdymhc/probe.ts \
  /tmp/gtasks-final-review-7dtdymhc/cookie-probe.ts
2 passed; 0 failed.
```

- **FFR-1 closed.** `valid(t)` now calls the existing expiry pruning before checking transaction/session membership, including after asynchronous Google exchange and identity verification. Thus exact absolute or idle expiry cannot survive as mere map membership. The original suspended-provisioning reproduction now returns `{"status":400,"beforeAccount":false,"afterAccount":false,"approvals":0,"reloadedAccount":false}`. New tests cover both delayed identity and Tasks completion at exactly eight hours, unchanged durable state across reload, rejection of the old approval submission, and successful intentional fresh authorization.
- **FFR-2 closed.** Cookie creation and deletion now share `cookieOptions()`, while maxAge belongs only to creation. The original hosted probe now receives `__Host-gtasks=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`. It contains no Domain or positive maxAge. The regression test also confirms the logged-out session cannot continue its pending authorization.

Independently ran the focused regression selection:

```text
NODE_OPTIONS='--import=/tmp/gtasks-final-review-7dtdymhc/no-dotenv.mjs' \
  node --import tsx --test \
  --test-name-pattern='absolute session expiry|hosted logout|delayed .* after logout|two owner browser tabs' \
  test/smoke.test.ts
10 passed; 0 failed.
```

This selection includes the two absolute-expiry cases, hosted deletion, six delayed identity/Tasks logout outcome cases and the two-tab provisioning/restart path. No source or shared workflow state was edited. The broader 83-test suite, source/test typecheck and build were reported independently passing by the continuing structural reviewer; this recheck makes no claim to have rerun them. The unchanged live MV-1/MV-2 gates remain pending and unwaived. CLEAN here establishes the corrected offline implementation review, not host, real-browser, real-Google or proprietary-harness certification.


## Final staged checkpoint recheck

Date: 2026-10-05. Verdict: **CLEAN — no actionable finding in the final bounded implementation delta.**

This pass reviewed the final source and staged checkpoint scope after the continuing structural review: direct Google identity login, callback issuer adaptation, browser navigation/mutation policy, consent CSP, fixed diagnostic labels, dependency bootstrap, launchd helper/Make targets, and consolidated specification/operations documents. The full original plan is now incorporated in `../spec.md`; its explicit user-requested amendment supersedes the initial acknowledgement step. Historical review and host evidence are retained separately. `.mcp.json`, `auth-spike.txt`, real `.env` and stored user credentials were not read or changed.

The direct identity redirect requests identity only and creates no approval, grant or MCP token. Final owner approval still requires the transaction's CSRF token, current owner session and valid revision/expiry before Tasks provisioning or code issuance. The removed acknowledgement stage does not remove these final checks. The issuer wrapper now changes only SDK error redirects matching the client callback origin/path; ordinary upstream Google redirects remain unmodified. Code-bearing successful callbacks retain the provider's canonical issuer. The earlier absolute-session-expiry and hosted-cookie-deletion corrections remain effective.

`Referrer-Policy: same-origin` permits native same-origin form provenance while suppressing the referrer on external navigation. External/opaque Origin on GET navigation does not substitute for callback state, cookie, nonce or owner verification. Browser mutations still reject external/opaque origins when supplied and require CSRF. Consent CSP permits only self, Google and the validated transaction callback origin for form navigation, retaining restrictive default/frame/base directives. Diagnostics output only fixed allowlisted categories or a fixed fallback; raw upstream exceptions and request material are not printed by that path.

Independent execution used `/tmp/gtasks-commit-check.eT49Yi`, with its own Linux dependencies and no `.env`. SHA-256 comparisons established that all 22 source/test/script/package/TypeScript files matched the frozen workspace before execution. Host `node_modules` was not changed.

```text
node --import tsx --test   --test-name-pattern='direct Google|browser navigations|Host and browser Origin|wrong Google|absolute session expiry|hosted logout|authorization codes|real SDK'   test/smoke.test.ts
9 passed; 0 failed.

node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit false --outDir .review-compiled
Pass.

node <repository>/specs/epic-owner-auth/evidence/direct-login-browser-check.mjs   /tmp/gtasks-commit-check.eT49Yi/.review-compiled   /tmp/gtasks-browser-check/node_modules/playwright/index.mjs
3 browser checks passed.
```

The Chromium checks independently establish direct synthetic Google navigation without upstream `iss`, no grant before approval, a native approval POST reaching the client callback, and signed-in denial of an unapproved client. They use private synthetic storage and fulfilled external pages, not real Google credentials. The complete 86-test run and standard typecheck/build were independently reported by the continuing structural reviewer; this bounded pass reran the focused selection and compilation above.

Dependency/bootstrap and launchd scripts were inspected for scoped execution, argument/path handling and failure propagation. The dependency probe/repair uses subprocesses in the project root; the launchd installer rejects non-macOS, XML-escapes substituted paths and stops an existing loaded job before replacing/bootstrap. This Linux review did not execute macOS service management. The lead reports that the user exercised `make restart` repeatedly on the host, observed running launchd afterward and completed fresh live OAuth/tool discovery; that is a reported host observation, not a Linux simulation or blanket launchd certification.

The recorded revised live SDK authorization and eleven-tool discovery demonstrate that specific connection path; they do not establish real Tasks operations, refresh/replay, restart persistence, wrong-account/denial/revocation scenarios or proprietary/cloud harness compatibility. Those remaining observations in `../host-validation.md` remain pending. This CLEAN disposition supports the user-authorized implementation checkpoint, not a blanket release-gate waiver.
