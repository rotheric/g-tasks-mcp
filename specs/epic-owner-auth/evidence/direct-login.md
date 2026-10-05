# Direct Google sign-in — user-requested flow simplification

The user requested removing the initial sign-in acknowledgement page after the
live SDK OAuth flow succeeded. New owner-browser sessions now redirect directly
from /authorize to Google identity login. A verified signed-in owner reaches
client approval directly for unapproved clients. Existing explicit remembered
approval remains reusable only under its original owner/session/client/resource/
redirect/revision checks. Google identity login alone issues no MCP code or grant.

Removed the acknowledge transaction stage and /auth/continue route. Explicit
client approval, denial, logout, Tasks provisioning and CSRF/state/nonce checks
remain. Updated the HTTP fixtures and README for the new sequence. Delayed
identity logout tests obtain logout CSRF from a concurrent verified identity flow
and use the pending flow's own nonce-bound fake code; this retains the stale
exchange/session invalidation test rather than bypassing it.

Validation: source/test TypeScript compilation and diff check pass; all 62
assembled HTTP-flow tests pass. A new focused test proves direct Google redirect,
no grant before approval, rejected wrong CSRF, direct approval for a signed-in
owner with a new client, denial without a grant, and approved code exchange.

Chromium 153 with private synthetic storage and an injected Google adapter proves
new sessions navigate directly to a simulated Google page; returning verified
identity displays explicit approval; approval reaches the simulated client
callback; a signed-in owner can deny another client without a Google round trip.
CDP fulfills external Google/client requests with synthetic pages. The browser
check runs without a real .env or credentials. Reproduce with
 direct-login-browser-check.mjs <compiled-src-and-test-directory> <absolute-playwright-index.mjs>.

The first host attempt after this change reached Google but Google rejected an
unexpected iss parameter. The /authorize redirect adapter had decorated every
absolute redirect, including the newly direct upstream Google redirect. It now
adds iss only to SDK error redirects matching the client callback origin/path;
successful client callbacks already add iss in BrowserAuthorization. Permanent
HTTP and Chromium checks now explicitly assert that upstream Google URLs lack
iss, while existing tests retain client callback issuer assertions. All 62 HTTP
tests and the three Chromium flow checks pass after this correction.

Host rebuild and a fresh live authorization of this corrected UI remain pending.
Prior live SDK evidence describes the earlier flow and is retained as historical
evidence, not represented as testing this revision.
