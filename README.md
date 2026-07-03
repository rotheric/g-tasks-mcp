# g-tasks-mcp

Manage your Google Tasks straight from your agent.

Ask in plain language to add tasks and lists, check things off, and
reorganize your to-dos.

Under the hood this is an **MCP server**: it plugs your Google Tasks
account into Claude Desktop, Claude Code, or any client that speaks
MCP over HTTP. You sign in through Google in your browser once; after
that it just works — no copying URLs, no pasting tokens, and
reconnects are instant.

The MCP server runs locally, and hence does not expose your tasks to
other agents than the ones you connect with.

## What you can do

| Tool                    | What it does                                                      |
|-------------------------|-------------------------------------------------------------------|
| `list_task_lists`       | List all your task lists                                          |
| `create_task_list`      | Create a new task list                                            |
| `delete_task_list`      | Delete a task list and everything in it                           |
| `list_tasks`            | List tasks (optionally including completed, filtered by due date) |
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

Three one-time steps, then you're set:

1. **Create a Google OAuth client** so the server can talk to your Google account (~5 minutes).
2. **Run the server** on the same machine as your MCP client.
3. **Connect your client** and use any tool — your browser opens once for Google consent.

### 1. Create a Google OAuth client (one-time)

You'll need Node.js ≥ 18, a Google account, and a Google Cloud OAuth client:

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and create a project (or reuse one).
2. Enable the Tasks API: **APIs & Services → Library → Google Tasks API → Enable** (direct link: <https://console.cloud.google.com/apis/library/tasks.googleapis.com>).
3. Configure the consent screen: **APIs & Services → OAuth consent screen**
   - Google's setup wizard walks you through **App Information → Audience → Contact Information → Finish**. Fill in the app name and your email under *App Information*, and choose **External** on the *Audience* step (this is the old "User type" setting).
   - After finishing the wizard, add yourself as a **test user**: **OAuth consent screen → Audience → Test users → Add**.
4. Create credentials: **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3789/oauth/google/callback`
     (adjust the port if you change `PORT`/`BASE_URL`)
5. Copy the **Client ID** and **Client secret**.

> **Note on "Testing" publishing status:** while your OAuth consent screen is in *Testing* mode, Google expires refresh tokens after 7 days — you'll be sent through the consent screen again weekly. To avoid that, publish the app (**OAuth consent screen → Audience → Publish app**); for a personal-use app with only the Tasks scope this requires no verification review.

### 2. Run the server

```bash
cp .env.example .env   # then paste your client ID and secret
make run               # installs, builds, and starts the server
```

The server listens on `http://localhost:3789` by default (MCP endpoint:
`http://localhost:3789/mcp`).

Other Make targets / npm scripts:

| Make target    | Equivalent                     | Purpose                                                        |
|----------------|--------------------------------|----------------------------------------------------------------|
| `make build`   | `npm install && npm run build` | Compile TypeScript to `dist/`                                  |
| `make test`    | `npm test`                     | Run the offline test suite (OAuth endpoints, auth gate, tools) |
| `make run`     | `npm start` (after build)      | Start the server                                               |
| `make restart` | build + `launchctl kickstart`  | Rebuild and restart the background service (macOS)             |

### 3. Connect a client

**Claude Code** — either the CLI:

```bash
claude mcp add --transport http google-tasks http://localhost:3789/mcp
```

or add it to a project's `.mcp.json` (or the `mcpServers` section of `~/.claude.json` for all projects):

```json
{
  "mcpServers": {
    "google-tasks": {
      "type": "http",
      "url": "http://localhost:3789/mcp"
    }
  }
}
```

