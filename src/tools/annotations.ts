/**
 * The annotation block every reading tool of this server carries, and the rule
 * the writing ones follow.
 *
 * Written out rather than left to the defaults, because the defaults are not
 * neutral: the specification says `destructiveHint` and `openWorldHint` both
 * default to **true**, so an omitted field is the *stronger* claim. A tool that
 * says nothing is a destructive tool in an open world.
 *
 * The line this family draws for `destructiveHint`, since the specification
 * only offers "destructive" against "additive only" and most writes are
 * neither obviously:
 *
 *   **Content that a person wrote, replaced with no way back — destructive.**
 *   **A setting, a state or a marker, changed — not destructive.**
 *
 * Woodpecker adds a case the others do not have: a tool that *runs code*.
 * `trigger_pipeline`, `restart_pipeline`, `run_cron` and `approve_pipeline`
 * start a build, and what that build does is written in the repository, not
 * here. They are marked destructive for that reason — not because Woodpecker
 * loses anything, but because this server cannot promise the pipeline does not.
 * `approve_pipeline` is the sharpest of them: it runs a fork's code with this
 * repository's secrets.
 *
 * `openWorldHint: false` throughout: this server talks to the one Woodpecker it
 * is configured for. That a pipeline it starts may reach the whole internet is
 * a property of the build, not of the tool call.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
