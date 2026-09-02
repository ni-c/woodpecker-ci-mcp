import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';
import type { Approver, ConfirmationStore } from 'mcp-approval';

import { errorResult } from './result.js';
import { tupleResourceKey } from './resource-key.js';

/**
 * Wraps an operation that must not happen without someone agreeing to it.
 *
 * Twenty tools need this exact dance, and writing it out twenty times is how one
 * of them ends up subtly different — a resource key without the target in it,
 * say, which would let a confirmation for one repository delete another.
 *
 * Where the client can put a question in front of a person, it is asked. Where
 * it cannot, the two-call token remains: the first call returns a prompt, the
 * second quotes the token back. Both paths run through `mcp-approval`, so which
 * one applies is decided by the client's capabilities rather than by this file.
 *
 * `targets` is what the confirmation is bound to. It must contain everything
 * that decides *what* gets touched, not just the object's id: `repair_repository`
 * takes a scope as well as an id, and a token issued for one repository must not
 * authorise the whole-instance variant. Where the call also decides *with what* —
 * a body, a set of fields — the fingerprint of that body belongs in `targets`
 * too, or the second call is free to send a different one.
 *
 * Every entry carries its role as a prefix (`repo:5`, `pipeline:12`), and the key
 * is built by `tupleResourceKey` rather than the library's `setResourceKey`,
 * which sorts. Both, because these targets are ordered tuples of small integers
 * and either mistake alone lets a confirmation for one pair authorise the pair
 * read backwards — see `tupleResourceKey` for what that costs on
 * `approve_pipeline`.
 *
 * Nothing coming from the API — no name, description or commit message — may be
 * passed into `what` or `consequence`. Those strings are read by a model, and
 * this server's upstream content is written by whoever can push a commit.
 */
export async function guarded(
  server: McpServer,
  mcp: ServerContext,
  approval: Approver,
  confirmations: ConfirmationStore,
  options: {
    tool: string;
    targets: string[];
    what: string;
    consequence: string;
    confirmToken: string | undefined;
  },
  perform: () => Promise<CallToolResult>
): Promise<CallToolResult | InputRequiredResult> {
  const outcome = await approval.requestApproval(server, mcp, confirmations, {
    what: options.what,
    consequence: options.consequence,
    resourceKey: tupleResourceKey(options.tool, options.targets),
    token: options.confirmToken,
    toolName: options.tool,
    hint: 'Tick to go ahead, leave it to cancel.',
  });

  // A token that was sent and did not match is refused with the reason rather
  // than answered with a fresh prompt; the sentence is the library's, so every
  // server in the fleet refuses in the same words.
  if (outcome.decision === 'rejected') return errorResult(outcome.reason);
  if (outcome.decision === 'declined') {
    return errorResult(`The user declined. ${options.tool} did nothing.`);
  }
  if (outcome.decision === 'pending') return outcome.result;

  return perform();
}