**Claude Desktop** — Settings → Connectors → *Add custom connector* with URL `http://localhost:3789/mcp`. On versions without custom connectors, bridge via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-tasks": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3789/mcp"]
    }
  }
}
```

Then use any tool (e.g. ask Claude to list your tasks) — your browser opens for the one-time Google consent.

Any other MCP client that supports Streamable HTTP + the MCP authorization spec works the same way.

## Run in the background (autostart)

To keep the server running across reboots and logins, register it with your OS
service manager. Run the server on the **same machine as your MCP client** so it's
reachable at `localhost` — for most people that's their desktop, not a remote box.

### macOS (launchd)

A ready-made LaunchAgent is in [`launchd/com.rotheric.g-tasks-mcp.plist`](launchd/com.rotheric.g-tasks-mcp.plist). Before installing, edit two things in it:

- **`ProgramArguments`** → set the first `<string>` to the output of `which node`
  (Homebrew on Apple Silicon is `/opt/homebrew/bin/node`; nvm users have a
  version-specific path).
- **`WorkingDirectory`** → your checkout path (already set if you cloned to the
  path shown).

Then:

```bash
make build                                    # ensure dist/ is compiled
cp launchd/com.rotheric.g-tasks-mcp.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.rotheric.g-tasks-mcp.plist
```

`RunAtLoad` starts it now and at every login; `KeepAlive` relaunches it if it
crashes. Manage it:

| Command                                                                            | Purpose                         |
|------------------------------------------------------------------------------------|---------------------------------|
| `launchctl list \| grep g-tasks-mcp`                                               | Check it's loaded (0 = running) |
| `make restart` (or `launchctl kickstart -k gui/$(id -u)/com.rotheric.g-tasks-mcp`) | Restart (e.g. after a rebuild)  |
| `launchctl unload ~/Library/LaunchAgents/com.rotheric.g-tasks-mcp.plist`           | Stop and disable                |
| `tail -f ~/Library/Logs/g-tasks-mcp.log`                                           | Follow live logs                |
| `tail -f ~/Library/Logs/g-tasks-mcp.error.log`                                     | Errors only                     |

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
|-------------------------------------------|--------------------------------|
| `systemctl --user status g-tasks-mcp`     | Check it's running             |
| `systemctl --user restart g-tasks-mcp`    | Restart (e.g. after a rebuild) |
| `journalctl --user -u g-tasks-mcp -f`     | Follow live logs               |
| `journalctl --user -u g-tasks-mcp -p err` | Errors only                    |

Logs go to the systemd journal — persisted and rotated automatically, no log files to manage. The service restarts on failure (`Restart=on-failure`). After a `make build`, run `systemctl --user restart g-tasks-mcp` to pick up the new code.

## How sign-in works

Authentication implements the **MCP Authorization specification** with Google as the upstream identity provider. The sign-in flow is native to your MCP client — no copying URLs, no pasting tokens:

1. You add the server to your MCP client and use any tool.
2. The client receives a 401, discovers this server's OAuth endpoints, registers itself, and opens your browser.
3. This server redirects you straight to Google's consent screen. You approve once.
4. Google redirects back here; the server stores your tokens (locally, `0600` permissions) and hands the client its own access token.
5. Done. Tokens refresh silently; you won't see the consent screen again unless you revoke access.

## Storage & security

- Google tokens, issued MCP tokens, and registered clients are stored under `~/.g-tasks-mcp/` (override with `DATA_DIR`), files created with `0600` permissions.
- This is a **single-user** server: every connected MCP client operates on the one connected Google account. Don't expose the port beyond localhost.
- To disconnect the Google account, delete `~/.g-tasks-mcp/google-tokens.json` (and optionally revoke access at <https://myaccount.google.com/permissions>). The next client request triggers a fresh consent flow automatically.

## Configuration

| Variable               | Default                  | Purpose                                              |
|------------------------|--------------------------|------------------------------------------------------|
| `GOOGLE_CLIENT_ID`     | — (required)             | OAuth client ID from Google Cloud                    |
| `GOOGLE_CLIENT_SECRET` | — (required)             | OAuth client secret                                  |
| `PORT`                 | `3789`                   | HTTP port                                            |
| `BASE_URL`             | `http://localhost:$PORT` | Public base URL (must match the Google redirect URI) |
| `DATA_DIR`             | `~/.g-tasks-mcp`         | Token/client storage directory                       |

## License

[MIT](LICENSE) © rotheric GmbH
