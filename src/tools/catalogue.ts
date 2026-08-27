/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and in read-only mode the write tools are
 * never registered at all. Deriving the catalogue from what actually reached
 * `registerTool` would make `WOODPECKER_ALLOW_TOOLS=delete_repository` report
 * "unknown tool" under `WOODPECKER_READ_ONLY=true`, which is the one answer
 * that is wrong.
 *
 * This is also the full tool surface, hard-coded on purpose: a tool that appears
 * or disappears by accident is a change to the server's contract and has to be a
 * deliberate edit here. `test/tool-filter.test.ts` asserts that these lists and
 * the tools the server really registers are the same set, so the duplication
 * cannot drift — and the test file keeps no second copy of the names.
 *
 * The order below is the order of `src/tools/*.ts`, and it is roughly the order
 * of how often a tool gets used: repositories and pipelines first, instance
 * administration last.
 */

/**
 * Registered always. Every one carries `readOnlyHint: true`.
 *
 * "Read" here means "changes nothing on the server". Several of these still
 * need an instance administrator — `list_users`, the agent tools, the forge
 * tools and `get_log_level` are admin-only, and Woodpecker answers a normal
 * account with 403.
 */
export const READ_TOOLS = [
  // Repositories
  'list_repositories',
  'get_repository',
  'lookup_repository',
  'get_repository_permissions',
  'list_repository_branches',
  'list_pull_requests',
  // Pipelines
  'list_pipelines',
  'get_pipeline',
  'get_pipeline_config',
  'get_pipeline_metadata',
  'list_queued_pipelines',
  // Logs
  'get_step_logs',
  // Secrets
  'list_secrets',
  'get_secret',
  // Registries
  'list_registries',
  'get_registry',
  // Cron jobs
  'list_crons',
  'get_cron',
  // Organizations
  'list_organizations',
  'get_organization',
  'lookup_organization',
  'get_organization_permissions',
  // The authenticated account
  'get_current_user',
  'get_pipeline_feed',
  // Users (admin)
  'list_users',
  'get_user',
  // Agents (admin)
  'list_agents',
  'get_agent',
  'list_agent_tasks',
  // Forges (admin)
  'list_forges',
  'get_forge',
  // Server and queue
  'get_server_info',
  'get_queue_info',
  'get_log_level',
] as const;

/** Registered unless `WOODPECKER_READ_ONLY` is set. */
export const WRITE_TOOLS = [
  // Repositories
  'activate_repository',
  'update_repository',
  'repair_repository',
  'move_repository',
  'chown_repository',
  'delete_repository',
  // Pipelines
  'trigger_pipeline',
  'restart_pipeline',
  'cancel_pipeline',
  'approve_pipeline',
  'decline_pipeline',
  'delete_pipeline',
  // Logs
  'delete_step_logs',
  'delete_pipeline_logs',
  // Secrets
  'create_secret',
  'update_secret',
  'delete_secret',
  // Registries
  'create_registry',
  'update_registry',
  'delete_registry',
  // Cron jobs
  'create_cron',
  'update_cron',
  'run_cron',
  'delete_cron',
  // Organizations
  'delete_organization',
  // Users (admin)
  'create_user',
  'update_user',
  'delete_user',
  // Agents (admin)
  'create_agent',
  'update_agent',
  'delete_agent',
  // Forges (admin)
  'create_forge',
  'update_forge',
  'delete_forge',
  // Server and queue
  'pause_queue',
  'resume_queue',
  'set_log_level',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * What `WOODPECKER_ALLOW_TOOLS=essential` selects.
 *
 * The loop people actually come to a CI server for: find the repository, see
 * what its pipelines did, read why one failed, and run it again. Everything
 * else — secrets, crons, registries, the whole administrative half — is a task
 * you go looking for, and `WOODPECKER_ALLOW_TOOLS` names those explicitly.
 *
 * `cancel_pipeline` is in and `delete_pipeline` is out on purpose: cancelling
 * is how you stop a runaway build and it costs nothing but a re-run, while a
 * deleted pipeline takes its logs with it. `trigger_pipeline` is in because a
 * server that can only look at builds is half a tool.
 *
 * `test/tool-filter.test.ts` checks every name here exists and that the list is
 * within 5..8.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'list_repositories',
  'get_repository',
  'list_pipelines',
  'get_pipeline',
  'get_step_logs',
  'trigger_pipeline',
  'restart_pipeline',
  'cancel_pipeline',
];
