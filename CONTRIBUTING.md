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
A throwaway `woodpecker-server` plus one agent and a local forge is half an hour
of docker-compose and saves explaining why the queue was paused.

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, build and the suite on Node 22 and 24, plus npm audit, CodeQL and a Trivy scan of the container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, confirmation tokens, anything that
  builds a request URL): please describe the attack you are defending against, or the
  one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both eslint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/woodpecker-ci-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/woodpecker-ci-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/woodpecker-ci-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
