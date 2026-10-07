# g-tasks-mcp

Manage your Google Tasks straight from your agent.

Ask in plain language to add tasks and lists, check things off, and
reorganize your to-dos.

Under the hood this is an **MCP server**: it plugs your Google Tasks
account into Claude Desktop, Claude Code, or any client that speaks
MCP over HTTP. You enroll the owner locally, then approve each client through a browser OAuth flow. Tokens refresh automatically.

The MCP server binds to loopback by default. Hosted HTTPS operation is configurable; only owner-approved clients receive access.

## What you can do

| Tool                    | What it does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `list_task_lists`       | List all your task lists                                          |
| `create_task_list`      | Create a new task list                                            |
| `delete_task_list`      | Delete a task list and everything in it                           |
| `list_tasks`            | List tasks (optionally including completed, filtered by due date) |
| `search_tasks`          | Search titles and notes by meaning and keywords across lists      |
| `sync_search_index`     | Reconcile all tasks, reusing unchanged embeddings                  |
| `rebuild_search_index`  | Rebuild the optional derived search index                          |
| `get_task`              | Look up a single task                                             |
| `create_task`           | Add a task — title, notes, due date, optional parent for subtasks |
| `update_task`           | Change a task's title, notes, due date, or status                 |
| `complete_task`         | Mark a task done                                                  |
| `delete_task`           | Delete a task                                                     |
| `move_task`             | Reorder a task or turn it into a subtask                          |
| `clear_completed_tasks` | Clear out all completed tasks in a list                           |

You don't have to name a list for everyday requests — task tools default to
`@default`, your primary Google Tasks list.

## Getting started

Use Node.js 18 or newer, a Google account, and a Google Cloud **Web application**
OAuth client. Enable Google Tasks API, configure the consent screen and test users
as appropriate, and register `http://localhost:3789/oauth/google/callback` as an
exact authorized redirect URI. The existing client ID and secret can be reused.
Identity login adds `openid email`; Tasks provisioning also requests full Tasks
read/write permission. Existing credentials need fresh verified consent.

```bash
cp .env.example .env   # fill in your existing Google client ID and secret
npm ci
npm run build
node dist/index.js setup
npm start
```

Setup opens a temporary loopback listener and prints a URL. Open it in your
browser, sign in, then confirm the displayed account **in the terminal**. This pins
Google's stable account subject, not your email address. No network visitor can
claim ownership. Setup requires the normal service to be stopped.

For an existing installation, stop the managed service before migration and owner
setup. On macOS, unload it so KeepAlive cannot restart it during these commands:

```bash
launchctl bootout gui/$(id -u)/com.rotheric.g-tasks-mcp
make build
node dist/index.js migrate
node dist/index.js setup
make install
```

On Linux, use `systemctl --user stop g-tasks-mcp.service` before migration/setup
and restart it afterward. Preserve `.env` and DATA_DIR. Migration quarantines
legacy Google credentials and invalidates old MCP sessions; fresh verified
consent is required. Run only one process against a DATA_DIR.

Build, test, typecheck and development commands automatically repair missing or
wrong-platform dependencies with `npm ci`. Avoid concurrent host/sandbox installs
in a shared checkout.

### Connect Claude Code

```bash
claude mcp add --transport http google-tasks http://localhost:3789/mcp
```

Use `/mcp` to authenticate when prompted. The browser goes directly to Google
sign-in for a new session. After verified owner login, it shows the requesting
client, callback and Tasks permission for explicit approval. Signed-in owners go
directly to approval. Google Tasks consent follows if the account is not yet connected. The
harness gets separate MCP tokens; Google credentials stay on the server.

### Connect Claude Desktop locally

Local Desktop integrations launch a process. A stdio-to-HTTP bridge can connect
that process to this server; the server itself remains HTTP-only. For example:

```json
{
  "mcpServers": {
    "google-tasks": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:3789/mcp",
        "--allow-http",
        "--host",
        "127.0.0.1",
        "--auth-timeout",
        "600"
      ]
    }
  }
}
```

