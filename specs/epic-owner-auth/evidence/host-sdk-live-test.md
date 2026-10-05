# Host SDK authentication check — 2026-10-05

The user installed the updated macOS LaunchAgent, migrated legacy state and ran
owner setup. launchd reported the service running. The Linux sandbox reached
host.lima.internal:3789 using canonical Host localhost:3789. Discovery returned
200; unauthenticated MCP initialization returned 401 with scope tasks and the
protected-resource metadata URL.

A temporary sandbox loopback proxy on 127.0.0.1:3789 forwarded to the host while
preserving canonical localhost URLs. An official MCP SDK client discovered the
authorization server and dynamically registered a public client. It requested
tasks scope and the canonical MCP resource with S256 PKCE. The user opened the
authorization link on the Mac and completed the browser flow. The sandbox
callback listener received the callback on port 39871; its state and issuer
checks passed. Code exchange succeeded and authenticated MCP initialization and
tools/list returned all eleven expected tools. The client exited successfully.

Tokens, verifier and client registration information were held in process memory;
no client credentials were persisted or printed. No Google Tasks API operation
was invoked, and no user task data was read or modified. The DCR registration and
grant remain on the server until expiry or administrative removal.

This proves the live browser authorization → callback → code exchange → MCP
initialization → tool discovery path for this SDK client. It does not establish
real Tasks API behavior, refresh/replay, restart persistence, denial/revocation,
wrong-account handling, or Claude Code/Desktop/cloud connector compatibility.
Those acceptance paths remain pending. Browser header failures and their
Chromium remediation evidence are recorded separately.

## Revised direct-login host check

After the user-requested removal of the acknowledgement page and the upstream
issuer-parameter correction, the host Google redirect was probed and returned
302 to accounts.google.com without iss. The user completed the revised browser
flow; the SDK client again reported authenticated tool discovery with all eleven
tools and exited successfully. A previously verified owner session may skip
Google and display client approval directly. The same untested paths above remain
pending; no Tasks data was accessed or written.
