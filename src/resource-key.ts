import { createHash } from 'node:crypto';

// The confirmation key itself is not built here. Every guarded tool binds to an
// ordered tuple of interchangeable-looking small integers — `approve_pipeline`
// to `(repo_id, number)`, `delete_step_logs` to `(repo_id, number, step_id)` —
// so a key that sorted its targets would let a confirmation for pipeline 12 of
// repository 5 authorise pipeline 5 of repository 12. That key comes from
// `orderedResourceKey` in `mcp-approval`, which fixes each part to its position;
// see `guard.ts`. This module keeps what is specific to this server: the
// fingerprint of a body, and the rule for what may be named in a prompt.

/**
 * A stable short hash of everything a guarded call is about to write.
 *
 * The targets say *what* is touched; this says *with what*. Without it, a
 * confirmation for `update_repository(repo_id: 5, trusted_network: true)` is
 * honoured by a second call that also carries `visibility: "public"` and
 * `require_approval: "none"` — the person agreed to one sentence and a different
 * request was executed. Keys are sorted recursively so that the same body
 * written in a different order is the same fingerprint; argument *order* is
 * carried by `orderedResourceKey` in `guard.ts`, and a JSON object has none.
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
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
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
