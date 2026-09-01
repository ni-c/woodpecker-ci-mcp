import type { McpServer } from '@modelcontextprotocol/server';

import type { WoodpeckerApi } from '../api.js';
import type { Approver, ConfirmationStore } from 'mcp-approval';

/**
 * What every tool module gets.
 *
 * `readOnly` is passed in rather than checked by the caller, because the
 * modules are organised by *subject* — repositories, pipelines, secrets — not
 * by whether a tool writes. Woodpecker's surface is large enough that a
 * `read.ts`/`write.ts` split would put `list_secrets` and `create_secret` in
 * different files and hundreds of lines apart, and the two only make sense
 * together: they share a scope parameter, a path builder and the same three
 * levels of indirection.
 */
export interface ToolContext {
  api: WoodpeckerApi;
  confirmations: ConfirmationStore;
  approval: Approver;
  readOnly: boolean;
}

export type Registrar = (server: McpServer, context: ToolContext) => void;
