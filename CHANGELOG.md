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
  the model's context, and logs are capped separately and far lower. Single
  objects are budgeted too, by shortening the longest text anywhere in the tree
  and then dropping entries from the longest list, so an oversized answer comes
  back smaller rather than not at all.
- **Twenty operations are two-step**, not fifteen. `approve_pipeline` joined them
  outright — a blocked pipeline is usually one from a fork, approving it runs
  that fork's code with the repository's secrets, and the model deciding whether
  to approve is typically holding a build log written by whoever opened the pull
  request. Four more are two-step only in the direction that escalates:
  `update_user` granting `admin`, `update_repository` granting a `trusted_*`
  flag, `update_secret` overwriting a value that cannot be recovered, and
  `set_log_level` silencing the server. The reverse of each, and every other
  field, still applies on the first call.
- **Credential-shaped fields are scrubbed from every pass-through result**, not
  just the agent token that is known to leak today. Which fields Woodpecker's Go
  models serialize is not this server's decision, and a forge addon or a reverse
  proxy can reshape a body; a field named `password`, `client_secret`,
  `private_key` or `token` is now redacted wherever it appears. `create_agent` is
  the one deliberate exception.
- **Build output is stripped of terminal control sequences.** A step's stdout is
  whatever its container wrote — ANSI colour, cursor movement, progress bars that
  rewrite their own line, and sometimes raw binary. None of it survives as
  meaning in a JSON result, all of it costs budget, and the escape sequences are
  a rendering vector in whatever terminal displays the answer.
- The invariant that no attacker-controlled prose reaches a confirmation prompt
  is now enforced where the interpolation happens, rather than resting on three
  input-schema regexes two files away.
- Repository-controlled text carries the untrusted-content marker in every result
  that returns it, including the pipeline echoed back by `trigger_pipeline`,
  `restart_pipeline`, `approve_pipeline`, `decline_pipeline` and `run_cron`, the
  instance-wide pipeline queue, and forge branch names.
- The fatal-error handler prints the message and stack rather than the error
  object, whose `cause` chain can carry the failed request's headers.

<!-- #endregion changelog -->
