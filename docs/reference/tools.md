# Tools

One section per tool. All 71 are registered unless you say otherwise:
`WOODPECKER_ALLOW_TOOLS` and `WOODPECKER_DENY_TOOLS` narrow the list, and
`essential` selects the ones marked **essential** below — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

Three markers recur:

- **essential** — part of the `essential` preset.
- 🛡 **admin** — needs an instance administrator. Woodpecker answers any other
  account with 403; `get_current_user` says which you have.
- 👤 **two-step** — the first call returns a confirmation token bound to those
  exact arguments and does nothing else; a second call carrying the token acts.
  The token is single-use and expires after five minutes.

Repository ids are numeric. `lookup_repository` turns an `owner/name` pair into
one; nothing in the web UI shows it.

<!-- test/docs.test.ts asserts that the headings here are exactly ALL_TOOLS and
     that the **essential** markers are exactly ESSENTIAL_TOOLS, so this page
     cannot drift from the catalogue without a red test. -->

## Repositories

### `list_repositories`

**essential** — Repositories this account can see. `scope: "instance"` lists
every repository on the server (🛡 admin) instead. `include_inactive: true` also
lists repositories that exist in the forge but were never activated, which is
where `forge_remote_id` for `activate_repository` comes from; it is noticeably
slower, because Woodpecker refreshes them from the forge.

Parameters: `scope`, `include_inactive`, `name`, `page`, `per_page`.

### `get_repository`

**essential** — One repository with everything Woodpecker stores about it:
trusted flags, timeout, approval mode, config file path, extension endpoints.

Parameters: `repo_id`.

### `lookup_repository`

Resolves `owner/name` to a repository id. A repository that exists in the forge
but was never activated answers 404 — see `list_repositories`.

Parameters: `full_name`.

### `get_repository_permissions`

What this account may do here: pull, push, admin. Inherited from the forge, so
this is the answer to "why did that return 403".

Parameters: `repo_id`.

### `list_repository_branches`

Branches as Woodpecker sees them in the forge. Worth calling before
`trigger_pipeline`, which answers a branch that does not exist with a bare 400.

Parameters: `repo_id`, `page`, `per_page`.

### `list_pull_requests`

Open pull requests and their index — the number a ref like `refs/pull/42/head`
refers to.

Parameters: `repo_id`, `page`, `per_page`.

### `activate_repository`

Turns Woodpecker on for a forge repository: installs the webhook and lets
pipelines run. Takes the **forge-side** id, not a Woodpecker `repo_id` (there is
none yet) and not an `owner/name` pair.

Parameters: `forge_remote_id`.

### `update_repository`

👤 (when granting trust) — Changes Woodpecker's settings for a repository.
Only the fields you pass are touched. `trusted_network`, `trusted_volumes` and
`trusted_security` are folded into the nested object the API expects; all three
are admin-only and `trusted_security` lets a pipeline take over the agent host.
Setting any of them to `true` is two-step; withdrawing trust, and every other
field, applies on the first call.

Parameters: `repo_id`, `config_file`, `timeout`, `visibility`, `allow_pr`,
`allow_deploy`, `require_approval`, `cancel_previous_pipeline_events`,
`trusted_network`, `trusted_volumes`, `trusted_security`.

### `repair_repository`

👤 (instance scope only) — Re-installs the forge webhook and refreshes the stored
repository data. This is the fix for "pushes stopped starting pipelines" after a
rename or a change of Woodpecker's own URL. `scope: "instance"` does it for every
repository, calls the forge once per repository, and is two-step for that reason.

Parameters: `repo_id`, `scope`, `confirm_token`.

### `move_repository`

👤 — Points Woodpecker at a repository that moved to a different owner or name in
the forge. It does **not** move anything in the forge; do that first, then call
this so Woodpecker follows.

Parameters: `repo_id`, `to`, `confirm_token`.

### `chown_repository`

Makes this account the repository's owner in Woodpecker. The owner's forge token
is what Woodpecker uses to read the repository and report build status, so this
is the fix when the previous owner left.

Parameters: `repo_id`.

### `delete_repository`

👤 — Removes a repository from Woodpecker with its pipelines, logs, secrets,
registries and cron jobs. The forge repository is untouched.

Parameters: `repo_id`, `confirm_token`.

## Pipelines

### `list_pipelines`

**essential** — A repository's pipelines, newest first, summarised: number,
status, event, branch, author, timings, and the subject line of the commit
message. Note that `number` — not the pipeline id — is what every other pipeline
tool takes.

Parameters: `repo_id`, `branch`, `event`, `status`, `ref`, `before`, `after`,
`page`, `per_page`.

### `get_pipeline`

