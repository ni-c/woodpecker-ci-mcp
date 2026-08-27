# Getting started

## Requirements

- Node.js ≥ 22
- A Woodpecker server you can reach, and an account on it

## Get a token

In Woodpecker: your avatar → **User settings** → **CLI and API**. The page shows
your personal access token.

There are no scopes and no read-only variant: **the token is your account**. If
that account is an instance administrator, the token can do everything an
administrator can — every repository, every secret, every agent. Two things
follow from that:

- Use `WOODPECKER_READ_ONLY=true` unless you actually want this server to change
  things.
- Prefer a normal account over an admin one. The admin-only tools will answer 403
  and everything else works.

## Configure it

```sh
export WOODPECKER_URL=https://woodpecker.example.com
export WOODPECKER_TOKEN=...
```

`WOODPECKER_URL` is the **server root**, the URL you open in a browser — not
`.../api`. Both spellings are accepted (the suffix is trimmed), because the
Swagger page spells every example the long way.

## Run it

```sh
npx -y @ni-c/woodpecker-ci-mcp
```

It speaks MCP over stdio, so on its own it will just sit there. See
[connecting clients](/guide/clients) for wiring it into Claude Code, Claude
Desktop or Codex, or try it directly:

```sh
npx @modelcontextprotocol/inspector npx -y @ni-c/woodpecker-ci-mcp
```

## Check that it works

Call `get_server_info` first. It needs no token, so it separates the two things
that can be wrong:

- **It answers with a version** → `WOODPECKER_URL` is right. If other tools then
  fail with 401, the token is the problem.
- **It fails saying Woodpecker answered with HTML** → the URL reaches a web page
  rather than the API. That is what a wrong host, a proxy or an SSO portal in
  front of the instance looks like, because Woodpecker serves its UI from the
  same origin and answers unrouted paths with the single-page app — with HTTP
  200, not a 404.

Then `get_current_user`, which tells you which account the token belongs to and
whether it is an administrator.

## Find a repository

Everything else takes a numeric `repo_id`, and nothing in the web UI shows it.
Two ways to get one:

```
lookup_repository(full_name: "acme/widgets")
list_repositories()
```

A repository that plainly exists in your forge but answers 404 here has simply
never been activated in Woodpecker. `list_repositories(include_inactive: true)`
lists those too, and `activate_repository` turns one on.
