# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/woodpecker-ci-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

A Woodpecker personal access token carries **the full authority of the account it
belongs to**. There are no scopes and no read-only tokens: the token is the account.
For a normal user that means every repository they can see in the forge; for an
instance administrator it means every repository, every secret, every agent and the
server's own configuration. `get_current_user` reports which of the two you have
configured, and `WOODPECKER_READ_ONLY=true` is how you keep this server to the read
half of it.

Three things are worth naming explicitly, because none of them is obvious from the
API:

- **The API returns agent tokens in clear text.** `GET /agents` includes a `token`
  field for every agent, and that token is enough to register a machine as a build
  agent — which then receives pipeline workloads and every secret injected into
  them. This server redacts it on read. `create_agent` is the one exception; there
  the token is the result, and the tool says what it is.
- **Approving a pipeline runs someone else's code with your secrets.** Woodpecker
  blocks pipelines from forks for exactly that reason, and `approve_pipeline`
  releases one. Read what you are approving.
- **Build logs are attacker-influenced text.** They are the stdout of arbitrary
  containers, written by whoever can push a commit. This server marks them as
  untrusted content, and confirmation prompts never quote anything that came from
  the API.

What the token does **not** let this server do is hand itself out: `POST /user/token`
and `DELETE /user/token` are deliberately not exposed as tools — see "Not exposed, on
purpose" in the README — so a model driving this server cannot read out or rotate the
credential it is running on.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a system whose data you would not put in a model's context.

Twenty-two operations that cannot be undone **ask a person** through MCP
elicitation: a dialog raised by the server and shown by the client, which the model
cannot answer on its behalf, and which nothing proceeds without. Where the client
cannot show one they fall back to a server-generated token bound to the exact
arguments, which proves the call was made twice with the same arguments and nothing
more; the fallback text says so. `ELICITATION=false` moves a capable client onto it
deliberately — it does not remove the guard, and the server prints one line at
startup saying it is off.
