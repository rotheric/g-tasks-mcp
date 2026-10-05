# Browser header compatibility remediation

Host discovery succeeds (HTTP 200); unauthenticated MCP calls return 401 with
protected-resource metadata. Browser authorization exposed two offline coverage
gaps: no-referrer produces null Origin on native HTML form POSTs, and form-action
self blocks OAuth redirects in Chromium. Repeated submission after a blocked
redirect uses the already rotated token and fails CSRF verification.

Changes: same-origin Referrer-Policy; browser Origin enforcement on mutations;
transaction-specific consent-page CSP permits self, accounts.google.com, and
only the validated callback origin. Cross-origin/null-Origin mutations remain
rejected, callbacks retain session/state/nonce verification, CSRF remains required.
Fixed error categories are logged without upstream exceptions or secret values.

Source/test TypeScript compile passes. All 61 HTTP-flow tests pass, including
header assertions, rejected cross-origin forms and accepted same-origin forms.
A Chromium 153 / Playwright browser check runs the real compiled app against
private synthetic storage and an injected Google adapter. CDP fulfills external
Google/client requests with synthetic pages. It confirms the old policy blocks
Google, a repeated POST fails CSRF, and the corrected policy reaches Google and
the client callback after owner approval. No actual Google credentials were used.
The test runs from a temporary directory without a .env file.

Reproduction: compile src/test to a temporary directory with TypeScript, place
package.json there and link dependencies. Install Playwright and Chromium in a
separate temporary directory. Run browser-headers-check.mjs with the compiled
directory and absolute Playwright index.mjs path as its two arguments.

Actual owner/Tasks consent, token exchange and host callback forwarding are still
pending the next host rebuild and fresh browser attempt. This evidence does not
close the live harness gates or re-certify the entire refactor.
