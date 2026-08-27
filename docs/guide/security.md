# Security

## What the token can do

A Woodpecker personal access token has no scopes. It is the account: every
repository that account can see, and — if it is an administrator — every secret,
every agent and the server's own configuration. There is no read-only token to
hand out instead, which is why `WOODPECKER_READ_ONLY=true` exists on this side.

## Agent tokens are redacted

`GET /api/agents` returns each agent's token in clear text, on every read,
including the list call. Verified against Woodpecker 3.18.0.

That token is not a label. It is what a machine presents to register itself as a
build agent, after which the server hands it pipeline workloads — and every
secret those pipelines inject. An unfiltered `list_agents` on a ten-agent
instance would put ten of those into a model's context at once.

So `list_agents`, `get_agent` and `update_agent` replace the field with a marker
saying it was redacted, rather than dropping it — an absent field reads as "this
agent has no token", which is never true.

`create_agent` is the exception. There the token *is* the result, it is shown
once, and the tool's own output says what it is and how to treat it.

## What Woodpecker itself never returns

Two things this server does not have to hide, because the API strips them first —
useful to know, because it means there is no tool that can read them back:

- **Secret values.** `model.Secret.Copy()` drops the value, and every handler
  answers with a copy. Not even the response to creating a secret contains it.
- **Registry passwords.** `model.Registry.Copy()` does the same.
- **The OAuth client secret of a forge** is declared `json:"-"` and is never
  serialised at all.

Store a secret's value somewhere else when you set it. This server cannot give it
back to you, and neither can the web UI.

## Irreversible operations are two-step

Fifteen tools take a confirmation token: every `delete_*`, plus
`move_repository`, the whole-instance `repair_repository`, `update_forge` and
`pause_queue`.

The first call performs nothing. It returns a random, single-use token with a
five-minute lifetime, bound to a fingerprint of the exact arguments, together
with a sentence describing what the second call will do and what that costs.

That binding is the part that matters. A token issued for repository 21 does not
delete repository 99; a token issued to change a forge's URL does not authorise
changing its client secret; a token for one tool is not a token for another.
A plain `confirm: true` parameter would give none of that — and a model can set a
boolean on its own, including one it was talked into by text it read somewhere.

`pause_queue` is in that list for a different reason from the rest. It is
reversible, but it is instance-wide and silent: nothing tells the people whose
builds are queuing why nothing is starting.

## Untrusted content

Everything this server returns was written by someone who can push a commit:
branch names, commit messages, pipeline titles, and above all the build logs,
which are the raw stdout of arbitrary containers.

Those results carry an explicit marker telling the model to treat them as data
rather than instructions. Confirmation prompts never quote anything that came
from the API — only server-side facts like a numeric id — so a repository cannot
name itself into a confirmation dialogue.

## Budgets

- Every response body has a byte ceiling enforced *while it streams*, not after
  it is buffered, and `content-length` is checked before the first byte is read.
- List results drop whole entries rather than truncating the JSON, and say how
  many went and how to narrow the request. A half-serialised document is not a
  smaller answer.
- Build logs have a much smaller budget of their own and are cut at a line
  boundary, never mid-character.
- Upstream error bodies are truncated, and HTML error pages — a proxy's, a WAF's
  — are dropped rather than pasted into the context.

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/ni-c/woodpecker-ci-mcp/security/advisories/new).
Please do not include real tokens, hostnames or configuration in a report.
