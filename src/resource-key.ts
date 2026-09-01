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
