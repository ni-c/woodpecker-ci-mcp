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

### Added

- The twenty tools that need a confirmation now **ask the user**, on clients that
  can show a prompt. The two-call `confirm_token` remains for clients that
  cannot, so nothing that works today stops working — but where a person can be
  asked, one is, instead of a token that only proves the same call was made
  twice.

### Changed

- The confirmation prompt is a **plain result rather than an error**. Asking a
  question is not a failure, and the rest of the family answers it this way.

- A `confirm_token` that does not match its arguments is **refused with the
  reason** in the same words as every other server in the family. The binding is
  unchanged: a token issued for one repository still cannot authorise the
  whole-instance variant of `repair_repository`.

- Runs on **MCP SDK 2.0**. Existing clients see the same protocol revision they
  always did; the change is the package layout behind it, and it is what lets
  the dialog above work on both protocol eras from one code path — including
  behind a stateless gateway, where the older mechanism silently fell back to
  the weaker token for every client.

- The linter is **oxlint** instead of eslint plus typescript-eslint, which lifts
  the TypeScript ceiling: typescript-eslint pins `typescript` below 6.1, so this
  repository was held on TypeScript 6 by its linter rather than by its code.

- The tool filter, the confirmation store, the host classifier and the
  documentation-asset generator now come from **`mcp-tool-allowlist`**,
  **`mcp-approval`**, **`mcp-internal-hosts`** and **`svg-asset-set`** rather
  than from copies kept here — 916 fewer lines, and one place to fix each. None
  of them has a runtime dependency of its own.

### Fixed

- Confirmation tokens are compared with a **constant-time** comparison, in the
  library's implementation rather than in the copy kept here.

## [0.1.0] - 2026-08-29

First public release.

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

[0.1.0]: https://github.com/ni-c/woodpecker-ci-mcp/releases/tag/v0.1.0

<!-- #endregion changelog -->
