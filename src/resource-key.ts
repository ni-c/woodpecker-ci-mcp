import { createHash } from 'node:crypto';

/**
 * Binds a confirmation to an ordered tuple of targets.
 *
 * `setResourceKey` from `mcp-approval` hashes `[...targets].sort()`, which is
 * right for what its name says — a *set* — and wrong for almost every tool here.
 * This server's targets are positional tuples of interchangeable-looking small
 * integers: `approve_pipeline` takes `(repo_id, number)`, `delete_step_logs`
 * takes `(repo_id, number, step_id)`. Sorted, `["5","12"]` and `["12","5"]` are
 * the same key, so a person who read "approve blocked pipeline 12 of repository
 * 5 … runs that fork's code with this repository's secrets" would be authorising
 * pipeline 5 of repository 12 as well — a different fork, and secrets of a
 * repository nobody mentioned. On a real instance both numbers are small and
 * close together, so the swap is not even implausible.
 *
 * Preserving the order is a caller-side fix on purpose. `mcp-approval` is shared
 * with the rest of the fleet and does exactly what it promises; a server whose
 * targets are ordered says so here rather than making the library configurable.
 * The call sites label their targets as well (`repo:5`, `pipeline:12`), so the
 * binding survives even if a key ever goes back through a sorting helper.
 */
export function tupleResourceKey(
  operation: string,
  targets: readonly string[]
): string {
  return `${operation}:${createHash('sha256')
    .update(JSON.stringify(targets))
    .digest('hex')
    .slice(0, 16)}`;
}

/**
 * A stable short hash of everything a guarded call is about to write.
 *
 * The targets say *what* is touched; this says *with what*. Without it, a
 * confirmation for `update_repository(repo_id: 5, trusted_network: true)` is
 * honoured by a second call that also carries `visibility: "public"` and
 * `require_approval: "none"` — the person agreed to one sentence and a different
 * request was executed. Keys are sorted recursively so that the same body
 * written in a different order is the same fingerprint; argument *order* is
 * carried by {@link tupleResourceKey}, and a JSON object has none.
 */
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(canonical(value))
    .digest('hex')
    .slice(0, 16);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Guards a value that is interpolated into a confirmation a model reads.
 *
 * Deliberately kept here rather than taken from `mcp-approval`: this is not part
 * of the confirmation mechanism but of this server's own reading of its API.
 * Three tools name their target in the confirmation text — a secret name, a
 * login, a registry address. They are safe today because their input schemas are
 * narrow, which is an invariant held two files away from the string it protects.
 * This is that invariant, enforced where the interpolation happens: whitespace
 * or a quote means the value is not an identifier, and a confirmation a model
 * reads is the wrong place to find that out gently.
 */
export function identifier(value: string, role: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f"'`]/.test(value)) {
    throw new Error(
      `woodpecker-ci-mcp: refusing to name a ${role} containing whitespace or quotes in a confirmation prompt`
    );
  }
  return value;
}
