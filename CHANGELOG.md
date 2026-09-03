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

- Every tool declares an `outputSchema` and answers with `structuredContent`
  beside the text block. A client no longer has to parse prose to use a result —
  which seventeen of them made unavoidable, since they answered with a sentence.
  The sentence stays, in the text block. `get_step_logs` keeps its rendered
  header-plus-log there too, and states the exit code, the line count and the
  output as fields.

  The tools that report pushed content carry `untrusted: true` and
  `source: "woodpecker"` as fields, not only as a preamble in the text. Branch
  names, commit messages, pipeline titles and above all build logs are written
  by whoever can push, so a client that reads the structured half must not get
  them unframed. The list follows the call sites.

  Woodpecker's objects are described as open objects with the top-level keys
  this server builds — the upstream Go models change what they serialize
  between releases, and a strict shape would turn that into a failed call.

### Changed

- Eight "Nothing to update — pass …" answers are error results rather than
  plain ones. Each read like an answer while being a refusal.

- A result too large to shrink is an error rather than an envelope saying so.
  The envelope was a different shape from what the tool declares it returns,
  which the SDK refuses.

- The two-call `confirm_token` prompt is an error result. What was asked for did
  not happen, which is what `isError` says. The text is unchanged and still
  carries the token.

- `move_repository` no longer describes the HTTP 500 it answered with as the
  behaviour of the endpoint. On 3.11 it performed the move and then failed on a
  permission record with no repository attached; on 3.18 the call answers
  cleanly. The warning stays, scoped to the older instances it is true of, since
  a server points at whichever instance it was given.

### Added

- The tools that need a confirmation now **ask the user**, on clients that
  can show a prompt. The two-call `confirm_token` remains for clients that
  cannot, so nothing that works today stops working — but where a person can be
  asked, one is, instead of a token that only proves the same call was made
  twice.

- **Two more places ask**, and both were gaps the code itself pointed at.

  `create_user` takes an `admin` flag and did not ask, while `update_user` right
  beside it asks on exactly that flag — the same privilege, granted the same way,
  with a dialog in front of one of them. The description even advertised it:
  "which is how you make someone an admin before they first log in." It is now
  guarded on the same field and only that field.

  `chown_repository` transfers which forge token a repository's pipelines run
  under, so the calling account's reach over the forge becomes the repository's
  reach. `delete_user` already cited that in its own reasoning; the tool that
  performs the transfer did not ask.

- `ELICITATION` switches the dialog off — `false` sends a client that could have
  been asked down the two-call-token path instead. For a scheduled job or a test
  harness, where a dialog is the wrong shape rather than an unwanted one.

  It does **not** remove the guard: there is no setting in which a guarded call
  goes unannounced. Two deliberate rough edges come with it. The variable is
  **not prefixed**, so one `export ELICITATION=false` reaches every MCP server in
  the environment — which is why a server started with it off prints a line
  saying so, and why the fallback text names the server instead of blaming a
  client that was working fine. And a value that is neither `true` nor `false`
  **stops the server**, through the same `fail()` every other refusal in
  `config.ts` uses: it is the only variable here that defaults to _on_. It is read
  after `WOODPECKER_TOKEN` is wiped from the environment, so that exit cannot
  leave the token behind.

- A `docs/guide/approval.md` page. `test/docs.test.ts` compared the 👤 marks in
  the tool reference against the real `confirm_token` schemas and failed until the
  page named the two new tools, which is exactly what it is for.

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

- stdio is served through `serveStdio`, so the connection's era is negotiated
  on the opening exchange rather than assumed. A client that pins the
  `2026-07-28` era is served it; until now its `server/discover` probe was
  answered with "Method not found" and only `2025-11-25` was on offer. A client
  that speaks the older era sees no change — it is still pinned to one instance
  for the life of the connection, exactly as a hand-wired
  `StdioServerTransport` served it.

### Fixed

- Confirmation tokens are compared with a **constant-time** comparison, in the
  library's implementation rather than in the copy kept here.

