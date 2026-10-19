import { describe, expect, it } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { validateCredentialProfileSelections } from '../lib/credential-profile-selection.js';

describe('validateCredentialProfileSelections', () => {
  it('accepts the runtime agent credential and a registry-declared model-auth source', () => {
    expect(() =>
      validateCredentialProfileSelections(resolveAgentSpec('pi'), [
        { agentId: 'pi', profileId: 'personal' },
      ]),
    ).not.toThrow();
    expect(() =>
      validateCredentialProfileSelections(resolveAgentSpec('pi'), [
        { agentId: 'codex', profileId: 'default' },
      ]),
    ).not.toThrow();
  });

  it('rejects cross-agent, agentless, duplicate, and malformed selections', () => {
    expect(() =>
      validateCredentialProfileSelections(resolveAgentSpec('claude'), [
        { agentId: 'codex', profileId: 'default' },
      ]),
    ).toThrow(/declared credential source/);
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
      validateCredentialProfileSelections(resolveAgentSpec('pi'), [
        { agentId: 'codex', profileId: '../bad' },
      ]),
    ).toThrow(/invalid identifiers/);
  });
});
