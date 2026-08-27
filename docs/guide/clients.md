# Connecting clients

## Claude Code

```sh
claude mcp add woodpecker-ci \
  -e WOODPECKER_URL=https://woodpecker.example.com \
  -e WOODPECKER_TOKEN=... \
  -- npx -y @ni-c/woodpecker-ci-mcp
```

Add `-e WOODPECKER_ALLOW_TOOLS=essential` to start with the curated eight rather
than all 71 — see [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

## Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "woodpecker-ci": {
      "command": "npx",
      "args": ["-y", "@ni-c/woodpecker-ci-mcp"],
      "env": {
        "WOODPECKER_URL": "https://woodpecker.example.com",
        "WOODPECKER_TOKEN": "…"
      }
    }
  }
}
```

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.woodpecker-ci]
command = "npx"
args = ["-y", "@ni-c/woodpecker-ci-mcp"]
env = { WOODPECKER_URL = "https://woodpecker.example.com", WOODPECKER_TOKEN = "…" }
```

## MCP Inspector

The quickest way to see the tool list and try a call by hand:

```sh
WOODPECKER_URL=https://woodpecker.example.com \
WOODPECKER_TOKEN=... \
npx @modelcontextprotocol/inspector npx -y @ni-c/woodpecker-ci-mcp
```

The Inspector reads the environment of the process it is started from, so export
the variables first or put them on the same line.

## Docker

```sh
docker run --rm -i \
  -e WOODPECKER_URL=https://woodpecker.example.com \
  -e WOODPECKER_TOKEN=… \
  ghcr.io/ni-c/woodpecker-ci-mcp
```

The image is multi-arch (amd64 and arm64), runs as an unprivileged user, and
carries an SBOM and build provenance.

**If your Woodpecker is internal, add `--dns`.** A container does not inherit the
host's resolver configuration, so a name your workstation resolves through split
DNS or a VPN-provided resolver is looked up against whatever is in the container's
`/etc/resolv.conf` instead. The usual symptom is not an error: the public DNS
answer resolves to an address that simply never replies, and every call times out
while the instance is perfectly healthy. Check it with
`docker run --rm alpine getent hosts woodpecker.example.com`, and pass
`--dns <your resolver>` if the answer is wrong.

## Through mcp-hub

[mcp-hub](https://mcp-hub.ni-c.de) runs several stdio MCP servers behind one
Streamable-HTTP endpoint, which is how you reach this one from a client that
cannot spawn a local process.

```json
{
  "mcpServers": {
    "woodpecker-ci": {
      "command": "npx",
      "args": ["-y", "@ni-c/woodpecker-ci-mcp"],
      "env": {
        "WOODPECKER_URL": "https://woodpecker.example.com",
        "WOODPECKER_TOKEN": "…"
      }
    }
  }
}
```

The hub's own `allowTools` / `denyTools` in `mcp.json` and this server's
`WOODPECKER_ALLOW_TOOLS` / `WOODPECKER_DENY_TOOLS` are different mechanisms, and
with 71 tools the difference matters. The hub filters what it *re-exports* to the
client; the server's own variables decide what is *built* in the first place. So
`"allowTools": ["essential"]` in `mcp.json` does nothing — `essential` is this
server's preset, not a tool name, and the hub is matching literal names. Put
`WOODPECKER_ALLOW_TOOLS=essential` in the `env` block instead, where it reaches
the process that understands it, and use the hub's lists for names you want the
hub to hide on top of that.

Reaching the hub's `/hub` endpoint instead replaces every server's tools with six
meta-tools, which is the other way to keep 71 tools out of a client's context.
