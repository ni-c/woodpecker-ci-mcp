# Configuration

Everything is an environment variable; there is no config file. The
[environment reference](/reference/environment) has the full table.

## The token

`WOODPECKER_TOKEN` is a personal access token from **User settings → CLI and
API**. Woodpecker has no token scopes: the token carries the full authority of
the account it belongs to, and there is no read-only variant to reach for.
`get_current_user` reports which account is configured and whether it is an
instance administrator.

The token is read once at start-up and then deleted from the process
environment, so a later crash report or a child process cannot pick it up. It is
never written to a log, never included in an error message, and never sent to a
redirect target — every request is made with `redirect: "error"`, because
following a redirect would hand the `Authorization` header to whatever host the
upstream named.

## The URL

`WOODPECKER_URL` is the server root — `https://woodpecker.example.com` — not the
API root. A trailing `/api` is trimmed rather than refused, because that is how
the Swagger page spells its examples.

A URL that contains credentials (`https://user:pass@host`) is refused outright:
it would end up in logs. A URL that is not http or https is refused too. Plain
http to a non-local host is allowed but warns, because the token then travels in
the clear.

## Read-only mode

`WOODPECKER_READ_ONLY=true` registers the 34 read tools and none of the 37 write
tools. They are not rejected at call time — they are never registered, so they do
not appear in `tools/list` and a call to one is answered with "tool not found",
exactly as if the server did not have it.

This is the switch to reach for by default. Everything that reads a pipeline,
a log, a secret's metadata or an agent's state stays available.

## Admin-only tools

Woodpecker inherits repository and organization permissions from the forge, and
reserves users, agents, forges, the queue and the log level for instance
administrators. Those tools are registered for every account and answer 403 for
one that may not use them.

If your token is not an admin token, `WOODPECKER_DENY_TOOLS` is the tidy way to
stop offering the tools that can only fail:

```sh
WOODPECKER_DENY_TOOLS=list_users,get_user,create_user,update_user,delete_user,\
list_agents,get_agent,list_agent_tasks,create_agent,update_agent,delete_agent,\
list_forges,get_forge,create_forge,update_forge,delete_forge,\
get_queue_info,get_log_level,set_log_level,pause_queue,resume_queue
```

## TLS and self-hosted instances

`WOODPECKER_INSECURE_TLS=true` accepts a self-signed certificate. It is scoped to
this server's connection through a dedicated undici dispatcher — it does not
disable certificate validation process-wide, and `NODE_TLS_REJECT_UNAUTHORIZED`
is never touched.

Prefer an internal CA your machine trusts. An MCP client typically runs on a
laptop that also talks to the public internet, and a process-wide hole is a hole
in all of it.

## Turning the approval dialog off

The twenty-three irreversible operations ask a person through MCP elicitation before
they act. `ELICITATION=false` takes them to the two-call token instead. It does not
remove the guard; there is no setting in which a guarded call goes unannounced.

The variable deliberately carries no `WOODPECKER_` prefix, which means it reaches
every MCP server in the same environment, and — unlike `WOODPECKER_READ_ONLY` — a
value it does not recognise **stops the server** rather than failing off. See
[Asking a person](/guide/approval).

## Choosing the tools that load

`WOODPECKER_ALLOW_TOOLS` decides what is registered; `WOODPECKER_DENY_TOOLS` is
subtracted from whatever is left. Both take a comma-separated list of tool names,
a prefix with a single trailing `*`, or the word `essential`.

```sh
# The curated eight: find a repository, read its pipelines and logs, run one again
WOODPECKER_ALLOW_TOOLS=essential

# Everything that reads, plus one that acts
WOODPECKER_ALLOW_TOOLS=list_*,get_*,restart_pipeline

# Everything except the ones that cannot be undone
WOODPECKER_DENY_TOOLS=delete_*,pause_queue,set_log_level
```

With 71 tools this is not decoration. Every registered tool costs context on
every request, and a model picks the right one far more reliably from eight than
from 71. `essential` is `list_repositories`, `get_repository`, `list_pipelines`,
`get_pipeline`, `get_step_logs`, `trigger_pipeline`, `restart_pipeline` and
`cancel_pipeline` — marked as **essential** in the
[tool reference](/reference/tools).

Two behaviours worth knowing:

- **An entry that matches no tool stops the server**, names the entry and lists
  the real tool names. It does not warn and carry on, because the alternative
  failure is invisible: a tool quietly missing from `tools/list`, which nobody
  traces back to an environment variable.
- **A filtered tool does not exist**, rather than existing and refusing. It is
  absent from `tools/list` and unknown to `tools/call`, which is the same thing a
  write tool under `WOODPECKER_READ_ONLY` does.

A pattern is a prefix plus exactly one trailing `*`. `list_*` is valid;
`*_pipeline` and `list_*_x` are refused, because they look plausible, match
nothing and would otherwise be silent forever.

If a pattern matches only write tools while `WOODPECKER_READ_ONLY` is set, the
server warns and continues — a pattern is a template. An exact name in that
situation is an error, because someone typed it believing it would be there.
