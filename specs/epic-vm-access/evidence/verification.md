# VM access verification

Baseline: npm test 118/118; npm run typecheck passed before source edits.
Focused integration: npx tsx --test test/vm-access.test.ts 8/8. Uses actual Express HTTP sockets and MCP SDK Client/StreamableHTTPClientTransport, routing configured authorities to a disposable loopback listener. External Google identity/consent and Tasks API responses are fixtures. The real list_task_lists handler performs a checked GET against a fixture Google request port. Covers both resource profiles, omitted resource, approval, PKCE, fixed success/error issuer, reload, refresh rotation/replay, revocation, cross-profile rejection, Host/forwarded/Origin/CSRF and case/slash variants.
Full regression after remediation: npm test 126/126; npm run typecheck and npm run build passed. Independent structural recheck clean (8/8 focused); fresh Astra code review clean (70/70 VM and authorization tests). Seven bounded manual fault-injection probes were all killed by the focused matrix (mutation-probes.json); no full mutation framework is configured, and this is not exhaustive coverage.

## Actual deployment evidence

2026-10-07: agent runs Linux, has neither launchctl nor limactl. Read-only GET http://host.lima.internal:3789/mcp/ reaches the running Mac service and returns 421 {"error":"Unexpected host"}. This confirms existing service remains unchanged; it does not validate the implementation on Mac. User confirms Lima reaches Mac loopback.

Mac service deployment/restart and real client HTTP policy, Mac browser authorization, client callback forwarding, real task read and VM token refresh remain pending. No running .env, client config, launchd service or private OAuth state changed. Do not treat fixture results as live Google/host/VM certification.

## Live VM routing after user restart

2026-10-07T09:09:51.042974+00:00: user restarted Mac service. All 15 live probes passed from this Linux VM: MCP 401 with VM metadata challenge; resource and authorization metadata 200 with fixed VM issuer/resource/token/register/revoke and localhost /authorize/vm browser endpoint; canonical Host profile through Lima transport 200 with localhost identity; unknown Host 421; forwarded identity unchanged; VM browser route 421; foreign Origin and mixed-case /MCP/ 403; invalid bearer 401; token/register/revoke GET 405; unknown-client code exchange and refresh 400. See vm-live-probes.json. No registration, private credentials or account-state mutation used.

This closes live VM reachability and discovery routing only. Actual Mac client access, browser authorization/client callback forwarding, successful authenticated MCP task read and VM token refresh remain pending.
