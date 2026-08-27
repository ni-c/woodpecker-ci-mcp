# What is woodpecker-ci-mcp?

An MCP server for [Woodpecker CI](https://woodpecker-ci.org), the lightweight,
container-native CI engine that grew out of Drone. Woodpecker runs your
pipelines; this server puts what they did — and the ability to do something
about it — inside an MCP client.

It speaks the Woodpecker API and was written against, and verified on, a
3.18.0 instance.

## Why

Because the interesting question is never "did it go red". You can see that on
the dashboard. The interesting question is the next one: *which step failed*,
*what did it print*, *was it the same last night*, *and can we just run it
again*. Answering that means the pipeline list, then one pipeline's steps, then
that step's log — three lookups a model chains in one turn and a person does by
clicking, in a UI, in another tab.

The second reason is that reading is only half of it. Every other Woodpecker MCP
server stops at the read tools, and the moment you know what broke you are back
in the web UI anyway: to restart the pipeline, to approve the one waiting on a
human, to fix the cron that fires an hour off, to rotate the secret a step just
printed into a log. Those are the tools this server has, behind confirmation
tokens where they cannot be undone.

## What it looks like

```
> Why did the last pipeline on development fail?

  list_pipelines(repo_id: 21, branch: "development", status: "failure")
  get_pipeline(repo_id: 21, number: 1014)
  get_step_logs(repo_id: 21, number: 1014, step_id: 84190)

  Step "test" exited 1. The last lines are a failing assertion in
  UserServiceTest — a NullPointerException at UserService.java:212.
  The step before it, "build", succeeded.

> Restart it.

  restart_pipeline(repo_id: 21, number: 1014)
  Restarted as pipeline 1016.
```

## What it will not do

The tool surface stops short in four places, all deliberate:

- It cannot read out or rotate **its own access token**. `POST /user/token` and
  `DELETE /user/token` exist in the API and are not tools here.
- It cannot **forge a webhook**. `POST /hook` would let a model start a pipeline
  while making it look as though somebody pushed a commit. `trigger_pipeline` is
  the honest version and is marked as a manual event.
- It does not hand over **agent tokens** on read, because the API does — see
  [security](/guide/security).
- It does not stream. Server-sent events do not fit a request/response tool, so
  there is nothing to subscribe to; poll `get_pipeline`.

## Where next

- [Getting started](/guide/getting-started) — a token and three lines of config.
- [Connecting clients](/guide/clients) — Claude Code, Claude Desktop, Codex,
  Docker, mcp-hub.
- [Configuration](/guide/configuration) — and how to cut 71 tools down to the
  ones you want.
- [Tools reference](/reference/tools) — every tool and its parameters.
