# VM access — Acceptance Criteria

**AC-VM-1** — Opt-in accepts only a validated local host.lima.internal origin with listener port; absent opt-in preserves local/hosted behavior and rejects VM Host.

**AC-VM-2** — Each allowed Host returns its fixed issuer/resource, metadata challenge and reachable client endpoints; VM authorization advertises canonical /authorize/vm; forwarded headers cannot alter identity.

**AC-VM-3** — Canonical browser authorization uses the selected profile even with omitted resource; Google callback and cookie origin remain canonical; owner/client approval, redirect and issuer error checks apply to both paths.

**AC-VM-4** — For both profiles and both code/refresh/bearer cross-profile directions, wrong-resource use is rejected; same-profile grants work across reload and refresh rotation preserves binding.
Spans modules: access-config, authorization, http.

**AC-VM-5** — Generate both Host profiles, slash/no-slash MCP paths, unexpected Origins and forwarded/unconfigured authorities: cookie-authenticated mutations require canonical Origin and CSRF; OAuth authorization POSTs without Origin remain supported, but reject a noncanonical supplied Origin; VM Host cannot run browser routes; MCP cross-origin requests are rejected.
Spans modules: access-config, authorization, http.

**AC-VM-6** — Assembled fixture flows for both profiles complete registration, browser Google owner login, explicit approval, PKCE exchange, MCP initialization and read-only task tool, then refresh and revocation.
Spans modules: access-config, authorization, http.

**AC-VM-7** — Deployment docs and example describe opt-in, unchanged host binding/callback, local HTTP trust, reauthorization, VM client callback forwarding and actual verification commands with truthful pending live results.

## Deployment evidence pending

Actual Mac/browser and Lima-client authorization, read-only operation and VM refresh are required by the source proposal. Cheapest automated fixture proves protocol composition but cannot certify actual client HTTP policy, browser callback reachability or real Google credentials. No manual waiver or success recorded.

## Amendment after structural review

Cookie forms now require Origin rather than only validating one when present. Public OAuth /authorize POST retains absent-Origin compatibility; it starts a transaction rather than granting access and still checks supplied Origins. Revocation is isolated by resource in both directions, alongside exchange/refresh/bearer. Original VQs remain frozen; post-implementation questions cover these clarifications.

## Manual Validation

| MV id | Behavioral intent | Gap evidence | Owner | Blocked on | Adjudicated |
|-------|-------------------|--------------|-------|------------|-------------|
| MV-1 | Actual Mac and Lima clients authorize through Mac browser, initialize/read tasks and VM refreshes | SDK fixtures test protocol behavior but cannot access Mac browser, restart launchd or establish actual client HTTP/callback policy; live scripted alternative requires deployed opt-in and browser/operator access absent here | Mac operator | Mac deployment and actual clients | |

Pending and unadjudicated; original source requirement retained, no waiver or completion claimed.
