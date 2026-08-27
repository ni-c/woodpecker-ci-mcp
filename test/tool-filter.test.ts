import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';
import { ToolFilterError } from '../src/tool-filter.js';
import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '../src/tools/catalogue.js';
import { stubFetch, testConfig } from './harness.js';

/** The tools a server built with this configuration actually offers. */
async function toolNames(overrides: Partial<Config> = {}): Promise<string[]> {
  stubFetch();
  const server = createServer(testConfig(overrides));
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the catalogue', () => {
  // This is what lets the filter validate a name before anything is registered.
  // If it drifts from the code, every error message drifts with it.
  it('is exactly the set of tools the server registers', async () => {
    expect(await toolNames()).toEqual([...ALL_TOOLS].sort());
  });

  it('matches the registered set in read-only mode too', async () => {
    expect(await toolNames({ readOnly: true })).toEqual([...READ_TOOLS].sort());
  });

  it('splits into read and write with nothing left over', () => {
    expect([...READ_TOOLS, ...WRITE_TOOLS].sort()).toEqual(
      [...ALL_TOOLS].sort()
    );
    expect(
      READ_TOOLS.filter((t) => (WRITE_TOOLS as readonly string[]).includes(t))
    ).toEqual([]);
  });

  it('has no duplicate names', () => {
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it('marks every read tool as read-only to the client', async () => {
    stubFetch();
    const server = createServer(testConfig());
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const isRead = (READ_TOOLS as readonly string[]).includes(tool.name);
      expect(
        { name: tool.name, readOnly: tool.annotations?.readOnlyHint === true },
        `${tool.name} carries the wrong readOnlyHint`
      ).toEqual({ name: tool.name, readOnly: isRead });
    }
  });
});

describe('the essential preset', () => {
  it('names only tools that exist', () => {
    for (const tool of ESSENTIAL_TOOLS) {
      expect(ALL_TOOLS, `${tool} is not a tool`).toContain(tool);
    }
  });

  it('stays between five and eight tools', () => {
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
  });

  it('leaves out everything irreversible', () => {
    for (const tool of ESSENTIAL_TOOLS) {
      expect(tool.startsWith('delete_')).toBe(false);
    }
  });

  it('is what allowTools=essential selects', async () => {
    expect(await toolNames({ allowTools: 'essential' })).toEqual(
      [...ESSENTIAL_TOOLS].sort()
    );
  });
});

describe('the tool filter', () => {
  it('is inactive when neither variable is set', async () => {
    expect(await toolNames()).toHaveLength(ALL_TOOLS.length);
  });

  it('selects exact names', async () => {
    expect(
      await toolNames({ allowTools: 'get_pipeline,list_pipelines' })
    ).toEqual(['get_pipeline', 'list_pipelines']);
  });

  it('expands a trailing-star prefix', async () => {
    const names = await toolNames({ allowTools: 'list_*' });
    expect(names).toContain('list_pipelines');
    expect(names).not.toContain('get_pipeline');
  });

  it('subtracts the deny list from the allow list', async () => {
    expect(
      await toolNames({
        allowTools: 'list_*',
        denyTools: 'list_users,list_agents',
      })
    ).not.toContain('list_users');
  });

  it('denies without an allow list', async () => {
    const names = await toolNames({ denyTools: 'delete_*' });
    expect(names).not.toContain('delete_repository');
    expect(names).toContain('get_pipeline');
  });

  it('ignores empty entries and stray commas', async () => {
    expect(await toolNames({ allowTools: 'get_pipeline,,' })).toEqual([
      'get_pipeline',
    ]);
  });

  it('treats an empty value as unset rather than as "allow nothing"', async () => {
    expect(await toolNames({ allowTools: '   ' })).toHaveLength(
      ALL_TOOLS.length
    );
  });

  it('accepts an upper-cased name from a shell that mangled it', async () => {
    expect(await toolNames({ allowTools: 'GET_PIPELINE' })).toEqual([
      'get_pipeline',
    ]);
  });

  it('refuses a name no tool has', () => {
    expect(() =>
      createServer(testConfig({ allowTools: 'get_piplines' }))
    ).toThrow(ToolFilterError);
  });

  it('refuses a malformed pattern instead of matching nothing forever', () => {
    expect(() =>
      createServer(testConfig({ allowTools: '*_pipeline' }))
    ).toThrow(/trailing "\*"/);
  });

  it('refuses a selection that would leave no tools at all', () => {
    expect(() =>
      createServer(
        testConfig({ allowTools: 'get_pipeline', denyTools: 'get_pipeline' })
      )
    ).toThrow(/empty tool list/);
  });

  it('says a write tool is suppressed rather than unknown in read-only mode', () => {
    expect(() =>
      createServer(
        testConfig({ readOnly: true, allowTools: 'delete_repository' })
      )
    ).toThrow(/WOODPECKER_READ_ONLY/);
  });

  it('redacts an entry that looks like a pasted credential', () => {
    const token = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${'x'.repeat(40)}`;
    let message = '';
    try {
      createServer(testConfig({ allowTools: token }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('redacted');
    expect(message).not.toContain(token);
  });

  it('still quotes the longest real tool name in full', () => {
    // get_organization_permissions is 28 characters; a shorter cap would redact it.
    let message = '';
    try {
      createServer(testConfig({ allowTools: 'get_organization_permission' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('"get_organization_permission"');
  });
});
