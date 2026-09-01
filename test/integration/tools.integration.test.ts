import {
  expectEveryToolExercised,
  startServer,
  toolCoverage,
  tokenOf,
  type LiveHarness,
} from 'mcp-integration-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_TOOLS } from '../../src/tools/catalogue.js';
import {
  bootstrap,
  createOrganization,
  createRepository,
  USERNAME,
  type Sandbox,
} from './bootstrap.js';

/**
 * Every tool in the catalogue, against a real Woodpecker in Docker.
 *
 * The stack is four containers because Woodpecker cannot be fewer: it has no
 * accounts of its own and authenticates against a forge, and it cannot run
 * anything without an agent. Both halves matter here — the repository the
 * suite activates is a real Gitea repository, and the pipeline it triggers is
 * really executed by an agent, which is the only way `get_step_logs` can have
 * anything to return.
 *
 * Order matters and state is shared throughout.
 */

let sandbox: Sandbox;
/** Declares elicitation, so guarded tools go through the real dialog. */
let asking: LiveHarness;
/** Declares none, so the same tools fall back to the two-call token. */
let plain: LiveHarness;

let repoId: number;
let pipelineNumber: number;
let stepId: number;
let cronId: number;

/** A pipeline the agent can actually run, with nothing to fetch but alpine. */
const PIPELINE = `steps:
  - name: greet
    image: alpine:3.20
    commands:
      - echo "integration"
`;

const ORGANIZATION = 'integration-org';