Choose and record a tested bridge version before deployment. Its OAuth token cache
is separate from this server's storage. Bridge options are documented in
[mcp-remote](https://github.com/punkpeye/mcp-remote).

### Connect a hosted service

Desktop **custom remote connectors** connect from Anthropic's cloud, including when
configured in the Desktop app. A localhost URL does not work through that path.
Use a public HTTPS origin, `DEPLOYMENT_MODE=hosted`, and deliberate bind/proxy
configuration. Register the exact public `/oauth/google/callback` with Google;
retain the localhost setup callback for trusted owner enrollment. In Claude's
connector settings choose **Register automatically**. Published client metadata
identity is not implemented. See [Claude's network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Never advertise an insecure remote HTTP issuer or change the default bind merely
to make a VM connection work. HTTPS can terminate at a trusted reverse proxy;
forward the canonical Host and `X-Forwarded-Proto: https`, set explicit trusted
proxy IPs/subnets in `TRUST_PROXY`, and do not put
OAuth query strings or credentials into proxy access logs. No hosted deployment
or real harness path has been certified by the offline tests.

## Run in the background (autostart)

To keep the server running across reboots and logins, register it with your OS
service manager. Run the server on the **same machine as your MCP client** so it's
reachable at `localhost` — for most people that's their desktop, not a remote box.

### macOS (launchd)

After migration and owner setup, install from the checkout on your Mac:

```bash
make install
```

This builds the server and generates a LaunchAgent using the current Node binary,
checkout directory and home directory for logs. It replaces an existing loaded
job and starts the updated one. Run `make help` to list available targets.

`RunAtLoad` starts it now and at every login; `KeepAlive` relaunches it if it
crashes. Manage it:

| Command                                                                            | Purpose                         |
| ---------------------------------------------------------------------------------- | ------------------------------- |
| `make status`                                                                    | Show launchd state and last exit status |
| `make restart` (or `launchctl kickstart -k gui/$(id -u)/com.rotheric.g-tasks-mcp`) | Restart (e.g. after a rebuild)  |
| `launchctl unload ~/Library/LaunchAgents/com.rotheric.g-tasks-mcp.plist`           | Stop and disable                |
| `make logs`                                                                      | Show the last 100 lines of each log and follow both (Ctrl-C to stop) |

launchd has no built-in log rotation. The two log files under `~/Library/Logs/`
grow slowly (startup + error lines only); rotate with `newsyslog` if needed. After
changing code, run `make restart` to rebuild and pick it up.

### Linux (systemd)

A ready-made unit is in [`systemd/g-tasks-mcp.service`](systemd/g-tasks-mcp.service) — edit its `WorkingDirectory` to match your checkout, then:

```bash
make build                                    # ensure dist/ is compiled
mkdir -p ~/.config/systemd/user
cp systemd/g-tasks-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now g-tasks-mcp.service

# Start at boot even when you're not logged in (one-time):
sudo loginctl enable-linger "$USER"
```

Manage it:

| Command                                   | Purpose                        |
| ----------------------------------------- | ------------------------------ |
| `systemctl --user status g-tasks-mcp`     | Check it's running             |
| `systemctl --user restart g-tasks-mcp`    | Restart (e.g. after a rebuild) |
| `journalctl --user -u g-tasks-mcp -f`     | Follow live logs               |
| `journalctl --user -u g-tasks-mcp -p err` | Errors only                    |

Logs go to the systemd journal — persisted and rotated automatically, no log files to manage. The service restarts on failure (`Restart=on-failure`). After a `make build`, run `systemctl --user restart g-tasks-mcp` to pick up the new code.

## Semantic task search

Search is enabled by default. It reuses an existing Qdrant and generates embeddings
through local Ollama. Install the default model (`ollama pull embeddinggemma`).
The following defaults can be overridden in `.env`:

```dotenv
QDRANT_URL=http://localhost:6333
EMBEDDING_URL=http://localhost:11434
EMBEDDING_MODEL=embeddinggemma
```

Set `SEARCH_ENABLED=false` only if you explicitly want to disable search.

Create or refresh embeddings from your Mac while the server keeps running:

```bash
make embeddings
make embeddings REBUILD=1 # regenerate in a fresh collection
```

The command is an authenticated MCP client. On first use, open the printed browser
URL and approve it through the normal authorization flow. Subsequent runs reuse its
private credentials in `DATA_DIR/mcp-cli`. It does not acquire the server's data lock.
Restart an existing installation once after upgrading to load `sync_search_index`.
The command reports the number of tasks newly embedded, reused, and indexed in total
(counting tasks, not text chunks). The normal command reconciles all tasks and reuses embeddings for unchanged text;
`REBUILD=1` calls `rebuild_search_index`. Both share the running server's queue with
mutations and its daily reconciliation.

For recovery with the server stopped, `make embeddings-offline` provides the original
exclusive writer command (`REBUILD=1` also works). This offline command requires the
server's data lock.

The service normally runs on your macOS host, where `localhost` refers to host
services. A service running inside Lima can use `http://host.lima.internal:6333`
and `http://host.lima.internal:11434` when those host services accept VM connections.
`QDRANT_API_KEY` is optional. `QDRANT_COLLECTION_PREFIX` defaults to `g_tasks`.
Qdrant must support the universal query endpoint (version 1.10 or newer).
No Qdrant process is started or unrelated collection modified.

Call `search_tasks` with a natural-language `query`; optional `tasklistIds` restrict
it to explicit list IDs. Search defaults to all lists, pending tasks, and 10 results.
`includeCompleted`, `dueMin` (inclusive), `dueMax` (exclusive), and `limit` (1–50)
are supported. Due bounds are RFC 3339 timestamps; Google Tasks stores date-only due
values. Results contain current Google task fields, list IDs, a matching passage,
a relevance score, and index freshness/candidate-limit information. Scores are
reciprocal-rank fusion values, not probabilities. Retrieval supplies context to the
client; the server does not generate answers or hypothetical questions.

The index embeds titles and notes directly, splitting long notes into bounded
paragraph-aware chunks. Semantic chunk matches are grouped by task and combined
with lexical matches over complete titles/notes. The server refetches a bounded
set of candidates from Google, reapplies filters, and repairs changed/deleted entries.
Changed candidates can retain an earlier relevance rank, which the response reports.
Candidate and verification caps can reduce recall; those limits are also reported.
Oversized embedding inputs cause an explicit error rather than silent truncation;
choose a model with adequate context for approximately 2,850 Unicode characters
per chunk. The model must remain stable under its configured identifier. EmbeddingGemma uses
its [document/query retrieval prefixes](https://ai.google.dev/gemma/docs/embeddinggemma/model_card#prompt-instructions)
automatically; the document prefix uses `title: none` with the actual task title
included in the chunk text. Other models default to raw text. Set
`EMBEDDING_QUERY_PREFIX` and `EMBEDDING_DOCUMENT_PREFIX` when a different model needs
instructions; changing prefixes triggers reindexing. Query formatting is deterministic,
without generated questions or content.

All writes are assumed to pass through this MCP. Writes mark durable recovery state
before contacting Google and update the index after success. If Qdrant or embeddings
fail, the Google write still succeeds and reconciliation remains pending. Server
startup and a minute-level scheduler reconcile pending work; an otherwise healthy
index receives a full reconciliation once daily. Searches also reconcile an
incomplete, dirty, missing, or overdue index before retrieving. Full reconciliation
fetches every list/task page, including completed and hidden tasks. Cleared completed
tasks remain searchable with `includeCompleted=true` because Google retains them
in history. Failed fetches never prune unseen tasks or advance sync freshness.

`DATA_DIR/search-index.json` is an atomic private manifest (0600), containing a
rebuildable copy of task content and recovery metadata separate from OAuth state.
Dedicated Qdrant collections are scoped to installation, account/disconnect generation,
model configuration and rebuild epoch. `rebuild_search_index` creates a new collection
and reindexes Google Tasks; old collections are retained for operator cleanup.
Model/endpoint changes trigger a separate collection and full reindex. Disconnect
fences pending operations and old data is never returned through the MCP. Rebuilding
does not delete Google tasks. For a corrupt manifest, stop the service, remove only
`search-index.json`, then restart to rebuild. Never remove authentication state as
part of search recovery.

Ordinary task tools work with search disabled and preserve Google success during
search dependency outages. Search failures are returned as errors, not “no matches.” Search/rebuild errors
include index completeness, pending reconciliation, and last successful sync when
the account remains current.
With search enabled, an unsafe/unwritable recovery manifest prevents mutations until
private storage is repaired, so a successful write cannot silently lose recovery state.
Task content goes to the configured embedding endpoint; keep it local if desired.
No deployment against live host Google/Qdrant/Ollama services is certified by the
sandbox tests. Offline port and production-tool tests cover retrieval, update/restart
recovery, pagination, filtering, chunk cleanup, and account fencing.

## Authentication and storage

- The service defaults to `127.0.0.1:3789`, advertised as `http://localhost:3789/mcp`.
- Owner identity and explicit per-client approval are distinct from stored Google
  credentials. Previously approved unchanged client permissions can be reused only
  with a valid owner browser session. Normal token refresh requires no browser.
- MCP access tokens expire after one hour. Refresh tokens rotate, with a fixed
  90-day grant expiry and bounded replay history. Reusing a spent refresh token
  invalidates its grant. A lost refresh response may require reconnecting.
- Each token is bound to this MCP resource and the `tasks` permission. This remains
  a single-user server: approved clients act on the pinned owner's Google account.
- `~/.g-tasks-mcp/state-v2.json` holds private account/auth state atomically. Bearer
  tokens and confidential-client secrets are hashed; Google credentials remain
  readable by the server. Directories use `0700`, files `0600`. This is OS file
  protection, not encrypted storage.
- One process owns a DATA_DIR. Corrupt state, unknown schemas, unsafe paths and
  conflicting writers fail closed. Supported storage is a local filesystem.
- Browser sessions/pending callbacks/codes are transient and restart cancels them;
  committed grants survive restart. Disconnect invalidates grants permanently,
  even if the same Google account is subsequently reconnected.

### Administration

Stop the service and prevent its manager from automatically respawning it before
running these commands. They acquire the same writer lock as the server.

```bash
node dist/index.js clients list
node dist/index.js clients revoke CLIENT_ID
node dist/index.js clients remove CLIENT_ID
node dist/index.js disconnect
```

Revoke invalidates all that client's grants; remove additionally frees registration
capacity. The online `/revoke` endpoint accepts the client's own access/refresh
tokens. Merely removing a connector in a harness may not invoke it. Browser logout
ends browser authentication, not existing MCP grants.

After an unclean process exit, `node dist/index.js lock-recover` removes a lock
only when its recorded process is absent. It refuses a live or ambiguous owner;
do not delete a lock belonging to a running service. Unreadable/corrupt state
requires operator recovery rather than automatic reset. Each normal replacement
keeps the previous complete state in private `state-v2.backup.json`; startup never
loads that backup automatically. Stop the service before recovery, inspect and
restore the backup with mode 0600, then run `node dist/index.js disconnect` before
starting again. This invalidates any restored grants and requires fresh Google
and client authorization; restoring an old backup alone could restore revoked
permissions. Keep the corrupt primary for diagnosis without sharing its secrets.

## Configuration

| Variable                                | Default                                      | Purpose                                                               |
| --------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | Required                                     | Existing Google Web OAuth credentials                                 |
| PORT                                    | 3789                                         | HTTP listener port                                                    |
| HOST                                    | 127.0.0.1                                    | Listener interface; local mode requires loopback                      |
| BASE_URL                                | http://localhost:$PORT                       | Canonical origin for issuer, MCP resource and runtime Google callback |
| DEPLOYMENT_MODE                         | local                                        | hosted requires HTTPS BASE_URL and TRUST_PROXY                        |
| DATA_DIR                                | ~/.g-tasks-mcp                               | Private state and writer lock                                         |
| OWNER_GOOGLE_SUB                        | Stored by setup                              | Optional independently verified owner override; conflicts fail        |
| SETUP_URL                               | http://localhost:$PORT/oauth/google/callback | Separately registered loopback enrollment callback                    |
| TRUST_PROXY                             | Disabled                                     | Explicit trusted reverse-proxy IPs/subnets; required in hosted mode   |
| BROWSER_ORIGINS                         | None                                         | Additional allowed browser MCP origins                                |

Changing BASE_URL requires callback registration and new resource-bound client
access. Host/Origin validation is separate from interface binding. Client OAuth
registration supports explicit `none` and `client_secret_post` authentication,
HTTPS callbacks and restricted HTTP loopback callbacks. Numeric `127.0.0.1`
callback ports may vary; `localhost` callbacks match exactly. Client ID Metadata
Documents, Basic client authentication and native stdio are not implemented.

Run `npm test`, `npm run typecheck` and `npm run build` for offline verification.
Real Google consent, host routing and individual harness paths are tracked
separately in [the validation record](specs/epic-owner-auth/host-validation.md).

## License

[MIT](LICENSE) © rotheric GmbH
