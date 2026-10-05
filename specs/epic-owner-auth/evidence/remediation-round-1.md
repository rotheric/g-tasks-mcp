# Structural remediation, round 1

The initial structural review inspected a 25-test implementation. The remediated
snapshot passes 76 behavioral tests, source/test TypeScript checking and build.
Real Google, host routing and proprietary harness paths remain pending.

| Finding | Concrete change | Discriminating evidence |
| --- | --- | --- |
| SR-1 | Accepted Google token merge increments credential revision; cached clients are recreated on revision changes | Production Tasks matrix resumes old success/401/503 after refresh/reconnect/new authorization; state reload preserves newer credentials. Current transient/terminal test distinguishes preservation from disconnect |
| SR-2 | Hosted requests require req.secure after explicit trusted-proxy configuration | Direct HTTP and untrusted forwarded HTTPS rejected; explicitly trusted proxy HTTPS accepted |
| SR-3 | Stored client method/verifier/expiry cross-field schema validation | Missing verifier, plaintext verifier, missing expiry and public-with-secret JSON all fail on reload |
| SR-4/5 | Provider atomically consumes code, locally validates S256 and requires exact redirect | Real SDK HTTP bad verifier/client/callback/resource/omitted callback attempts burn separate codes; concurrent redemption yields one success |
| SR-6 | Supported legacy registrations retained without approvals; secrets hashed; unsafe entries quarantined | Before/after migration rename faults, retry/reload, unapproved public/confidential clients, legacy credentials never connected |
| SR-7 | Custom AS metadata has noncredentialed GET/OPTIONS CORS | Both discovery documents readable and AS preflight succeeds |
| SR-8 | Valid callback state consumed before mixed-response classification | Mixed error+code rejected; replay rejected |
| SR-9 | Expanded compact generated matrices and CLI/setup production composition | Delayed identity/Tasks outcomes across reconnect, new authorization, logout, exact expiry, credential replacement and reload; two browser tabs; restart; stop-first CLI effects; setup Host/entry/cookie/state/nonce/expiry/single use |
| SR-10 | Atomic private previous-state backup, no automatic fallback | Private complete backup observable; corrupt primary still fails; README requires explicit disconnect after operator restore |

The setup browser is extracted into a small injectable factory so offline tests
exercise the same routes as terminal enrollment. Only the trusted CLI performs
owner pinning after terminal confirmation. Tests mock the external Google port,
not the production authorization policy. Signed ID-token fixtures separately
exercise Google's real verifier with fixture keys.
