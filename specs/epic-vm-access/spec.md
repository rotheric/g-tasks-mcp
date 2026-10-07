# Host and Lima VM access

Source: project-root g-tasks-mcp-vm-access-proposal.md (2026-10-07), user authorization to consult Astra then implement. Server remains on macOS only; Lima already reaches its loopback listener. Keep VM MCP URL http://host.lima.internal:3789/mcp/.

Opt-in VM_ACCESS_ORIGIN introduces a fixed local HTTP access profile. Keep default local and hosted behavior, canonical browser session origin and registered Google callback. Each resource has one deterministic issuer; persistent schema unchanged. Client-facing endpoints use their access profile. VM browser authorization uses /authorize/vm on canonical BASE_URL. Preserve owner/client approval, redirect checks, PKCE, Origin/CSRF, resource checks, rotation, revocation. HTTP across Lima is an explicit local trust assumption; do not enable a global SDK insecure-issuer switch.

Non-goals: run service in VM, expose all interfaces, change running configuration, deploy/restart launchd, provision TLS or automatically open VM callback ports.

Verification: behavioral matrices through assembled Express/SDK with Google and Tasks external-port fixtures, full regression tests, typecheck/build, independent structural and fresh adversarial review. Actual host/VM OAuth, real read-only task request and VM refresh remain required deployment evidence, separately recorded from fixture tests. Agent is Linux VM without limactl/launchctl or Mac browser; do not fabricate live success.

Mutation tooling is not configured; record unavailable gate, not a pass. Exact skill examiner model gpt-5.6-terra is unavailable; record unavailable independent examiner gate rather than impersonate it. User explicitly selected Astra for design opinion.

## Manual Validation

| MV id | Behavioral intent | Gap evidence | Owner | Blocked on | Adjudicated |
|-------|-------------------|--------------|-------|------------|-------------|
| MV-1 | Actual Mac and Lima clients authorize through Mac browser, initialize/read tasks and VM refreshes | SDK fixtures test protocol behavior but cannot access Mac browser, restart launchd or establish actual client HTTP/callback policy; live scripted alternative requires deployed opt-in and browser/operator access absent here | Mac operator | Mac deployment and actual clients | |

Pending and unadjudicated; original source requirement retained, no waiver or completion claimed.
