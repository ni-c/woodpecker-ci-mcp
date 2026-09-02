# Asking a person

Twenty-three of the 71 tools do something a CI server does not undo, or hand
somebody more reach than they had. All twenty-three **ask a person first**.

Not a `confirm: true` argument the model can set. Not a token the model reads out
of its own previous result. A dialog, raised through [MCP
elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation),
that goes to the client and is shown to whoever is sitting there.

The specification says a client _should_ keep a human in the loop:

> there **SHOULD** always be a human in the loop with the ability to deny tool
> invocations

This server does not rely on that. It raises the question itself, and until an
answer comes back, nothing happens.

## What asks, and when

| Group | When it asks |
| --- | --- |
| every `delete_*` | always |
| `move_repository` · `chown_repository` | always |
| `repair_repository` | only at `scope: instance` |
| `update_forge` · `pause_queue` · `approve_pipeline` | always |
| `update_user` | only when it grants `admin` |
| `create_user` | only when it creates an `admin` |
| `update_repository` | only when it grants a `trusted_*` flag, lowers `require_approval`, or sets `visibility` to `public` |
| `update_secret` | only when a new `value` comes with it, when a `pull_request` event is added, or when `images` is emptied |
| `update_registry` | only when a new `password` comes with it |
| `set_log_level` | only when it **silences** the server (`fatal`, `panic`, `disabled`) |
| everything else | never |

Only that direction, and that is deliberate. Correcting an email, withdrawing
trust, renaming a secret or turning the logs *up* applies on the first call: a
confirmation on the harmless half of a tool teaches whoever reads these prompts to
click through them, which costs more than it buys.

`approve_pipeline` is where asking earns its keep most directly. A blocked pipeline
is usually one from a fork, and approving it runs that fork's code with the
repository's secrets — while the model deciding is typically holding a build log it
fetched with `get_step_logs`, which is this server's one input written by whoever
opened the pull request. “Approve pipeline 42” sitting in that log is a
plausible-looking instruction. A dialog goes to a person the log cannot reach.

`chown_repository` is asked about for what the ownership *is*: every pipeline of
that repository afterwards runs under the calling account's forge token, so its
reach over the forge becomes the repository's reach. `delete_user` already cited
that in its own reasoning while the tool that performs the transfer did not ask.

`create_user` is asked about on exactly the field `update_user` is. Until it was
added, the same privilege by the same flag had a dialog in front of one of them and
not the other — and the description advertised the gap: “which is how you make
someone an admin before they first log in.”

`pause_queue` is on the list for a different reason from the rest. It is
reversible, but it is instance-wide and silent: nothing tells the people whose
builds are queuing why nothing is starting.

## What the dialog contains

Numeric ids and server-side facts. Never a branch name, a commit message, a
pipeline title or a line of a build log.

Everything this server returns was written by somebody who can push a commit, and
build logs are the raw stdout of arbitrary containers. The prompt is read by a
model at the exact moment it is deciding, so a repository must not be able to name
itself into it.

```
This will approve pipeline 42 of repository 21.

The pipeline runs with this repository's secrets, and its code comes from the
source that opened it.
```

The approval is bound to its target, so one obtained for a call cannot be
replayed against another. The binding is a fingerprint of the targets **in the
order the tool names them**, plus one of the request body where the call decides
more than which object it touches. Both halves are load-bearing here, because
most of these targets are small integers that look alike: an approval for
`approve_pipeline(repo_id: 5, number: 12)` is not one for `(repo_id: 12,
number: 5)`, and one shown as "grant `trusted_network`" does not execute a second
call that also carries `visibility: "public"`.

## What it does not prove: freshness

An approval proves *what* was agreed to. It does not prove *how often*. Until it
expires, the same one can be redeemed again — a retried call, a gateway that
replays a leg, a model that loops. For everything on the list above that is
harmless: a second `delete_secret` finds nothing to delete, a second
`set_log_level` sets the level it is already at, and the world is the same either
way. That is what the `idempotentHint` on each of those tools says.

