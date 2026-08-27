import { z } from 'zod';

import { repoIdParam, orgIdParam } from '../schema.js';

/**
 * The three levels secrets and registries live at, and how to address them.
 *
 * Woodpecker offers each of them at repository, organization and instance
 * level, with identical request bodies and three different paths. Modelling
 * that as three tool families would be fifteen tool names for five operations,
 * so the level is a parameter — and this is where the path is derived from it,
 * once, for both families.
 */
export type Scope = 'repository' | 'organization' | 'global';

export const scopeArguments = {
  repo_id: repoIdParam
    .optional()
    .describe('Required when scope is "repository".'),
  org_id: orgIdParam
    .optional()
    .describe('Required when scope is "organization".'),
};

/**
 * Thrown when the scope and the ids do not agree.
 *
 * A repository scope without a repo_id would otherwise become `/repos/undefined/secrets`
 * and come back as a 404 that reads like the secret does not exist.
 */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

export function scopeBase(
  kind: 'secrets' | 'registries',
  scope: Scope,
  ids: { repo_id?: number | undefined; org_id?: number | undefined }
): string {
  switch (scope) {
    case 'repository':
      if (ids.repo_id === undefined) {
        throw new ScopeError(
          'scope="repository" needs repo_id. lookup_repository turns an ' +
            '"owner/name" pair into one.'
        );
      }
      return `/repos/${ids.repo_id}/${kind}`;
    case 'organization':
      if (ids.org_id === undefined) {
        throw new ScopeError(
          'scope="organization" needs org_id. lookup_organization turns a name into one.'
        );
      }
      return `/orgs/${ids.org_id}/${kind}`;
    case 'global':
      return `/${kind}`;
  }
}

/** Describes the scope in a sentence, for the confirmation prompts. */
export function scopeLabel(
  scope: Scope,
  ids: { repo_id?: number | undefined; org_id?: number | undefined }
): string {
  switch (scope) {
    case 'repository':
      return `repository ${ids.repo_id}`;
    case 'organization':
      return `organization ${ids.org_id}`;
    case 'global':
      return 'the whole instance';
  }
}

export const scopeEnum = z.enum(['repository', 'organization', 'global']);
