# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

Nothing is released yet — this section becomes `## [0.1.0]` when the first tag is
pushed.

### Added

- MCP server for the [Woodpecker CI](https://woodpecker-ci.org) API, verified
  against Woodpecker 3.18.0.
- 71 tools covering the whole API: repositories, pipelines, build logs, secrets,
  registries, cron jobs, organizations, users, agents, forges, and the server
  queue and log level.
- `get_step_logs` decodes what the API actually returns — an array of
  base64-encoded chunks — reassembles it in line order, reports the step's exit
  code, and returns the end of the log by default, because that is where a
  failing step explains itself.
- Secrets and registries exist at repository, organization and instance level in
  Woodpecker; here that is a `scope` parameter on five tools each rather than
  fifteen tool names.
- `WOODPECKER_ALLOW_TOOLS` / `WOODPECKER_DENY_TOOLS` narrow the tool list by name
  or `list_*` prefix, and `essential` selects the eight tools that cover finding
  a repository, reading its pipelines and logs, and running one again.
- `WOODPECKER_READ_ONLY=true` registers only the 34 read tools; the 37 write
  tools never reach the client's tool list.
- Fifteen operations that cannot be undone — every `delete_*`, plus
  `move_repository`, the whole-instance `repair_repository`, `update_forge` and
  `pause_queue` — are two-step: the first call returns a short-lived
  confirmation token bound to those exact arguments.

### Security

- **Agent tokens are redacted on read.** The Woodpecker API returns each agent's
  token in clear text from `GET /agents`, including the list call, and that token
  is enough to attach a machine to the server and receive pipeline workloads with
  their secrets. `list_agents`, `get_agent` and `update_agent` replace it;
  `create_agent` still returns it, because that is the only way to get it, and
  says what it is.
- Build logs, commit messages and pipeline metadata are marked as untrusted
  content — all of it is written by whoever can push to the repository.
- The access token is deleted from the environment after start-up, never sent to
  a redirect target, and never echoed into an error message.
- Results are budgeted: list results drop whole entries rather than overflowing
  the model's context, and logs are capped separately and far lower.

<!-- #endregion changelog -->
