# Environment variables

| Variable                  | Required | Default | Description                                                              |
| ------------------------- | -------- | ------- | ------------------------------------------------------------------------ |
| `WOODPECKER_URL`          | yes      | —       | Server root, e.g. `https://woodpecker.example.com`. A trailing `/api` is trimmed |
| `WOODPECKER_TOKEN`        | yes      | —       | Personal access token from User settings → CLI and API                   |
| `WOODPECKER_READ_ONLY`    | no       | `false` | `true` registers only the 34 read tools                                  |
| `WOODPECKER_ALLOW_TOOLS`  | no       | —       | Tool names, `list_*` prefixes or `essential`; only these register         |
| `WOODPECKER_DENY_TOOLS`   | no       | —       | Same syntax; subtracted from whatever the allow list left                |
| `WOODPECKER_INSECURE_TLS` | no       | `false` | `true` accepts self-signed certificates, scoped to this connection       |

Booleans are the exact string `true`; anything else, including `1` and `TRUE`, is
false. That is deliberate — a variable that means "on" for four spellings and
"off" for a fifth is worse than one with a single spelling.

## `WOODPECKER_URL`

The URL you open in a browser. Not `.../api`, though that suffix is trimmed
rather than refused, because the Swagger page spells every example the long way.

Refused outright, with an exit rather than a warning:

- a URL that is not `http:` or `https:`
- a URL containing credentials (`https://user:pass@host`) — those end up in logs
- a URL that does not parse

The value is never echoed back in the error. A token pasted into the wrong
variable is a mistake people make, and printing it into the client's log would
be the second one.

Plain `http:` to a non-local host is allowed but warns: the token then travels
unencrypted.

## `WOODPECKER_TOKEN`

Read once at start-up and then deleted from `process.env`, so a child process or
a crash report cannot pick it up.

Woodpecker has no token scopes — the token carries the full authority of its
account. `get_current_user` reports which account that is.

Without it the server still starts and lists its tools, so registries and sandbox
inspectors can introspect it. Every call except `get_server_info` then fails with
setup instructions instead of reaching the API.

## `WOODPECKER_ALLOW_TOOLS` and `WOODPECKER_DENY_TOOLS`

Comma-separated tool names, a prefix with one trailing `*`, or `essential`. Allow
decides what is in; deny is subtracted from it. An entry matching no tool aborts
start-up rather than being ignored.

See [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load)
for what that buys and how it fails.

## `WOODPECKER_INSECURE_TLS`

Accepts a self-signed certificate for this server's connection only, through a
dedicated undici dispatcher. `NODE_TLS_REJECT_UNAUTHORIZED` is never set, so
nothing else in the process loses certificate validation.

Prefer an internal CA your machine trusts.
