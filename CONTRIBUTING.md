# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/woodpecker-ci-mcp.git && cd woodpecker-ci-mcp
npm install
npm test          # no network access — every test runs against a stubbed fetch
npm run build
```

A minimal dev environment:

```sh
# Point it at a Woodpecker instance you are willing to break. A personal access
# token comes from your user settings and carries the full authority of your
# account — there are no scoped tokens — so add WOODPECKER_READ_ONLY unless you
# are working on a write tool.
export WOODPECKER_URL=https://woodpecker.example.com
export WOODPECKER_TOKEN=...
export WOODPECKER_READ_ONLY=true
npm run build && npx @modelcontextprotocol/inspector node dist/index.js
```

Please do not develop write tools against an instance that builds anything real.
The throwaway stack below is one command, and it saves explaining why the queue
was paused.

## Running the integration suite

The unit tests replace `fetch`, so they check that this server speaks the
Woodpecker API the way its author understood it. Only a real Woodpecker can
disagree. The integration suite spawns the built server over stdio against one
in Docker and calls **69 of the 71 tools in the catalogue**, reading results
back through Woodpecker's own API rather than trusting the reply.

```sh
npm run build     # the suite runs dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration
docker compose -f test/integration/compose.yml down -v
```

`down -v` is not optional between runs: the suite activates a repository at a
fixed name and the forge keeps it, so a second run against the same stack fails
in the forge rather than in the server.

The stack is four containers, because Woodpecker cannot be fewer. It has no
accounts of its own — it authenticates against a **forge**, so there is a Gitea,
and a one-shot container that creates the OAuth application in it before the
server starts. And it cannot run anything without an **agent**, which matters
here: the pipeline the suite triggers is really executed, which is the only way
`get_step_logs` can have anything to return. That agent runs pipeline steps as
containers on the host's Docker daemon — the one place this stack reaches
outside itself, and the reason to run it on a workstation or a CI runner and
nowhere else.

The two tools it cannot reach are `approve_pipeline` and `decline_pipeline`,
with the reason written out in the skip map at the end of
`test/integration/tools.integration.test.ts`: nothing in a single-account stack
produces a pipeline in status `blocked`.

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, build and the suite on Node 22 and 24, plus the integration
  suite against a real Woodpecker in Docker, npm audit, CodeQL and a Trivy scan
  of the container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, confirmation tokens, anything that
  builds a request URL): please describe the attack you are defending against, or the
  one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/woodpecker-ci-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/woodpecker-ci-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/woodpecker-ci-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