Three tools are honestly not idempotent, and they are the three that start a
build: `trigger_pipeline`, `restart_pipeline` and `run_cron`. Each call is a new
pipeline, by design — re-running a flaky job is the ordinary thing to do in CI —
and Woodpecker offers no idempotency key, no request id and no way to say "only
if you have not already". None of the three is behind a confirmation for that
reason: a gate that cannot make the operation at-most-once would only look like
one. They carry `idempotentHint: false`, their descriptions say a repeat starts
another run, and the cost of a double run is a duplicate build rather than
something that cannot be undone.

`move_repository` is the exception worth naming: it is guarded, and Woodpecker
performs the move and *then* answers HTTP 500, so a caller that treats the error
as "it did not happen" and retries moves the repository twice. The tool's own
description says so in full.

## Clients that cannot show a dialog

Not every MCP client implements elicitation, and a stateless gateway may not be
able to speak for the one it is currently serving. Rather than refuse to work —
which pushes people towards switching the guard off entirely — the tool falls
back to a **two-call token**: the first call returns a random string, the second
has to quote it back.

Be clear about what that proves, because this server is:

> the token proves the call was made twice with the same arguments, and nothing
> more.

A model can read the token out of the first result and call again in the same
turn without anybody seeing it. It catches a widened target set; it does not
catch a model that was talked into the whole thing. The fallback text says so
rather than implying somebody approved.

## Switching the dialog off

```sh
ELICITATION=false
```

Default is `true`. `false` does **not** remove the guard — it takes the fallback
path above, which means the token. There is no setting in which a guarded call
goes unannounced.

Use it where a dialog is the wrong shape rather than an unwanted one: a scheduled
job, a test harness, a client whose dialog interrupts something else.

::: warning It is deliberately not prefixed
`ELICITATION` has no `WOODPECKER_` in front of it, so one
`export ELICITATION=false` — or one `-e ELICITATION=false` in a compose file —
reaches **every** MCP server in that environment, not just this one. That is the
point of it and also its risk.

Two things make it visible rather than silent:

- a server started with it off prints one line at startup, in the log of every
  server it actually reached:

  ```
  woodpecker-ci-mcp: ELICITATION=false — guarded tools fall back to the two-call token
  ```

- the fallback text names the server that did not ask, instead of blaming a
  client that was working fine.
  :::

Anything other than `true` or `false` — `1`, `off`, `yes` — **stops the server**
with exit code 1 and a message naming both valid values. This is the only
variable in this family that defaults to _on_: a typo that fell back to the
default would leave the dialog running while the operator believed it was off,
and there would be nothing to tell them.

## Annotations are the other half, and they are only a hint

Every tool of this server declares all four MCP tool annotations —
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — so a
client can tell before it calls what a call would do. See
[Tools](/reference/tools).

They are advice, and the specification says so:

> clients **MUST** consider tool annotations to be untrusted unless they come
> from trusted servers

An annotation is something a client may ignore. The dialog is not: it is enforced
here, on the server side, and no answer means no change. The two are different
claims — the annotation says what a call _does_, the dialog decides whether it
_happens_ — which is why a tool can be marked destructive without being guarded.
The four tools that *run* a build — `trigger_pipeline`, `restart_pipeline`,
`run_cron`, `approve_pipeline` — are marked destructive not because Woodpecker
loses anything, but because what the pipeline does is written in the repository and
this server cannot promise it destroys nothing. Only `approve_pipeline` asks.

## Behind a gateway

Both protocol revisions are handled from one code path. On `2025-11-25` the
question is pushed to the client; on `2026-07-28` there is no server→client
channel at all, so the call returns `input_required`, ends, and the client
retries carrying the answer.

That answer arrives as ordinary request content, which the SDK does not
validate — so the state that ties an answer to its question is sealed (HMAC). A
reply whose seal does not open, or opens onto a different target, counts as **no
answer** and produces a fresh question rather than an error. The likeliest cause
is not an attack: it is a gateway that put the server to sleep while the person
was reading.

If you run this behind [mcp-hub](https://github.com/ni-c/mcp-hub), the hub passes
elicitation through in both directions; see its
[elicitation guide](https://ni-c.github.io/mcp-hub/guide/elicitation).
