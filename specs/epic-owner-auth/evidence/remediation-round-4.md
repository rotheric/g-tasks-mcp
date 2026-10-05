# Fresh adversarial remediation, round 4

FFR-1: valid(t) invokes the existing expiry prune before transition validation,
including after awaited Google exchange and identity verification. A session
that crosses its absolute or idle lifetime loses its pending transactions/codes
before credentials or approval can commit. Tests exercise both identity and
Tasks callbacks at exact eight-hour session expiry after keeping the session
active to 7h59m. Reload confirms unchanged durable state; old authorization rejects
and a fresh owner login still works.

FFR-2: browser cookie creation and clearing share one CookieOptions policy.
Hosted deletion retains Secure, HttpOnly, SameSite and path, and omits maxAge.
An actual hosted response-header test observes compliant __Host- cookie deletion
and verifies server-side pending authorization is invalidated.

Checks: 83/83 tests, source/test typecheck, build, diff check. Independent
structural and Astra focused rechecks pending. Independent VQ examiner model
substitution requested; host/Google/harness gates still pending.