**essential** — One pipeline with its workflows and steps, including each step's
id, state and exit code. The step id is what `get_step_logs` needs.

Parameters: `repo_id`, `number`.

### `get_pipeline_config`

The pipeline YAML this run was built from, decoded — the config that actually
ran, not the one currently in the branch.

Parameters: `repo_id`, `number`.

### `get_pipeline_metadata`

The metadata Woodpecker exposes to the pipeline itself: the `CI_*` environment a
step sees, plus the previous pipeline of the same workflow. Useful when a step
behaves differently than its config suggests.

Parameters: `repo_id`, `number`.

### `list_queued_pipelines`

Pipelines waiting in the server queue across all repositories — what is stuck,
and behind what. `get_queue_info` adds the agent side of the same picture.

No parameters.

### `trigger_pipeline`

**essential** — Starts a pipeline on a branch, with event `manual`. It runs the
config as it is in that branch right now. A branch that does not exist is a bare
400, so check `list_repository_branches` first. `variables` is a flat string map;
a nested object is rejected by the API.

Parameters: `repo_id`, `branch`, `message`, `variables`.

### `restart_pipeline`

**essential** — Runs an existing pipeline again, at the same commit and with the
config it used then. The re-run gets a new number; the original is kept. `event`
and `deploy_to` override how the re-run is treated.

Parameters: `repo_id`, `number`, `event`, `deploy_to`.

### `cancel_pipeline`

**essential** — Stops a pending or running pipeline. Its steps are killed where
they are, so anything half-written stays half-written. It can be restarted
afterwards, which is why this one is not two-step.

Parameters: `repo_id`, `number`.

### `approve_pipeline`

👤 — Releases a pipeline waiting for approval and lets it run. Read what you
are approving: pipelines are usually blocked because they come from a fork, and
approving one runs that fork's code with this repository's secrets. Two-step for
that reason, and because the model usually arrives here holding a build log —
which is written by whoever can open the pull request being approved.

Parameters: `repo_id`, `number`, `confirm_token`.

### `decline_pipeline`

Refuses a pipeline waiting for approval. It ends as `declined` and never runs.

Parameters: `repo_id`, `number`.

### `delete_pipeline`

👤 — Removes a pipeline and everything attached to it, including its logs. A
running pipeline cannot be deleted — cancel it first.

Parameters: `repo_id`, `number`, `confirm_token`.

## Logs

### `get_step_logs`

**essential** — One step's output as text. Woodpecker returns it as an array of
base64-encoded chunks with line numbers; this decodes them, puts them back in
order and reports the step's exit code. Returns the **last** 200 lines by
default, because that is where a failing step explains itself; `from: "head"`
reads the other end. The result always says which window you got, how many lines
exist, and how to widen it.

Parameters: `repo_id`, `number`, `step_id`, `limit`, `from`.

### `delete_step_logs`

👤 — Deletes one step's stored output. The step and the pipeline stay. This is
what you reach for when a step printed a secret — and then rotate the secret,
because the log was readable until now and deleting it does not un-read it.

Parameters: `repo_id`, `number`, `step_id`, `confirm_token`.

### `delete_pipeline_logs`

👤 — The same for every step of a pipeline. The step results stay, so it still
shows which step failed — just not why.

Parameters: `repo_id`, `number`, `confirm_token`.

## Secrets

Secrets exist at three levels. `scope` selects one: `"repository"` (needs
`repo_id`), `"organization"` (needs `org_id`) or `"global"` (🛡 admin, needs
neither). A pipeline sees the repository level first, then the organization, then
global — so a name missing at one level may exist at the next.

### `list_secrets`

Secrets at one level, with their events and image restrictions. Values are never
part of the answer.

Parameters: `scope`, `repo_id`, `org_id`, `page`, `per_page`.

### `get_secret`

One secret's metadata. The value is not returned — Woodpecker strips it from
every response, including the one right after creating it.

Parameters: `scope`, `repo_id`, `org_id`, `name`.

### `create_secret`

Creates a secret. The value is write-only, so store it somewhere else too. At
least one event is required: the API has no defaults, and a secret without
`pull_request` is invisible to pull-request builds.

Parameters: `scope`, `repo_id`, `org_id`, `name`, `value`, `events`, `images`,
`note`.

### `update_secret`

👤 (when passing `value`) — Changes a secret; passing `value` rotates it,
which is two-step because the old value was never readable through the API and
is gone once it is overwritten. `events` and `images` are replaced wholesale
rather than merged, so pass the complete list.

Parameters: `scope`, `repo_id`, `org_id`, `name`, `value`, `events`, `images`,
`note`, `confirm_token`.

### `delete_secret`

