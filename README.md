# woodpecker-ci-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/woodpecker-ci-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/woodpecker-ci-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@ni-c/woodpecker-ci-mcp)](https://www.npmjs.com/package/@ni-c/woodpecker-ci-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@ni-c/woodpecker-ci-mcp)](https://www.npmjs.com/package/@ni-c/woodpecker-ci-mcp)
[![node](https://img.shields.io/node/v/@ni-c/woodpecker-ci-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@ni-c/woodpecker-ci-mcp)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Fwoodpecker--ci--mcp-blue)](https://github.com/ni-c/woodpecker-ci-mcp/pkgs/container/woodpecker-ci-mcp)
[![docs](https://img.shields.io/badge/docs-woodpecker--ci--mcp.ni--c.de-informational)](https://woodpecker-ci-mcp.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[Woodpecker CI](https://woodpecker-ci.org), the lightweight container-native CI
engine — it runs your pipelines, and this reads and drives them.

Lets MCP clients like Claude Code, Claude Desktop or Codex see which pipelines
failed, read the build log of the step that broke, and act on it — restart it,
cancel a runaway, approve a blocked one, rotate a secret, fix a cron — with the
irreversible operations behind a confirmation token and the write tools
switchable off entirely.

71 tools is the ceiling, not the floor: `WOODPECKER_ALLOW_TOOLS=essential`
registers a curated eight instead, and a model picks the right tool far more
reliably from eight than from 71 — see
[choosing which tools load](#choosing-which-tools-load).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://woodpecker-ci-mcp.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://woodpecker-ci-mcp.ni-c.de/architecture-light.svg">
  <img src="https://woodpecker-ci-mcp.ni-c.de/architecture.svg" alt="An MCP client talks to woodpecker-ci-mcp over stdio; the server calls the Woodpecker CI API over HTTPS." width="800">
</picture>

![Finding a failed pipeline, reading the failing step's log, and restarting it](https://woodpecker-ci-mcp.ni-c.de/demo.gif)

## What makes it different

**It covers the whole API, not the read half.** Repositories, pipelines, logs,
secrets, registries, crons, organizations, users, agents, forges, the queue and
the log level — 71 tools against Woodpecker 3.18.0. The point of an MCP server
for a CI system is doing something about what it tells you.

**Logs arrive as text.** Woodpecker returns a step's output as an array of
base64-encoded chunks with line numbers. `get_step_logs` decodes them, puts them
back in order, reports the step's exit code, and returns the **end** of the log
by default — a failing step explains itself in its last lines, and the first 4000
lines of `npm ci` answer nothing.

**Agent tokens do not reach the model.** `GET /agents` returns every agent's
token in clear text, and that token is enough to attach a machine to the server
and receive pipeline workloads with their secrets. Listing agents through this
server redacts it. `create_agent` still returns one — that is the only way to get
it — and says what it is.

**It knows where this API is sharp.** `/version` and `/healthz` sit outside the
`/api` prefix that the Swagger document claims for them, so `GET /api/version`
returns the web UI with HTTP 200 rather than a 404; a repository that exists in
the forge is a 404 here until it is activated; `perPage` above 50 is clamped
without a word; a cron schedule is five fields, not six; and a secret with no
event list is refused, because the defaults people expect live in the web UI, not
in the API.

## Requirements

- Node.js ≥ 22
- A **Woodpecker** personal access token — your user settings, "CLI and API".
  There are no scopes: the token carries the full authority of your account.

## Configuration

| Variable                  | Required | Description                                                                        |
| ------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `WOODPECKER_URL`          | yes      | Root URL of the server, e.g. `https://woodpecker.example.com`                      |
| `WOODPECKER_TOKEN`        | yes      | Personal access token from your user settings                                      |
| `WOODPECKER_READ_ONLY`    | no       | `true` registers only the 34 read tools                                            |
| `WOODPECKER_ALLOW_TOOLS`  | no       | Comma-separated tool names, `list_*` prefixes, or `essential` for a curated preset |
| `WOODPECKER_DENY_TOOLS`   | no       | Same syntax; removed from whatever `WOODPECKER_ALLOW_TOOLS` left                   |
| `WOODPECKER_INSECURE_TLS` | no       | `true` accepts self-signed certificates (scoped to this connection)                |

`WOODPECKER_URL` is the server root, not the API root:
`https://woodpecker.example.com`, not `https://woodpecker.example.com/api`. Both
are accepted — the suffix is trimmed — because the Swagger page spells every
example the long way.

> **Use `https://`.** Over plain http the token travels unencrypted; the server
> prints a warning unless the host is local. For self-signed certificates prefer a
> proper internal CA over `WOODPECKER_INSECURE_TLS`.

Without configuration the server still starts and lists its tools (so registries
and inspectors can introspect it); every call then fails with setup instructions
instead of reaching the API. `get_server_info` works without a token, which makes
it the first thing to call when nothing else does: if it answers,
`WOODPECKER_URL` is right and the problem is the token.

**Admin-only tools.** Woodpecker inherits repository and organization permissions
from the forge, and reserves users, agents, forges, the queue and the log level
for instance administrators. Those tools are registered for everyone and answer
403 for accounts that may not use them; `get_current_user` reports which kind of
account the token belongs to, and `WOODPECKER_DENY_TOOLS` is the tidy way to stop
offering them at all.

### Choosing which tools load

`WOODPECKER_ALLOW_TOOLS` and `WOODPECKER_DENY_TOOLS` take comma-separated tool
names; a trailing `*` matches a whole family. `essential` is a curated preset —
`list_repositories`, `get_repository`, `list_pipelines`, `get_pipeline`,
`get_step_logs`, `trigger_pipeline`, `restart_pipeline` and `cancel_pipeline` —
marked as such in the
[tool reference](https://woodpecker-ci-mcp.ni-c.de/reference/tools).

```sh
WOODPECKER_ALLOW_TOOLS=essential
WOODPECKER_ALLOW_TOOLS=list_*,get_pipeline,get_step_logs
WOODPECKER_DENY_TOOLS=delete_*,pause_queue,create_user,update_user
```

With 71 tools this is not a nicety. Every visible tool costs context on every
request, and a server that offers `delete_forge` next to `get_step_logs` is a
server nobody should point at their production CI without narrowing it first.

An entry that matches no tool aborts startup and names it, so a typo cannot
silently hide a tool — an absent tool is not something anyone traces back to an
environment variable. A filtered tool is never registered, so it is absent from
`tools/list` and unknown to `tools/call` alike, exactly like a write tool under
`WOODPECKER_READ_ONLY`.

If you run several of these servers at once, [mcp-hub](https://mcp-hub.ni-c.de)
is the other answer — its `/hub` endpoint replaces every server's tools with six
meta-tools.

## Installation

### Claude Code

```sh
claude mcp add woodpecker-ci -- npx -y @ni-c/woodpecker-ci-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "woodpecker-ci": {
      "command": "npx",
      "args": ["-y", "@ni-c/woodpecker-ci-mcp"],
      "env": {
        "WOODPECKER_URL": "https://woodpecker.example.com",
        "WOODPECKER_TOKEN": "…"
      }
    }
  }
}
```

### Codex

```toml
[mcp_servers.woodpecker-ci]
command = "npx"
args = ["-y", "@ni-c/woodpecker-ci-mcp"]
env = { WOODPECKER_URL = "https://woodpecker.example.com", WOODPECKER_TOKEN = "…" }
```

### Docker

```sh
docker run --rm -i \
  -e WOODPECKER_URL=https://woodpecker.example.com \
  -e WOODPECKER_TOKEN=… \
  ghcr.io/ni-c/woodpecker-ci-mcp
```

If your Woodpecker is only resolvable through your host's split DNS, add
`--dns <resolver>`: a container does not inherit the host's resolver
configuration, and the public answer for an internal name is usually an address
that does not respond.

## Tools

Read tools are always registered. 🛡 marks the ones that need an instance
administrator; 👤 marks the ones that ask for a confirmation token before acting.
The [tool reference](https://woodpecker-ci-mcp.ni-c.de/reference/tools) has the
parameters.

### Repositories

| Tool                         | Description                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| `list_repositories`          | Repositories, optionally including ones not yet activated          |
| `get_repository`             | One repository with all its Woodpecker settings                    |
| `lookup_repository`          | Turns `owner/name` into the id every other tool takes              |
| `get_repository_permissions` | What this account may do here — answers "why that 403"             |
| `list_repository_branches`   | Branches, as Woodpecker sees them in the forge                     |
| `list_pull_requests`         | Open pull requests and their index                                 |
| `activate_repository`        | Turns Woodpecker on for a forge repository                         |
| `update_repository` 👤       | Config file, timeout, visibility, approval mode; 👤 to grant trust |
| `repair_repository` 👤       | Re-installs the webhook; 👤 only for the whole-instance variant    |
| `move_repository` 👤         | Follows a repository that moved in the forge                       |
| `chown_repository`           | Takes ownership, so the token Woodpecker uses is yours             |
| `delete_repository` 👤       | Removes it from Woodpecker with all its history                    |

### Pipelines and logs

| Tool                    | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `list_pipelines`        | Pipelines with branch, event, status and time filters        |
| `get_pipeline`          | One pipeline with its workflows, steps and step ids          |
| `get_pipeline_config`   | The YAML this run was built from                             |
| `get_pipeline_metadata` | The `CI_*` environment a step saw, and the previous run      |
| `list_queued_pipelines` | What is waiting, across all repositories                     |
| `get_step_logs`         | A step's output as text, tail first, with its exit code      |
| `trigger_pipeline`      | Starts a pipeline on a branch                                |
| `restart_pipeline`      | Runs an existing one again, at the same commit               |
| `cancel_pipeline`       | Stops a pending or running pipeline                          |
| `approve_pipeline` 👤   | Releases a blocked one — it runs fork code with your secrets |
| `decline_pipeline`      | Refuses a blocked one                                        |
| `delete_pipeline` 👤    | Deletes a pipeline and its logs                              |
| `delete_step_logs` 👤   | Deletes one step's output — for when a step printed a secret |
| `delete_pipeline_logs`  | 👤 The same for every step of a pipeline                     |

### Secrets, registries and crons

`scope` selects the level: `repository`, `organization` or `global`.

| Tool                 | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `list_secrets`       | Secrets at one level. Values are never returned by Woodpecker |
| `get_secret`         | One secret's events, images and note                          |
| `create_secret`      | Creates one. At least one event is required                   |
| `update_secret` 👤   | Rotates the value (👤), or replaces the event and image lists |
| `delete_secret` 👤   | Deletes one; pipelines using it run without it                |
| `list_registries`    | Container registry credentials at one level                   |
| `get_registry`       | One entry. The password is stripped by Woodpecker             |
| `create_registry`    | Stores credentials for pulling private images                 |
| `update_registry`    | Changes username or password                                  |
| `delete_registry` 👤 | Removes them                                                  |
| `list_crons`         | Scheduled runs and when each fires next                       |
| `get_cron`           | One cron job                                                  |
| `create_cron`        | Schedules a run — five-field cron or `@daily`                 |
| `update_cron`        | Changes it, including `enabled` to pause without deleting     |
| `run_cron`           | Runs it now, without touching the schedule                    |
| `delete_cron` 👤     | Removes the schedule                                          |

### Accounts, organizations and instance administration

| Tool                           | Description                                                  |
| ------------------------------ | ------------------------------------------------------------ |
| `get_current_user`             | Which account the token belongs to, and whether it is admin  |
| `get_pipeline_feed`            | The latest pipeline of every visible repository, in one call |
| `list_organizations` 🛡         | Organizations known to the instance                          |
| `get_organization`             | One organization                                             |
| `lookup_organization`          | Turns a name into the id org-level tools need                |
| `get_organization_permissions` | Member and admin flags for this account                      |
| `delete_organization` 🛡👤      | Removes it with its org-level secrets, registries and agents |
| `list_users` 🛡                 | Accounts that have ever logged in                            |
| `get_user` 🛡                   | One account — `forge_id` is required                         |
| `create_user` 🛡                | Pre-creates a record, e.g. to grant admin before first login |
| `update_user` 🛡👤              | Changes email; 👤 to grant admin                             |
| `delete_user` 🛡👤              | Removes an account — transfer its repositories first         |
| `list_agents` 🛡                | Build agents, with tokens redacted                           |
| `get_agent` 🛡                  | One agent, token redacted                                    |
| `list_agent_tasks` 🛡           | What an agent is running right now                           |
| `create_agent` 🛡               | Registers one and returns its token — a credential           |
| `update_agent` 🛡               | Rename, relabel, or drain with `no_schedule`                 |
| `delete_agent` 🛡👤             | Removes it and invalidates its token                         |
| `list_forges` 🛡                | Forges this instance authenticates against                   |
| `get_forge` 🛡                  | One forge; the OAuth secret is never returned                |
| `create_forge` 🛡               | Adds a forge                                                 |
| `update_forge` 🛡👤             | Changes one — a wrong value locks everyone out               |
| `delete_forge` 🛡👤             | Removes one                                                  |
| `get_server_info`              | Version and health. Works without a token                    |
| `get_queue_info` 🛡             | The server-side queue and agent statistics                   |
| `get_log_level` 🛡              | Current server log level                                     |
| `pause_queue` 🛡👤              | Stops scheduling for the whole instance                      |
| `resume_queue` 🛡               | Starts it again                                              |
| `set_log_level` 🛡👤            | Changes it; 👤 to silence the server                         |

## Not exposed, on purpose

- **`POST`/`DELETE /user/token`.** They return and rotate the personal access
  token of the account this server authenticates as. A tool that hands the model
  its own credential is not a feature, and one that invalidates the server's own
  configuration mid-session is worse. The web UI does both, in front of a person.
- **`POST /hook`.** The forge webhook endpoint. Calling it means forging a push
  event, which is a way to run a pipeline while making it look like someone
  committed something. `trigger_pipeline` is the honest version.
- **`/debug/pprof/*`.** Nine endpoints of Go profiling data. A heap dump is not
  something to put in a model's context.
- **`/stream/events` and `/stream/logs`.** Server-sent event streams do not fit a
  request/response tool. Poll `get_pipeline` instead.
- **Badge endpoints.** They return SVG and XML for embedding, not information.

## Safety

- **Twenty operations are two-step.** Every `delete_*`, plus `move_repository`,
  the whole-instance `repair_repository`, `update_forge`, `pause_queue` and
  `approve_pipeline` — and four more only in the direction that escalates:
  `update_user` granting `admin`, `update_repository` granting a `trusted_*`
  flag, `update_secret` overwriting a value, and `set_log_level` silencing the
  server. The first call returns a short-lived confirmation token bound to those
  exact arguments; only a second call carrying it acts. A token for one
  repository is not a token for another, and a token for one tool is not a token
  for another.
- **Agent tokens are redacted on read** — see above. `create_agent` is the
  exception, by necessity.
- **Secret values and registry passwords are never returned**, and not because
  this server hides them: Woodpecker strips them from every response, including
  the one immediately after creating them. Store the value somewhere else too.
- **Build logs, commit messages and pipeline metadata are marked as untrusted
  data**, because they are written by whoever can push to the repository.
  Confirmation prompts never quote anything that came from the API.
- Error bodies are truncated, HTML error pages are dropped, and every response
  has a byte ceiling enforced while it streams. Log output has a much smaller
  budget of its own, and says when it was cut.
- `WOODPECKER_READ_ONLY=true` does not register the write tools at all, and
  `WOODPECKER_DENY_TOOLS` cuts finer along the same line — a filtered tool is
  never built, not refused at call time.
- The token is deleted from `process.env` once it has been read, is never sent to
  a redirect target, and is never echoed into an error message.

## Development

```sh
npm install
npm run lint && npm run build && npm run test:coverage
```

## Releasing

1. Add the CHANGELOG entry and bump `package.json`.
2. `npm run lint && npm run build && npm run test:coverage`
3. Commit, then push a signed tag: `git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin main vX.Y.Z`

The release workflow publishes to npm (Trusted Publishing, with provenance),
creates the GitHub release from the CHANGELOG section and updates the MCP
Registry entry.