function parse<T>(text: string): T {
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error(`no JSON in result: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}

beforeAll(async () => {
  sandbox = await bootstrap();
  asking = await startServer({ env: sandbox.env, elicit: 'accept' });
  plain = await startServer({ env: sandbox.env });
}, 900_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
});

describe('the server and the account', () => {
  it('reports its version and who the token belongs to', async () => {
    expect(await asking.call('get_server_info')).toContain('3.');
    expect(await asking.call('get_current_user')).toContain(USERNAME);
  });

  it('reports the queue, which is idle', async () => {
    await asking.call('get_queue_info');
    await asking.call('list_queued_pipelines');
  });

  it('lists the forge it authenticates against', async () => {
    const forges = parse<{ forges: { id: number; type: string }[] }>(
      await asking.call('list_forges')
    );
    expect(forges.forges.length).toBeGreaterThan(0);
    await asking.call('get_forge', { forge_id: forges.forges[0]!.id });
  });

  it('lists the agent that is connected', async () => {
    const agents = parse<{ agents: { id: number }[] }>(
      await asking.call('list_agents')
    );
    // The compose stack runs one, and it registers itself with the shared
    // secret — so a stub could not have produced this.
    expect(agents.agents.length).toBeGreaterThan(0);
    await asking.call('get_agent', { agent_id: agents.agents[0]!.id });
    await asking.call('list_agent_tasks', { agent_id: agents.agents[0]!.id });
  });

  it('lists the accounts it knows', async () => {
    expect(await asking.call('list_users')).toContain(USERNAME);
    // `forge_id` is required: a login is only unique per forge, and on a
    // single-forge instance it is 1.
    await asking.call('get_user', { login: USERNAME, forge_id: 1 });
    await asking.call('list_organizations');
  });

  it('reads and sets the log level', async () => {
    expect(await asking.call('get_log_level')).toContain('level');
    await asking.call('set_log_level', { level: 'debug' });
    await asking.call('set_log_level', { level: 'info' });
  });
});

describe('a repository through its whole life', () => {
  it('activates one the forge has', async () => {
    await createRepository('integration', PIPELINE);

    // Woodpecker only knows what the forge tells it, so the repository has to
    // be listed before it can be activated — and it is inactive until then.
    const available = parse<{
      repositories: { forge_remote_id: string; full_name: string }[];
    }>(
      // The **account** scope, not the instance one: `/api/repos` lists only
      // what Woodpecker already builds, so a repository that has never been
      // activated is invisible there. `include_inactive` refreshes the
      // account's repositories from the forge, and that answer is the only
      // place a forge_remote_id comes from.
      await asking.call('list_repositories', { include_inactive: true })
    );
    const found = available.repositories.find((r) =>
      r.full_name.endsWith('/integration')
    );
    expect(found).toBeDefined();

    const activated = parse<{ id: number }>(
      await asking.call('activate_repository', {
        forge_remote_id: found!.forge_remote_id,
      })
    );
    repoId = activated.id;

    expect(await asking.call('list_repositories')).toContain('integration');
    // Now that one is active, the instance scope has something to show.
    expect(
      await asking.call('list_repositories', { scope: 'instance' })
    ).toContain('integration');
    await asking.call('get_repository', { repo_id: repoId });
    await asking.call('get_repository_permissions', { repo_id: repoId });
    await asking.call('lookup_repository', {
      full_name: `${USERNAME}/integration`,
    });
    await asking.call('list_repository_branches', { repo_id: repoId });
    await asking.call('list_pull_requests', { repo_id: repoId });
  });

  it('changes its settings', async () => {
    await asking.call('update_repository', {
      repo_id: repoId,
      timeout: 30,
      visibility: 'private',
    });
    expect(await asking.call('get_repository', { repo_id: repoId })).toContain(
      'private'
    );
    await asking.call('repair_repository', { repo_id: repoId });
    // Already ours, so nothing changes — but the call is the only way to prove
    // the guard and the route work together.
    await asking.call('chown_repository', { repo_id: repoId });
  });
});

describe('secrets, registries and crons', () => {
  it('keeps a secret, and never gives its value back', async () => {
    await asking.call('create_secret', {
      scope: 'repository',
      repo_id: repoId,
      name: 'integration_secret',
      value: 'the-value-must-not-come-back',
      events: ['push'],
    });
    const listed = await asking.call('list_secrets', {
      scope: 'repository',
      repo_id: repoId,
    });
    expect(listed).toContain('integration_secret');
    // Woodpecker never returns a secret's value, and neither must this.
    expect(listed).not.toContain('the-value-must-not-come-back');

    const one = await asking.call('get_secret', {
      scope: 'repository',
      repo_id: repoId,
      name: 'integration_secret',
    });
    expect(one).not.toContain('the-value-must-not-come-back');

    await asking.call('update_secret', {
      scope: 'repository',
      repo_id: repoId,
      name: 'integration_secret',
      value: 'also-must-not-come-back',
      events: ['push', 'tag'],
    });
  });

  it('keeps a registry credential the same way', async () => {
    await asking.call('create_registry', {
      scope: 'repository',
      repo_id: repoId,
      address: 'registry.example.net',
      username: 'integration',
      password: 'the-password-must-not-come-back',
    });
    const listed = await asking.call('list_registries', {
      scope: 'repository',
      repo_id: repoId,
    });
    expect(listed).toContain('registry.example.net');
    expect(listed).not.toContain('the-password-must-not-come-back');

    await asking.call('get_registry', {
      scope: 'repository',
      repo_id: repoId,
      address: 'registry.example.net',
    });
    await asking.call('update_registry', {
      scope: 'repository',
      repo_id: repoId,
      address: 'registry.example.net',
      username: 'integration',
      password: 'still-must-not-come-back',
    });
  });

  it('schedules a cron and runs it early', async () => {
    const cron = parse<{ cron: { id: number } }>(
      await asking.call('create_cron', {
        repo_id: repoId,
        name: 'integration-cron',
        schedule: '@daily',
        branch: 'main',
      })
    );
    cronId = cron.cron.id;

    expect(await asking.call('list_crons', { repo_id: repoId })).toContain(
      'integration-cron'
    );
    await asking.call('get_cron', { repo_id: repoId, cron_id: cronId });
    await asking.call('update_cron', {
      repo_id: repoId,
      cron_id: cronId,
      schedule: '@weekly',
    });

    // Starts the schedule's pipeline now. The run carries event "cron", which
    // is the whole reason the tool exists — waiting a day to find out that a
    // nightly job is broken is the alternative.
    const run = parse<{ pipeline: { number: number } }>(
      await asking.call('run_cron', { repo_id: repoId, cron_id: cronId })
    );
    expect(run.pipeline.number).toBeGreaterThan(0);
  });
});

describe('a pipeline the agent really runs', () => {
  it('triggers one', async () => {
    const triggered = parse<{ pipeline: { number: number } }>(
      await asking.call('trigger_pipeline', {
        repo_id: repoId,
        branch: 'main',
      })
    );
    pipelineNumber = triggered.pipeline.number;
    expect(pipelineNumber).toBeGreaterThan(0);

    expect(await asking.call('list_pipelines', { repo_id: repoId })).toContain(
      String(pipelineNumber)
    );
    await asking.call('get_pipeline', {
      repo_id: repoId,
      number: pipelineNumber,
    });
    await asking.call('get_pipeline_config', {
      repo_id: repoId,
      number: pipelineNumber,
    });
    await asking.call('get_pipeline_metadata', {
      repo_id: repoId,
      number: pipelineNumber,
    });
    await asking.call('get_pipeline_feed');
  }, 120_000);

  it('produces logs, because a container really ran', async () => {
    // The one thing no stub can reach: a step's log exists because an agent
    // pulled an image and executed a command.
    const view = await waitForPipeline(pipelineNumber);
    expect(view.pipeline.status).toBe('success');
    // The step the repository's own pipeline declares, not the clone step
    // Woodpecker puts in front of it.
    const step = view.workflows[0]?.steps.find((s) => s.name === 'greet');
    expect(step).toBeDefined();
    stepId = step!.id;

    const logs = await asking.call('get_step_logs', {
      repo_id: repoId,
      number: pipelineNumber,
      step_id: stepId,
    });
    expect(logs).toContain('integration');
  }, 420_000);

  it('cancels a run that the paused queue is holding', async () => {
    // Pausing first makes this deterministic. Cancelling a pipeline that has
    // already finished is an error, and this one finishes in a second or two —
    // so the queue is stopped, the restart sits in it, and the cancel has
    // something to cancel.
    await asking.call('pause_queue');
    const restarted = parse<{ pipeline: { number: number } }>(
      await asking.call('restart_pipeline', {
        repo_id: repoId,
        number: pipelineNumber,
      })
    );
    await asking.call('cancel_pipeline', {
      repo_id: repoId,
      number: restarted.pipeline.number,
    });
    await asking.call('resume_queue');
  }, 120_000);
});

describe('the approval gate', () => {
  it('is switched on and off, even though nothing here can trip it', async () => {
    // The setting itself is exercised. What cannot be reached from this stack
    // is a pipeline that actually waits — see the skip map at the end for why.
    await asking.call('update_repository', {
      repo_id: repoId,
      require_approval: 'all_events',
    });
    const triggered = parse<{ pipeline: { number: number } }>(
      await asking.call('trigger_pipeline', { repo_id: repoId, branch: 'main' })
    );
    expect(await statusOf(triggered.pipeline.number)).not.toBe('blocked');

    await asking.call('update_repository', {
      repo_id: repoId,
      require_approval: 'forks',
    });
  }, 120_000);
});

describe('the instance-wide administration', () => {
  it('registers an agent, drains it and removes it', async () => {
    const { agent } = parse<{ agent: { id: number; token: string } }>(
      await asking.call('create_agent', { name: 'integration-agent' })
    );
    // The token is the result: Woodpecker shows it here and nowhere else.
    expect(agent.token).toBeTruthy();

    // ...and every read redacts it, which is the point of the tool's warning —
    // the API hands the token back on every read, this server does not.
    const read = await asking.call('get_agent', { agent_id: agent.id });
    expect(read).not.toContain(agent.token);
    expect(await asking.call('list_agents')).not.toContain(agent.token);

    await asking.call('update_agent', {
      agent_id: agent.id,
      no_schedule: true,
    });
    await asking.call('delete_agent', { agent_id: agent.id });
  });

  it('pre-creates an account, changes it and removes it', async () => {
    await asking.call('create_user', { login: 'preseeded' });
    await asking.call('update_user', {
      login: 'preseeded',
      forge_id: 1,
      email: 'preseeded@example.net',
    });
    await asking.call('delete_user', { login: 'preseeded', forge_id: 1 });
    expect(await asking.call('list_users')).not.toContain('preseeded');
  });

  it('adds a second forge, changes it and removes it', async () => {
    const { forge } = parse<{ forge: { id: number } }>(
      await asking.call('create_forge', {
        type: 'gitea',
        url: 'http://gitea:3000',
        client: 'second-forge',
        oauth_client_secret: 'second-forge-not-a-secret',
      })
    );
    // Nobody signs in through it, so this is a configuration row — but the
    // secret must not come back out of one, and that is worth asserting.
    expect(
      await asking.call('get_forge', { forge_id: forge.id })
    ).not.toContain('second-forge-not-a-secret');

    await asking.call('update_forge', {
      forge_id: forge.id,
      skip_verify: true,
    });
    await asking.call('delete_forge', { forge_id: forge.id });
  });
});

describe('an organization, which only the forge can create', () => {
  it('learns of it through a repository, then forgets it again', async () => {
    await createOrganization(ORGANIZATION);
    await createRepository('org-repo', PIPELINE, ORGANIZATION);

    const available = parse<{
      repositories: { forge_remote_id: string; full_name: string }[];
    }>(await asking.call('list_repositories', { include_inactive: true }));
    const found = available.repositories.find(
      (r) => r.full_name === `${ORGANIZATION}/org-repo`
    );
    expect(found).toBeDefined();

    // Woodpecker records the organization when it first sees a repository that
    // belongs to one. There is no tool that creates it, which is why this
    // detour exists.
    const orgRepo = parse<{ id: number }>(
      await asking.call('activate_repository', {
        forge_remote_id: found!.forge_remote_id,
      })
    );

    const org = parse<{ id: number }>(
      await asking.call('lookup_organization', { name: ORGANIZATION })
    );
    await asking.call('get_organization', { org_id: org.id });
    await asking.call('get_organization_permissions', { org_id: org.id });

    await asking.call('delete_repository', { repo_id: orgRepo.id });
    await asking.call('delete_organization', { org_id: org.id });
  }, 120_000);
});

describe('a move, in the only shape this endpoint accepts', () => {
  it('repoints the repository at another location in the forge', async () => {
    // Three things about `POST /repos/{id}/move`, all found here and none of
    // them documented upstream:
    //
    //  - **It moves the repository and then answers HTTP 500.** Reproduced on
    //    3.11 with a freshly activated public repository and an instance
    //    administrator: the handler does the move, then writes a permission
    //    record that has no repository attached, and fails on that with
    //    "could not determine repo for permission". The move has happened.
    //  - The target has to exist in the forge *now*, so a rename cannot be
    //    followed with this call — after a rename the old location is gone and
    //    the new one is a different repository.
    //  - It is rarely needed anyway: Gitea's webhook reports a rename and
    //    Woodpecker follows it by itself. Calling this afterwards fails with
    //    "UNIQUE constraint failed: redirections.repo_full_name", because the
    //    redirection it wants to write is already there.
    //
    // So the target here is a second real repository, and the call is expected
    // to report an error.
    await createRepository('integration-moved', PIPELINE);
    await asking.call(
      'move_repository',
      { repo_id: repoId, to: `${USERNAME}/integration-moved` },
      { expectError: true }
    );
    // ...and it moved anyway. That is the finding: the error is raised after
    // the work is done, so a caller that retries moves a repository twice.
    expect(await asking.call('get_repository', { repo_id: repoId })).toContain(
      'integration-moved'
    );
  }, 60_000);
});

interface PipelineView {
  pipeline: { status: string };
  workflows: { steps: { id: number; name: string }[] }[];
}

/** Waits for a pipeline to finish, or says what it was doing when it gave up. */
async function waitForPipeline(number: number): Promise<PipelineView> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const view = parse<PipelineView>(
      await asking.call('get_pipeline', { repo_id: repoId, number })
    );
    if (
      ['success', 'failure', 'error', 'killed'].includes(view.pipeline.status)
    ) {
      return view;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `pipeline ${number} was still "${view.pipeline.status}" after five ` +
          'minutes. The agent runs steps as containers on the host daemon; ' +
          '`docker compose logs agent` says whether it picked the work up.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function statusOf(number: number): Promise<string> {
  return parse<PipelineView>(
    await asking.call('get_pipeline', { repo_id: repoId, number })
  ).pipeline.status;
}

describe('the fallback path for a client with no dialog', () => {
  it('deletes a secret only after the token comes back', async () => {
    const refusal = await plain.call('delete_secret', {
      scope: 'repository',
      repo_id: repoId,
      name: 'integration_secret',
    });
    expect(refusal).toContain('confirm_token');
    expect(plain.prompts).toHaveLength(0);

    await plain.call('delete_secret', {
      scope: 'repository',
      repo_id: repoId,
      name: 'integration_secret',
      confirm_token: tokenOf(refusal),
    });
    expect(
      await plain.call('list_secrets', {
        scope: 'repository',
        repo_id: repoId,
      })
    ).not.toContain('integration_secret');
  });

  it('asked a person on one harness and nobody on the other', () => {
    expect(asking.prompts.length).toBeGreaterThan(0);
    expect(plain.prompts).toHaveLength(0);
  });
});

describe('cleaning up', () => {
  it('deletes what it made', async () => {
    await asking.call('delete_registry', {
      scope: 'repository',
      repo_id: repoId,
      address: 'registry.example.net',
    });
    await asking.call('delete_cron', { repo_id: repoId, cron_id: cronId });
    // The narrow one first: a single step's output, which is what you reach for
    // when one step printed a secret.
    await asking.call('delete_step_logs', {
      repo_id: repoId,
      number: pipelineNumber,
      step_id: stepId,
    });
    await asking.call('delete_pipeline_logs', {
      repo_id: repoId,
      number: pipelineNumber,
    });
    await asking.call('delete_pipeline', {
      repo_id: repoId,
      number: pipelineNumber,
    });
    await asking.call('delete_repository', { repo_id: repoId });
  }, 120_000);
});

it('exercises every tool in the catalogue', () => {
  const called = new Set([...asking.called, ...plain.called]);
  const skipped = {
    approve_pipeline:
      'needs a pipeline in status "blocked", and this stack cannot produce ' +
      'one. Verified against 3.11: with require_approval="all_events" set on ' +
      'the repository, a pipeline triggered by the instance administrator ' +
      'still starts as "pending". The account that could be blocked is one ' +
      'without that exemption, and there is only one account here — Woodpecker ' +
      'has no accounts of its own, so a second one means a second forge user ' +
      'and a second OAuth flow, which would test the bootstrap rather than the ' +
      'tool.',
    decline_pipeline:
      'the other half of approve_pipeline, and blocked for the same reason: ' +
      'nothing in this stack reaches status "blocked".',
  };
  const report = toolCoverage({ called }, ALL_TOOLS, skipped);
  console.log(
    `woodpecker-ci-mcp: ${report.called.length}/${ALL_TOOLS.length} tools against a real Woodpecker, ` +
      `${report.skipped.length} excused`
  );
  console.log(`  not called: ${report.missing.join(', ') || '—'}`);
  expectEveryToolExercised({ called }, ALL_TOOLS, skipped);
});
