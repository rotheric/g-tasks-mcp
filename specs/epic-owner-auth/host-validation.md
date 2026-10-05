# Host upgrade and final authentication testing

The implementation is developed in a sandbox. Real Google consent and harness
validation require the user to install/update the host service. Offline tests do
not establish these live paths. Do not expose the old service publicly.

## Upgrade on the host

Stop the managed service first. On macOS, boot it out to prevent KeepAlive from
restarting it during migration/setup (adjust the installed plist path if needed):

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.rotheric.g-tasks-mcp.plist
```

On Linux:

```bash
systemctl --user stop g-tasks-mcp.service
```

From the updated repository, preserving `.env` and DATA_DIR:

Build, test, typecheck and development commands check their dependencies and run
`npm ci` automatically if they are missing or the native esbuild binary is for
another platform. This also applies to `make build` and `make test`. Avoid running
host and sandbox dependency installs concurrently in the shared checkout.

```bash
npm run build
node dist/index.js migrate
node dist/index.js setup
npm start
```

`migrate` creates private legacy-quarantine backups, invalidates legacy MCP
sessions and starts v2 disconnected. `setup` pins owner identity after Google login
and terminal confirmation. If you already have an independently verified
OWNER_GOOGLE_SUB, setup may use it without interactive enrollment. Do not substitute
an email address or infer a subject from unverified JWT text.

Verify Google has the exact setup callback (default
`http://localhost:3789/oauth/google/callback`) registered for the existing Web
client. Hosted runtime additionally needs its public HTTPS callback. Identity
login requests `openid email`; Google Tasks provisioning requests Tasks scope too.
Migration deliberately requires fresh verified Tasks consent. Interrupted/repeated
migration leaves a valid disconnected v2 state. A stale writer lock after a crash
requires `lock-recover`, which refuses to remove a live process's lock.

Use a foreground server during initial testing. Re-enable the managed service
only afterward; never run both against one DATA_DIR. macOS:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rotheric.g-tasks-mcp.plist
```

Rollback restores old unsafe authorization behavior. Keep it isolated to local
use; do not deploy an old backup as a public service.

## Sandbox connection to the host

`host.lima.internal` is a possible transport destination, not the canonical OAuth
issuer. Keep the local advertised URL and Google callback on localhost. The new
local server deliberately binds only to 127.0.0.1; VM-to-host loopback reachability
must be demonstrated rather than assumed.

After the user updates the service, first check transport reachability without
registering new clients or weakening authentication. A request using the wrong
Host may return 421 even if the port is reachable. A Host-header probe can inspect
reachability/discovery but does not establish a working browser OAuth flow.

For a genuine sandbox MCP client, establish a loopback forwarding route preserving
canonical `http://localhost:3789` on both sides. If a host browser must reach a
sandbox client's loopback OAuth callback, forward that callback port separately.
Record actual listener, forwarding commands, issuer/resource, Google setup/runtime
callbacks and harness callback location before claiming success. The exact route
is pending host capabilities. Do not change BASE_URL to insecure
`http://host.lima.internal`, broaden local HOST/Origin validation, or publish a
remote HTTP listener just for the test.

If loopback forwarding is unavailable, keep sandbox live testing pending or use a
separately authorized hosted HTTPS deployment. Desktop cloud connectors require
public HTTPS reachability and cannot be validated by a localhost route.

## Required live observations

Record version/date and result independently for each applicable path:

| Path                     | Required evidence                                                                                                          | Current status                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Google enrollment/Tasks  | Owner/sub/nonce, exact callbacks, actual scopes, wrong account rejection, cancellation, refresh token and terminal failure | Partial: setup/login passed; other observations pending |
| Claude Code local HTTP   | Browser approval/denial, tools, refresh, restart, revoke/reconnect, callback URL                                           | Pending                       |
| Desktop local bridge     | Same flow, bridge version, callback and client token cache location                                                        | Pending                       |
| Desktop hosted connector | Cloud HTTPS reachability, Register automatically, browser cookies, approval/refresh/revocation                             | Pending separate hosted setup |
| Other harness/SDK client | Discovery, PKCE, resource/scope behavior, callback routing                                                                 | Partial: SDK login/tool discovery passed; lifecycle pending |

Use an innocuous test task if a write operation is needed and clean it up after
validation. Do not record tokens, secrets or OAuth codes in screenshots/logs.
A successful mocked flow or one harness run cannot close the other paths.