👤 — Deletes a secret. The value cannot be recovered, and pipelines that read it
will run without it.

Parameters: `scope`, `repo_id`, `org_id`, `name`, `confirm_token`.

## Container registries

Same three scopes as secrets. The address is the identifier — there is no
separate name — so `docker.io` and `index.docker.io` are two entries.

### `list_registries`

Registry credentials at one level. Passwords are never returned.

Parameters: `scope`, `repo_id`, `org_id`, `page`, `per_page`.

### `get_registry`

One entry: address and username. The password is stripped by Woodpecker.

Parameters: `scope`, `repo_id`, `org_id`, `address`.

### `create_registry`

Stores credentials so pipelines can pull private images.

Parameters: `scope`, `repo_id`, `org_id`, `address`, `username`, `password`.

### `update_registry`

Changes username or password. The address cannot be changed — delete and
re-create instead.

Parameters: `scope`, `repo_id`, `org_id`, `address`, `username`, `password`.

### `delete_registry`

👤 — Removes stored credentials. Pipelines pulling private images from that
registry start failing at the pull step.

Parameters: `scope`, `repo_id`, `org_id`, `address`, `confirm_token`.

## Cron jobs

A cron schedule is a **five-field** expression (`0 4 * * *` is 04:00 daily), a
descriptor (`@daily`, `@hourly`, `@weekly`, `@monthly`, `@yearly`, `@midnight`)
or `@every 30m`. There is no seconds field — a six-field expression is refused
with "expected exactly 5 fields, found 6".

