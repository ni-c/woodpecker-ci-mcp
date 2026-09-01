# FAQ & troubleshooting

## One tool I expected is missing

Almost always the tool filter rather than a bug. Check `WOODPECKER_ALLOW_TOOLS`
and `WOODPECKER_DENY_TOOLS`, and check `WOODPECKER_READ_ONLY` — under read-only
the 37 write tools are never registered, so they are absent from `tools/list`
rather than failing when called. See
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

If neither is set, the tool may be one of the handful that deliberately do not
exist: reading or rotating this server's own access token, the forge webhook
endpoint, the pprof debug handlers, the SSE streams and the badge images. The
[introduction](/guide/) says why for each.

## Everything answers 401, but the token is right

Call `get_server_info` — it works without a token. If it answers with a version,
the URL is fine and the token really is the problem: personal access tokens are
shown once and are per instance, so a token from a different Woodpecker looks
exactly like a wrong one.

If `get_server_info` instead fails saying the answer was HTML, see the next
question.

## It says Woodpecker answered with HTML instead of JSON

`WOODPECKER_URL` is reaching a web page rather than the API. Woodpecker serves
its web UI from the same origin as its API and falls back to the single-page app
for anything it does not route — so a wrong path, a wrong host, or an SSO portal
or reverse proxy in front of the instance answers **HTTP 200 with HTML**, not a
404. That is why this is a named error rather than a JSON parse failure.

Check that the URL is the one you open in a browser, without `/api` and without a
path of its own. If it looks right and you are on a VPN or split-DNS network, see
the DNS note under [Docker](/guide/clients#docker) — a container resolving the
name against a public resolver gets an address that never answers.

## A repository I can see in my forge answers 404

Woodpecker only knows repositories that were **activated** in it. Until then it
exists in the forge and not here, and every call by id or by name is a 404.

```
list_repositories(include_inactive: true)   # lists them, with forge_remote_id
activate_repository(forge_remote_id: "…")   # turns one on
```

Note that `activate_repository` takes the **forge-side** id, not a Woodpecker
`repo_id` — there is no Woodpecker id yet — and not an `owner/name` pair.

## The log is empty, or it is the wrong end of it

`get_step_logs` returns the **last** 200 lines by default, because that is where
a failing step explains itself. Pass `from: "head"` for the beginning and `limit`
for more; the result always says which window you got and how many lines exist.

An empty result usually means the step never ran — a skipped step, or one whose
`when:` condition did not match. `get_pipeline` shows each step's state.

## A secret exists, but the pipeline does not see it

Three usual causes, in order of how often they are the answer:

1. **Events.** A secret applies only to the events it names, and the API has no
   defaults — a secret created without `pull_request` is invisible to
   pull-request builds. `get_secret` shows the list.
2. **Images.** A non-empty `images` list restricts the secret to those container
   images. An empty list means every image, which is what most people want.
3. **Scope.** Secrets exist at repository, organization and instance level, and
   `list_secrets` shows one level at a time. A name missing from the repository
   level may well exist one level up.

## My cron job runs at the wrong time, or not at all

Woodpecker takes a **five-field** cron expression — minute, hour, day of month,
month, day of week — plus the `@daily`-style descriptors and `@every 30m`. It is
not the six-field form with a leading seconds field that some Go schedulers use,
so a schedule copied from one of those is off by a field.

Also check that the job is `enabled`, and remember the pipeline runs with event
`cron`: steps restricted to `push` are skipped, which looks like a job that runs
and does nothing.

## Setting a cron timezone fails with "unknown time zone"

Not a typo. Woodpecker resolves the zone with Go's `time.LoadLocation`, which
reads the system zoneinfo database — and the official
`woodpeckerci/woodpecker-server` image is distroless and ships none. On a stock
Docker deployment every zone except `UTC` is rejected:

```
can't parse timezone: unknown time zone Europe/Berlin
```

Either leave the timezone at its default of UTC and write the schedule in UTC,
or mount a zoneinfo database into the server container
(`-v /usr/share/zoneinfo:/usr/share/zoneinfo:ro`). Verified against 3.18.0.

## Why can it not restart a pipeline I just deleted?

Deleting a pipeline takes its logs and step results with it; there is nothing
left to re-run. That is why `delete_pipeline` [asks a person](/guide/approval). If
you only want it to stop, `cancel_pipeline` is the reversible one.

## Can I use this against a Woodpecker behind SSO?

Only if the API path is reachable without the SSO redirect. Personal access
tokens authenticate against the API directly, but a proxy that intercepts every
request and returns a login page will produce the HTML error above. Exempting
`/api` from the SSO rule is the usual fix.