- **`budgetedJson` could stop the server for good.** It replaced the longest
  string in a result with 200 characters plus a note saying how many were
  omitted — 230 characters, which is _longer_ than the 200-character threshold
  that made it a candidate. So the same slot was picked again, rewritten to the
  identical text, and the document measured to the identical size, for ever. Any
  result that shortening alone could not bring under budget reached that
  fixpoint: `get_queue_info` on an instance with about four hundred waiting
  tasks needed no attacker at all, and a `.woodpecker.yml` with five hundred long
  step names is a repository's own choice. Node is single-threaded, so the server
  then answered nothing — not the tool that triggered it and not any other — until
  the process was killed.

  Shortened strings are now excluded from the next round by a sentinel, as in
  `wikijs-mcp`, so the loop runs out of candidates and falls through to the pass
  that drops list entries; both passes carry a hard round limit, because a
  fixpoint must never be a hang. Shortening also happens in doubling batches
  instead of re-rendering the whole document once per string.

- **A ReDoS in the build-log cleaner.** The rule that keeps only the last state
  of a line a progress bar rewrote was `[^\n]*\r`: the star runs to the end of
  the line, finds no carriage return, and backtracks a character at a time, from
  every start position. Quadratic in the line's length — 200 000 characters took
  10.5 seconds and a megabyte over 48, with the event loop blocked throughout.
  A single four-megabyte comment line is legal YAML, and `get_pipeline_config`
  strips whatever the repository put in `.woodpecker.yml`, with no limit on how
  many files it reads. It is now one backwards scan per line.

  `get_pipeline_config` also bounds what it decodes — at most 20 files, at most
  200 000 bytes each — and `get_step_logs` applies its byte budget to each chunk
  _before_ stripping it rather than to the joined text afterwards.

- **`get_secret` and `list_secrets` did not remove a secret's value.** A comment
  in `normalize.ts` said they did, and nothing there or in `tools/secrets.ts`
  removed anything: the confidentiality of the field rested entirely on
  Woodpecker's `model.Secret.Copy()` stripping it upstream. On a healthy instance
  that is true, which is why nobody noticed. It is now this server's own control
  as well, and the comment describes what the code does.

- `WOODPECKER_READ_ONLY` is read as `1`, `yes` or `true` in any case, not only as
  the exact string `true`. `WOODPECKER_READ_ONLY=1` — what a Compose file or a
  systemd unit is most likely to say — used to leave every write tool registered
  while the operator believed the server could not write. `WOODPECKER_INSECURE_TLS`
  stays strict on purpose: a protection should fail on, a permission should not.

### Security

- **A confirmation authorised the operation nobody was asked about.** The
  resource key came from `setResourceKey`, which sorts its targets — correct for
  a set, wrong for every tool here, whose targets are ordered tuples of small
  integers that look alike. `["5","12"]` and `["12","5"]` hashed to the same key,
  and the second call's arguments were never compared with the first's. A person
  who read "approve blocked pipeline 12 of repository 5 … runs that fork's code
  with this repository's secrets" and agreed was, with the same token, able to
  approve pipeline 5 of repository 12: a different fork, and the secrets of a
  repository that was never mentioned. `delete_pipeline`, `delete_step_logs`,
  `delete_cron`, `delete_agent`, `delete_user` and `delete_secret` collided the
  same way.

  Targets now carry their role (`repo:5`, `pipeline:12`) and the key preserves
  their order. Where a call decides more than which object it touches, a
  fingerprint of the request body is part of the binding too — so a token shown
  as "grant `trusted_network`" no longer executes a second call that also carries
  `visibility: "public"`. `mcp-approval` is unchanged; a server whose targets are
  ordered says so at the call site.

- **Two ungated tools could switch the fork gate off.** `approve_pipeline` is the
  most carefully reasoned guard in this server, and `update_repository` let
  `require_approval: "none"` and `visibility: "public"` through on the first call
  (only the `trusted_*` flags were guarded), while `update_secret` let `events`
  and `images` through (only `value` was guarded). Together: a fork's pull request
  runs unapproved, reads a secret it was newly made visible to, prints it, and the
  log is world-readable — without a single prompt.

  Both now gate on _direction_, the way `set_log_level` and the `trusted_*` flags
  already did. Lowering `require_approval`, making a repository public, adding a
  `pull_request` event to a secret or emptying its `images` list asks first;
  tightening any of them, and every other field, still applies on the first call.
  Naming one of those fields costs one extra read, because "lowering" is a
  comparison with the current setting.

- **`update_registry` rotated an unrecoverable credential without asking.** Its
  own annotation states the rule — "the old password is not readable through the
  API and cannot be recovered" — `update_secret` is guarded by that exact
  sentence, and `delete_registry` beside it is two-step for the same damage.
  Passing `password` is now two-step; correcting a `username` alone still applies
  on the first call. That makes twenty-three guarded operations, not twenty-two.

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