Timezone defaults to UTC, and on the official container image that is the only
value that works: it is distroless and carries no zoneinfo database, so anything
else fails with "unknown time zone". See the
[FAQ](/guide/faq#setting-a-cron-timezone-fails-with-unknown-time-zone).

### `list_crons`

A repository's scheduled runs, with the next execution time of each.

Parameters: `repo_id`, `page`, `per_page`.

### `get_cron`

One cron job, including the variables it passes.

Parameters: `repo_id`, `cron_id`.

### `create_cron`

Schedules a pipeline run. It runs with event `cron`, so steps and secrets
restricted to other events do not apply — a cron job whose steps all say
`when: event: push` runs and does nothing.

Parameters: `repo_id`, `name`, `schedule`, `branch`, `timezone`.

### `update_cron`

Changes a cron job. `enabled: false` pauses a schedule without losing it.

Parameters: `repo_id`, `cron_id`, `name`, `schedule`, `branch`, `timezone`,
`enabled`.

### `run_cron`

Runs the cron job's pipeline now, without waiting for its schedule and without
changing it. This is how you test a nightly job without waiting a night.

Parameters: `repo_id`, `cron_id`.

### `delete_cron`

👤 — Removes a schedule. Nothing will notice that the job stopped running, which
is the failure mode of every deleted scheduled task.

Parameters: `repo_id`, `cron_id`, `confirm_token`.

## Organizations

### `list_organizations`

🛡 — Organizations known to this instance. An entry with `is_user: true` is a
personal account rather than a real organization; Woodpecker models both the
same way, and org-level secrets work for both.

Parameters: `page`, `per_page`.

### `get_organization`

One organization by id.

Parameters: `org_id`.

### `lookup_organization`

Resolves an organization name to the id that org-level secrets, registries and
agents need.

Parameters: `name`.

### `get_organization_permissions`

Member and admin flags for this account in that organization.

Parameters: `org_id`.

### `delete_organization`

🛡👤 — Removes an organization with its org-level secrets, registries and agents.
The forge and the repositories are untouched, but anything of theirs that relied
on an org-level secret stops working.

Parameters: `org_id`, `confirm_token`.

## The authenticated account

### `get_current_user`

Which account `WOODPECKER_TOKEN` belongs to, and whether it is an instance
administrator. The first thing to call when a tool answers 403.

No parameters.

### `get_pipeline_feed`

The activity feed: the latest pipeline of every repository this account can see,
newest first. One request instead of `list_pipelines` per repository.

No parameters.

## Users

Woodpecker creates an account the first time someone logs in, so this is everyone
who has ever used the instance rather than a managed roster. A login is only
unique per forge, which is why `forge_id` is required where it is.

### `list_users`

🛡 — Accounts known to this instance.

Parameters: `page`, `per_page`.

### `get_user`

🛡 — One account by login. `forge_id` is required by the API; `list_users` and
`list_forges` show it, and on a single-forge instance it is 1.

Parameters: `login`, `forge_id`, `forge_remote_id`.

### `create_user`

🛡 — Registers an account ahead of its first login. This creates nothing in the
forge and grants no access there — it is how you make someone an administrator
before they first log in. A login that does not match the forge's spelling
creates a second, unused account rather than the one you meant.

Parameters: `login`, `email`, `admin`.

### `update_user`

🛡👤 (when granting admin) — Changes email or the admin flag. Granting
`admin` gives full control of the instance, including every secret of every
repository, which is why that one field is two-step. Correcting an email applies
on the first call.

Parameters: `login`, `email`, `admin`, `confirm_token`.

### `delete_user`

🛡👤 — Removes an account. Repositories it owned keep pointing at a forge token
that no longer exists, which shows up later as pipelines that stop starting —
transfer them with `chown_repository` first.

Parameters: `login`, `forge_id`, `confirm_token`.

## Agents

An agent's token is a credential: it is what a machine presents to register as a
build agent, after which it receives pipeline workloads and their secrets. The
API returns it in clear text on every read; this server redacts it everywhere
except `create_agent`. See [security](/guide/security#agent-tokens-are-redacted).

### `list_agents`

🛡 (instance-wide) — Build agents with their platform, capacity, version and last
contact — the call that answers "why is nothing being built". With `org_id` it
lists one organization's agents, which an organization admin may also do.

Parameters: `org_id`, `page`, `per_page`.

### `get_agent`

🛡 — One agent, token redacted. An agent that lost its token needs a new one,
which means `delete_agent` and `create_agent`.

Parameters: `agent_id`.

### `list_agent_tasks`

🛡 — The work an agent is running right now: what is occupying a busy agent, and
which pipeline to cancel.

Parameters: `agent_id`.

### `create_agent`

🛡 — Registers a new agent and **returns its token**, because that is the only
way to get it. Put it straight into the agent's configuration. With `org_id` the
agent only runs that organization's pipelines.

Parameters: `name`, `org_id`, `no_schedule`, `custom_labels`.

### `update_agent`

🛡 — Rename, relabel, or drain: `no_schedule: true` lets the agent finish what it
has and take nothing new, which is how you take its host down safely.

Parameters: `agent_id`, `org_id`, `name`, `no_schedule`, `custom_labels`.

### `delete_agent`

🛡👤 — Removes an agent and invalidates its token. Anything it was running is lost
and has to be restarted; drain it first.

Parameters: `agent_id`, `org_id`, `confirm_token`.

## Forges

The OAuth configuration every login and every repository read depends on. The
client secret is write-only: Woodpecker declares it `json:"-"` and never returns
it.

### `list_forges`

🛡 — Forges this instance authenticates against. The `forge_id` shown here is what
`get_user` and `delete_user` require.

Parameters: `page`, `per_page`.

### `get_forge`

🛡 — One forge configuration.

Parameters: `forge_id`.

### `create_forge`

🛡 — Registers an additional forge. The OAuth application has to exist on the
forge side first, with this Woodpecker as its callback. `url` and `oauth_host`
must be absolute http(s) URLs.

Parameters: `type`, `url`, `client`, `oauth_client_secret`, `oauth_host`,
`skip_verify`.

### `update_forge`

🛡👤 — Changes a forge configuration. Two-step because a wrong value locks
everyone out of the instance, including whoever is fixing it — the web UI is
behind the login this setting controls.

Parameters: `forge_id`, `type`, `url`, `client`, `oauth_client_secret`,
`oauth_host`, `skip_verify`, `confirm_token`.

### `delete_forge`

🛡👤 — Removes a forge. Everyone who signs in through it loses access, and its
repositories can no longer be read.

Parameters: `forge_id`, `confirm_token`.

## Server and queue

### `get_server_info`

Woodpecker's version and whether it reports itself healthy. Works **without a
token**, which makes it the call to use when nothing else does: if it answers,
`WOODPECKER_URL` is right and the problem is the token.

No parameters.

### `get_queue_info`

🛡 — The server-side build queue and the agent statistics behind it. With
`list_queued_pipelines` this is the whole answer to "why is my build not
starting".

No parameters.

### `get_log_level`

🛡 — The server's current log level.

No parameters.

### `pause_queue`

🛡👤 — Stops the server handing new work to agents. Running pipelines finish;
everything else queues. Two-step because it is instance-wide and silent — nothing
tells the people whose builds are queuing why.

Parameters: `confirm_token`.

### `resume_queue`

🛡 — Lets the server schedule again. Queued pipelines start at once, so expect a
burst.

No parameters.

### `set_log_level`

🛡👤 (when silencing) — Changes the running server's log level without a
restart. `debug` and `trace` are loud, and `trace` logs request bodies. Turning
the logs **down** — `fatal`, `panic` or `disabled` — is two-step: `disabled`
stops the server recording what happens next at all. Raising the level applies
on the first call.

Parameters: `level`, `confirm_token`.
