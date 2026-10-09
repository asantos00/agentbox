import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncTransport } from '@agentbox/core';
import { FsCustodyStore } from '../src/custody/fs-store.js';
import { CredentialProfileStore } from '../src/custody/profiles.js';
import { ProfileStageError, stageCredentialProfile } from '../src/profile-stage.js';

describe('stageCredentialProfile', () => {
  let root: string;
  let profiles: CredentialProfileStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-stage-'));
    profiles = new CredentialProfileStore(new FsCustodyStore({ root }));
    await profiles.update({ agentId: 'codex', profileId: 'personal' }, Buffer.from('fixture-personal'));
    await profiles.update({ agentId: 'codex', profileId: 'work' }, Buffer.from('fixture-work'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('stages only the selected profile to the declared destination with private mode', async () => {
    const pushFile = vi.fn().mockResolvedValue(undefined);
    const transport = { pushFile } as unknown as SyncTransport;
    await stageCredentialProfile(profiles, transport, { agentId: 'codex', profileId: 'personal' });
    expect(pushFile).toHaveBeenCalledOnce();
    expect(pushFile.mock.calls[0]?.[1]).toBe('/home/vscode/.codex/auth.json');
    expect(pushFile.mock.calls[0]?.[2]).toEqual({ mode: 0o600 });
    expect(String(pushFile.mock.calls[0]?.[0])).not.toContain('personal');
  });

  it('refuses revocation before any box effect', async () => {
    await profiles.revoke({ agentId: 'codex', profileId: 'personal' });
    const pushFile = vi.fn();
    await expect(stageCredentialProfile(profiles, { pushFile } as unknown as SyncTransport, { agentId: 'codex', profileId: 'personal' }))
      .rejects.toMatchObject({ code: 'profile_revoked' } satisfies Partial<ProfileStageError>);
    expect(pushFile).not.toHaveBeenCalled();
  });
});
