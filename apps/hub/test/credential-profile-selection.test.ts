import { describe, expect, it } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { validateCredentialProfileSelections } from '../lib/credential-profile-selection.js';

describe('validateCredentialProfileSelections', () => {
  it('accepts a registry-declared profile source', () => {
    expect(() =>
      validateCredentialProfileSelections(resolveAgentSpec('pi'), [{ agentId: 'codex', profileId: 'default' }]),
    ).not.toThrow();
  });

  it('rejects cross-agent, agentless, duplicate, and malformed selections', () => {
    expect(() =>
      validateCredentialProfileSelections(resolveAgentSpec('claude'), [{ agentId: 'codex', profileId: 'default' }]),
    ).toThrow(/declared model-auth source/);
    expect(() =>
      validateCredentialProfileSelections(undefined, [{ agentId: 'codex', profileId: 'default' }]),
    ).toThrow(/runtime agent/);
    expect(() =>
      validateCredentialProfileSelections(resolveAgentSpec('pi'), [
        { agentId: 'codex', profileId: 'one' },
        { agentId: 'codex', profileId: 'two' },
      ]),
    ).toThrow(/one profile/);
    expect(() =>
      validateCredentialProfileSelections(resolveAgentSpec('pi'), [{ agentId: 'codex', profileId: '../bad' }]),
    ).toThrow(/invalid identifiers/);
  });
});
